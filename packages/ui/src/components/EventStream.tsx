import { useEffect, useRef, useState } from "react";
import { useRunStore } from "../store";

const TYPE_COLOR: Record<string, string> = {
  "phase.entered": "text-sky-300",
  "phase.completed": "text-sky-400",
  "agent.started": "text-amber-300",
  "agent.progress": "text-slate-400",
  "agent.completed": "text-emerald-300",
  "agent.failed": "text-red-400",
  "agent.rejected": "text-orange-400",
  "checkpoint.awaitingApproval": "text-violet-300 font-semibold",
  "checkpoint.approved": "text-violet-300",
  "proposal.verdict": "text-emerald-300",
  "ledger.updated": "text-slate-300",
  "budget.warning": "text-yellow-400",
  "run.completed": "text-emerald-400 font-semibold",
  "run.nochanges": "text-sky-400 font-semibold",
  "run.aborted": "text-red-400 font-semibold",
  "run.failed": "text-red-400 font-semibold",
};

/** agent.progress messages that are actually failures — color them as such. */
function messageClass(type: string, message?: string): string {
  if (type === "agent.progress" && message && /failed|error|invalid|rejected/i.test(message)) {
    return "text-red-300";
  }
  return "text-slate-400";
}

function eventDetail(event: { payload?: unknown; message?: string }): string | null {
  const payload = event.payload as { detail?: unknown; error?: unknown } | undefined;
  const raw = payload?.detail ?? payload?.error;
  if (typeof raw === "string" && raw.length > 0) return raw.slice(0, 240);
  return null;
}

export function EventStream() {
  const events = useRunStore((s) => s.events);
  const wsStatus = useRunStore((s) => s.wsStatus);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [age, setAge] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  useEffect(() => {
    // Only follow the tail when the user is already at the bottom — never
    // yank the stream away from someone reading older entries.
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [events.length, autoScroll]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAutoScroll(nearBottom);
  };
  // Tick so the "no events yet" hint can appear after a grace period instead
  // of an endless spinner.
  useEffect(() => {
    const t = setInterval(() => setAge(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const lastEventAt = useRunStore((s) => s.lastEventAt);
  const secondsSinceEvent = lastEventAt ? Math.floor((age - lastEventAt) / 1000) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <span>Event stream</span>
        <span
          className={`flex items-center gap-1 text-[9px] normal-case ${
            wsStatus === "live" ? "text-emerald-400" : wsStatus === "connecting" ? "text-amber-400" : "text-slate-500"
          }`}
          title={wsStatus === "live" ? "WebSocket connected" : "using REST polling fallback"}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              wsStatus === "live" ? "bg-emerald-400" : wsStatus === "connecting" ? "bg-amber-400" : "bg-slate-500"
            }`}
          />
          {wsStatus === "live" ? "live" : wsStatus === "connecting" ? "connecting…" : "polling"}
        </span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
        {events.length === 0 && (
          <div className="text-slate-600">
            {(secondsSinceEvent === null && wsStatus === "connecting") || (secondsSinceEvent ?? 99) < 15 ? (
              "waiting for events…"
            ) : (
              <div className="space-y-1">
                <div>no events received yet.</div>
                <div className="text-slate-500">
                  the run may not have started, or the server was restarted. State is syncing via REST
                  {" "}every 3s — if this stays empty, open the run again from the Runs tab.
                </div>
              </div>
            )}
          </div>
        )}
        {events.map((event) => {
          const detail = eventDetail(event);
          return (
            <div key={event.eventId} className="mb-0.5">
              <div className="flex gap-2">
                <span className="shrink-0 text-slate-600">
                  {new Date(event.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`shrink-0 ${TYPE_COLOR[event.type] ?? "text-slate-300"}`}>{event.type}</span>
                {event.agentId && <span className="shrink-0 text-slate-500">{event.agentId}</span>}
                {event.message && <span className={`min-w-0 break-words ${messageClass(event.type, event.message)}`}>{event.message}</span>}
              </div>
              {detail && <div className="pl-16 text-[10px] text-red-400/80">{detail}</div>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
