import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { AgentExecutionEvent, AgentExecutionEventType } from "@vibefix/schemas";
import { redactSecrets, redactUnknown } from "@vibefix/schemas";
import { eventId } from "../util/ids.js";
import type { RunPaths } from "./paths.js";

/** Replay result with degradation metadata (corrupt lines are never silent). */
export interface ReplayResult {
  events: AgentExecutionEvent[];
  /** Lines in the durable log that could not be parsed. */
  corruptLines: number;
}

/**
 * Append-only NDJSON event log + in-process bus. Sequence numbers are read
 * from durable events and continue from the greatest valid persisted seq.
 *
 * Degradation is EXPLICIT: failed appends are counted and never published to
 * live subscribers. A sequence is consumed only after its event is durable.
 */
export class EventLog {
  private readonly bus = new EventEmitter();
  private seq = 0;
  private loaded = false;
  private failedAppends = 0;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly paths: RunPaths) {
    this.bus.setMaxListeners(100);
  }

  /** Appends that failed before reaching the durable log. */
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
    let resolveEvent!: (event: AgentExecutionEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<AgentExecutionEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const operation = this.appendQueue.then(async () => {
      try {
        await this.ensureLoaded();
        const event: AgentExecutionEvent = {
          eventId: eventId(),
          runId,
          ts: new Date().toISOString(),
          seq: this.seq + 1,
          type,
          ...fields,
          ...(fields.message ? { message: redactSecrets(fields.message) } : {}),
          ...(fields.payload !== undefined ? { payload: redactUnknown(fields.payload) } : {}),
        };
        await fs.appendFile(this.paths.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
        this.seq = event.seq;
        this.bus.emit("event", event);
        resolveEvent(event);
      } catch (err) {
        this.failedAppends += 1;
        console.error(`[VibeFix] Failed to append event to log (${this.failedAppends} so far):`, err);
        rejectEvent(err);
      }
    });
    this.appendQueue = operation.catch(() => undefined);
    return result;
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
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > this.seq) {
            this.seq = parsed.seq;
          }
        } catch {
          // Replay reports corrupt lines; valid sequence numbers remain usable.
        }
      }
    } catch {
      // no events yet
    }
    this.loaded = true;
  }
}
