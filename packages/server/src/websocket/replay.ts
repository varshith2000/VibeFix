import type { AgentExecutionEvent } from "@vibefix/schemas";

export interface ReplaySource {
  subscribe(listener: (event: AgentExecutionEvent) => void): () => void;
  eventsSince(since: number): Promise<AgentExecutionEvent[]>;
}

export interface BridgeOptions {
  source: ReplaySource;
  since: number;
  send: (frame: unknown) => void;
  eventFrame?: (event: AgentExecutionEvent) => unknown;
  onLiveEvent?: (event: AgentExecutionEvent) => void;
}

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
  void source.eventsSince(since).then((replayed) => {
    const replayedIds = new Set(replayed.map((event) => event.eventId));
    for (const event of replayed) deliver(event, false);
    for (const event of buffer.splice(0)) {
      if (!replayedIds.has(event.eventId)) deliver(event, true);
    }
    live = true;
  }).catch(() => {
    for (const event of buffer.splice(0)) deliver(event, true);
    live = true;
  });
  return unsubscribe;
}