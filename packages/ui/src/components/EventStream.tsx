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

/** Full payload detail/error — never truncated; long lines scroll sideways. */
function eventDetail(event: { payload?: unknown }): string | null {
  const payload = event.payload as { detail?: unknown; error?: unknown } | undefined;
  const raw = payload?.detail ?? payload?.error;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw instanceof Error) return raw.message;
  return null;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 280;
const MAX_WIDTH = 1100;

export function EventStream({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (px: number) => void;
}) {
  const events = useRunStore((s) => s.events);
  const wsStatus = useRunStore((s) => s.wsStatus);
  const lastEventAt = useRunStore((s) => s.lastEventAt);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [age, setAge] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [dragging, setDragging] = useState(false);

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
  // Tick so the "no events yet" hint and relative timestamps stay fresh.
  useEffect(() => {
    const t = setInterval(() => setAge(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const secondsSinceEvent = lastEventAt ? Math.floor((age - lastEventAt) / 1000) : null;

  // Drag the left edge to resize; clamp so both panes stay usable.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      Math.max(drag.startWidth - (e.clientX - drag.startX), MIN_WIDTH),
      Math.min(MAX_WIDTH, window.innerWidth - 520),
    );
    onWidthChange(next);
  };
  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const toggleExpanded = () => onWidthChange(width < 560 ? 640 : DEFAULT_WIDTH);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900"
      style={{ width }}
    >
      {/* Resize handle — drag the edge to widen/shrink the stream. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`absolute inset-y-0 left-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center ${
          dragging ? "bg-sky-500/70" : "hover:bg-sky-500/40"
        }`}
        title="Drag to resize"
      />

      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3.5 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <span className="flex items-center gap-2">
          Event stream
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] font-normal normal-case text-slate-500">
            {events.length}
          </span>
        </span>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              setAutoScroll(true);
              bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
            className={`rounded px-1.5 py-0.5 text-[9px] normal-case transition-colors ${
              autoScroll ? "text-slate-600" : "bg-sky-900/60 text-sky-300 hover:bg-sky-800/60"
            }`}
            title={autoScroll ? "Following the latest events" : "Paused — click to jump to latest"}
          >
            {autoScroll ? "↓ following" : "⏸ paused — jump to latest"}
          </button>
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
          <button
            onClick={toggleExpanded}
            className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            title={width < 560 ? "Expand the event stream" : "Shrink back to compact size"}
          >
            {width < 560 ? "⤢" : "⤡"}
          </button>
        </div>
      </div>

      {/* Horizontal scroll: long messages and stack traces stay on one line
          and scroll sideways instead of breaking mid-sentence. */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-x-auto overflow-y-auto px-3.5 py-2 font-mono text-[11px] leading-5">
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
            <div key={event.eventId} className="group mb-0.5">
              <div className="flex gap-2 whitespace-nowrap">
                <span className="shrink-0 text-slate-600">
                  {new Date(event.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`shrink-0 ${TYPE_COLOR[event.type] ?? "text-slate-300"}`}>{event.type}</span>
                {event.agentId && <span className="shrink-0 text-slate-500">{event.agentId}</span>}
                {event.message && (
                  <span className={`whitespace-pre ${messageClass(event.type, event.message)}`}>{event.message}</span>
                )}
              </div>
              {detail && <div className="whitespace-pre py-0.5 pl-16 text-[10px] text-red-400/80">{detail}</div>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {secondsSinceEvent !== null && secondsSinceEvent > 30 && events.length > 0 && (
        <div className="border-t border-slate-800 px-3.5 py-1 text-[9px] text-slate-600">
          last event {secondsSinceEvent}s ago{wsStatus !== "live" ? " · REST polling active" : ""}
        </div>
      )}
    </div>
  );
}
