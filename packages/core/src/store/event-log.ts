import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { AgentExecutionEvent, AgentExecutionEventType } from "@vibefix/schemas";
import { eventId } from "../util/ids.js";
import type { RunPaths } from "./paths.js";

/** Replay result with degradation metadata (corrupt lines are never silent). */
export interface ReplayResult {
  events: AgentExecutionEvent[];
  /** Lines in the durable log that could not be parsed. */
  corruptLines: number;
}

/**
 * Append-only NDJSON event log + in-process bus. seq = line number, so a
 * reconnecting UI resyncs cheaply via GET /runs/:id/events?since=<seq>.
 *
 * Degradation is EXPLICIT: a failed append still reaches live subscribers
 * (the UI keeps working) but is counted in `persistenceFailures` and flips
 * `degraded` — the server surfaces both, because an event that never reached
 * disk cannot be reconstructed after a restart.
 */
export class EventLog {
  private readonly bus = new EventEmitter();
  private seq = 0;
  private loaded = false;
  private failedAppends = 0;

  constructor(private readonly paths: RunPaths) {
    this.bus.setMaxListeners(100);
  }

  /** Appends that were emitted live but never reached the durable log. */
  get persistenceFailures(): number {
    return this.failedAppends;
  }

  /** True once any event has been emitted without durable persistence. */
  get degraded(): boolean {
    return this.failedAppends > 0;
  }

  /** Replay for new subscribers / resync. */
  async eventsSince(sinceSeq: number): Promise<AgentExecutionEvent[]> {
    return (await this.replaySince(sinceSeq)).events;
  }

  /** Replay with corrupt-line accounting — used wherever recovery is reported. */
  async replaySince(sinceSeq: number): Promise<ReplayResult> {
    await this.ensureLoaded();
    const out: AgentExecutionEvent[] = [];
    let corruptLines = 0;
    let content: string;
    try {
      content = await fs.readFile(this.paths.eventsFile, "utf8");
    } catch {
      return { events: [], corruptLines: 0 };
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AgentExecutionEvent;
        if (parsed.seq > sinceSeq) out.push(parsed);
      } catch {
        corruptLines += 1; // corrupt line — counted, never silently skipped
      }
    }
    return { events: out, corruptLines };
  }

  async append(
    runId: string,
    type: AgentExecutionEventType,
    fields: { agentId?: string; proposalId?: string; message?: string; payload?: unknown } = {},
  ): Promise<AgentExecutionEvent> {
    await this.ensureLoaded();
    this.seq += 1;
    const event: AgentExecutionEvent = {
      eventId: eventId(),
      runId,
      ts: new Date().toISOString(),
      seq: this.seq,
      type,
      ...fields,
    };
    try {
      await fs.appendFile(this.paths.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      // Live subscribers still get the event, but the run is now recovery-
      // DEGRADED: this event lives only in memory and its sequence number can
      // be reused after a restart. Count it — the server reports it.
      this.failedAppends += 1;
      console.error(`[VibeFix] Failed to append event to log (${this.failedAppends} so far):`, err);
    }
    this.bus.emit("event", event);
    return event;
  }

  subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await fs.readFile(this.paths.eventsFile, "utf8");
      for (const line of content.split("\n")) {
        if (line.trim()) this.seq += 1;
      }
    } catch {
      // no events yet
    }
    this.loaded = true;
  }
}
