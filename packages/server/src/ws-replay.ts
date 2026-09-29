import type { AgentExecutionEvent } from "@vibefix/schemas";

/** Minimal surface of core's EventLog the bridge needs (test doubles fit). */
export interface ReplaySource {
  eventsSince(since: number): Promise<AgentExecutionEvent[]>;
  subscribe(listener: (event: AgentExecutionEvent) => void): () => void;
}

export interface BridgeOptions {
  source: ReplaySource;
  /** Client's last seen sequence — replay everything after it. */
  since: number;
  send: (frame: unknown) => void;
  /** Serialize an event into the wire frame shape used by /ws. */
  eventFrame?: (event: AgentExecutionEvent) => unknown;
  /** Called for every event delivered in LIVE mode (not the replay itself). */
  onLiveEvent?: (event: AgentExecutionEvent) => void;
}

/**
 * Correct replay→live handoff for a streaming socket.
 *
 * The naive order (replay history, THEN subscribe) has a race: any event
 * appended between the replay query and the subscription is missed forever.
 * This bridge subscribes FIRST into a buffer, then replays, then flushes the
 * buffer minus anything the replay already covered (dedup by eventId), and
 * only then goes live. No event is lost and none is delivered twice.
 *
 * Returns an unsubscribe function (call on socket close).
 */
export function bridgeReplayToLive(opts: BridgeOptions): () => void {
  const { source, since, send } = opts;
  const eventFrame = opts.eventFrame ?? ((event) => ({ t: "event", event, seq: event.seq }));
  const buffer: AgentExecutionEvent[] = [];
  let live = false;

  const deliver = (event: AgentExecutionEvent, isLive: boolean) => {
    send(eventFrame(event));
    if (isLive) opts.onLiveEvent?.(event);
  };

  const unsubscribe = source.subscribe((event) => {
    if (!live) {
      buffer.push(event);
      return;
    }
    deliver(event, true);
  });

  void source
    .eventsSince(since)
    .then((replayed) => {
      const replayedIds = new Set(replayed.map((e) => e.eventId));
      for (const event of replayed) deliver(event, false);
      // Flush events that arrived while the replay query was in flight.
      // They are ordered after everything the replay could have returned.
      for (const event of buffer.splice(0)) {
        if (!replayedIds.has(event.eventId)) deliver(event, true);
      }
      live = true;
    })
    .catch(() => {
      // Replay failed (disk error): go live immediately rather than losing
      // the subscription — the client's REST fallback fills any gap.
      for (const event of buffer.splice(0)) deliver(event, true);
      live = true;
    });

  return unsubscribe;
}
