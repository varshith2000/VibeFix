import { useEffect, useRef } from "react";
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
  "run.aborted": "text-red-400 font-semibold",
  "run.failed": "text-red-400 font-semibold",
};

export function EventStream() {
  const events = useRunStore((s) => s.events);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Event stream
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
        {events.length === 0 && <div className="text-slate-600">waiting for events…</div>}
        {events.map((event) => (
          <div key={event.eventId} className="flex gap-2">
            <span className="shrink-0 text-slate-600">
              {new Date(event.ts).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className={`shrink-0 ${TYPE_COLOR[event.type] ?? "text-slate-300"}`}>{event.type}</span>
            {event.agentId && <span className="shrink-0 text-slate-500">{event.agentId}</span>}
            {event.message && <span className="truncate text-slate-400">{event.message}</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
