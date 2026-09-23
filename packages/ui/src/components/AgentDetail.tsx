import { useEffect, useRef, useState } from "react";
import type { AgentDefinition, RunEvent, RunState } from "../types";
import { useRunStore } from "../store";

const PERMISSION_LABEL: Record<string, string> = {
  "read-only": "Read-only — cannot modify your code",
  "evidence-write": "Writes evidence + harness files only",
  "worktree-write": "The only agent that edits code — inside a firewalled worktree",
};

const STATUS_STYLE: Record<string, { pill: string; label: string }> = {
  running: { pill: "bg-sky-900/70 text-sky-200", label: "text-sky-300" },
  passed: { pill: "bg-emerald-900/70 text-emerald-200", label: "text-emerald-300" },
  failed: { pill: "bg-red-900/70 text-red-200", label: "text-red-400" },
  rejected: { pill: "bg-orange-900/70 text-orange-200", label: "text-orange-400" },
  deferred: { pill: "bg-yellow-900/70 text-yellow-200", label: "text-yellow-400" },
  queued: { pill: "bg-slate-800 text-slate-300", label: "text-slate-400" },
  skipped: { pill: "bg-slate-800/60 text-slate-400", label: "text-slate-500" },
};

function detailOf(event: RunEvent): string | null {
  const payload = event.payload as { detail?: unknown; error?: unknown } | undefined;
  const raw = payload?.detail ?? payload?.error;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function relTime(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Clicked-node drawer: what this agent is, does, is doing RIGHT NOW, and spent.
 *  Updates live — every event, token, and status change lands here the moment
 *  the run emits it (WebSocket first, 3s REST polling as fallback). */
export function AgentDetail({
  def,
  runState,
  onClose,
}: {
  def: AgentDefinition;
  runState: RunState | null;
  onClose: () => void;
}) {
  const events = useRunStore((s) => s.events).filter((e) => e.agentId === def.agentId);
  const usage = useRunStore((s) => s.usage);
  const tokens = usage.byAgent[def.agentId] ?? 0;
  const status = runState?.agentStates[def.agentId] ?? "queued";
  const bottomRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  // Heartbeat: keeps relative timestamps and elapsed time ticking so the
  // drawer visibly feels alive even between events.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const latest = [...events].reverse().find((e) => e.message);
  const failures = events.filter(
    (e) => /failed|error|invalid|rejected/i.test(e.message ?? "") || detailOf(e) !== null,
  );
  const startedAt = events[0] ? new Date(events[0].ts).getTime() : null;
  const elapsed =
    startedAt === null
      ? null
      : status === "running"
        ? now - startedAt
        : new Date(events[events.length - 1]!.ts).getTime() - startedAt;
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.queued!;

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[26rem] flex-col overflow-hidden rounded-l-lg border-l border-slate-700 bg-ink-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{def.label}</span>
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase ${style.pill}`}>
              {status === "running" && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
              {status}
            </span>
          </div>
          <code className="text-[10px] text-slate-500">{def.agentId}</code>
        </div>
        <button onClick={onClose} className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-700">
          close
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Role</div>
          <p className="text-slate-300">{def.role}</p>
        </section>

        <section className="grid grid-cols-2 gap-2">
          <Stat label="Status" value={status} highlight={status === "running"} color={style.label} />
          <Stat label="Tokens spent" value={tokens.toLocaleString()} />
          <Stat
            label="Elapsed"
            value={elapsed === null ? "—" : elapsed >= 60_000 ? `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s` : `${Math.floor(elapsed / 1000)}s`}
          />
          <Stat label="Capability" value={def.capability === "TypedDecision" ? "Typed decision" : "Text generation"} />
        </section>

        <section className={`rounded border px-3 py-2 transition-colors ${status === "running" ? "border-sky-900/60 bg-sky-950/30" : "border-slate-800 bg-ink-800/60"}`}>
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300">
            {status === "running" ? (
              <>
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                doing now · live
              </>
            ) : (
              <span className="text-slate-500">last activity</span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-slate-300">{latest?.message ?? (status === "queued" ? "waiting for its turn in the pipeline" : "no activity recorded")}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">
            {events.length > 0 ? (
              <>
                {relTime(new Date(events[events.length - 1]!.ts).getTime(), now)} · started{" "}
                {new Date(events[0]!.ts).toLocaleTimeString([], { hour12: false })} · {events.length} activity entries
              </>
            ) : (
              "—"
            )}
          </p>
        </section>

        {failures.length > 0 && (
          <section>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-red-400">Issues ({failures.length})</div>
            <div className="space-y-1 overflow-x-auto rounded border border-red-900/50 bg-red-950/20 p-2 font-mono text-[10px] leading-4">
              {failures.slice(-5).map((e) => (
                <div key={e.eventId} className="whitespace-nowrap text-red-300">
                  <span className="text-slate-600">{new Date(e.ts).toLocaleTimeString([], { hour12: false })} </span>
                  {e.message}
                  {detailOf(e) && <div className="whitespace-pre pl-4 text-red-400/80">{detailOf(e)}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Activity ({events.length} events)
          </div>
          <div className="max-h-72 space-y-1 overflow-x-auto overflow-y-auto rounded border border-slate-800 bg-ink-950 p-2 font-mono text-[10px] leading-4">
            {events.length === 0 && <div className="text-slate-600">no activity yet</div>}
            {events.map((e) => (
              <div key={e.eventId} className="flex gap-2 whitespace-nowrap" title={new Date(e.ts).toLocaleString()}>
                <span className="shrink-0 text-slate-600">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                <span className={messageColor(e)}>{e.message ?? e.type}</span>
                {detailOf(e) && <span className="whitespace-pre text-red-400/70">— {detailOf(e)}</span>}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </section>

        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Permissions</div>
          <p className="text-slate-300">{PERMISSION_LABEL[def.permission] ?? def.permission}</p>
          {def.freshContext && (
            <p className="mt-1 text-[11px] text-emerald-400">
              Fresh context: this agent structurally never sees the engineer's reasoning — only diffs and evidence.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function messageColor(e: RunEvent): string {
  return /failed|error|invalid|rejected/i.test(e.message ?? "") ? "text-red-300" : "text-slate-400";
}

function Stat({ label, value, highlight, color }: { label: string; value: string; highlight?: boolean; color?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-ink-800 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xs font-semibold ${color ?? (highlight ? "text-sky-300" : "text-slate-200")}`}>{value}</div>
    </div>
  );
}
