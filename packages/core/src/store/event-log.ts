import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { AgentExecutionEvent, AgentExecutionEventType } from "@vibefix/schemas";
import { eventId } from "../util/ids.js";
import type { RunPaths } from "./paths.js";

/**
 * Append-only NDJSON event log + in-process bus. seq = line number, so a
 * reconnecting UI resyncs cheaply via GET /runs/:id/events?since=<seq>.
 */
export class EventLog {
  private readonly bus = new EventEmitter();
  private seq = 0;
  private loaded = false;

  constructor(private readonly paths: RunPaths) {
    this.bus.setMaxListeners(100);
  }

  /** Replay for new subscribers / resync. */
  async eventsSince(sinceSeq: number): Promise<AgentExecutionEvent[]> {
    await this.ensureLoaded();
    const out: AgentExecutionEvent[] = [];
    let content: string;
    try {
      content = await fs.readFile(this.paths.eventsFile, "utf8");
    } catch {
      return [];
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AgentExecutionEvent;
        if (parsed.seq > sinceSeq) out.push(parsed);
      } catch {
        // skip corrupt line
      }
    }
    return out;
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
      console.error(`[VibeFix] Failed to append event to log:`, err);
      // Still emit the event to subscribers even if persistence fails
      // This ensures real-time updates work even if disk I/O fails
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
