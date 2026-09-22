import { useEffect, useRef } from "react";
import type { AgentDefinition, RunEvent, RunState } from "../types";
import { useRunStore } from "../store";

const PERMISSION_LABEL: Record<string, string> = {
  "read-only": "Read-only — cannot modify your code",
  "evidence-write": "Writes evidence + harness files only",
  "worktree-write": "The only agent that edits code — inside a firewalled worktree",
};

const STATUS_COLOR: Record<string, string> = {
  running: "text-sky-300",
  passed: "text-emerald-300",
  failed: "text-red-400",
  rejected: "text-orange-400",
  deferred: "text-yellow-400",
  queued: "text-slate-400",
  skipped: "text-slate-500",
};

function detailOf(event: RunEvent): string | null {
  const payload = event.payload as { detail?: unknown; error?: unknown } | undefined;
  const raw = payload?.detail ?? payload?.error;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Clicked-node drawer: what this agent is, does, is doing RIGHT NOW, and spent. */
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
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const latest = [...events].reverse().find((e) => e.message);
  const failures = events.filter(
    (e) => /failed|error|invalid|rejected/i.test(e.message ?? "") || detailOf(e) !== null,
  );

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-96 flex-col overflow-hidden rounded-l-lg border-l border-slate-700 bg-ink-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">{def.label}</div>
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
          <Stat label="Status" value={status} highlight={status === "running"} color={STATUS_COLOR[status]} />
          <Stat label="Tokens spent" value={tokens.toLocaleString()} />
          <Stat label="Capability" value={def.capability === "TypedDecision" ? "Typed decision" : "Text generation"} />
          <Stat label="Phase" value={def.phase} />
        </section>

        {status === "running" && (
          <section className="rounded border border-sky-900/60 bg-sky-950/30 px-3 py-2">
            <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
              doing now
            </div>
            <p className="text-slate-300">{latest?.message ?? "working…"}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              started {events[0] ? new Date(events[0].ts).toLocaleTimeString([], { hour12: false }) : "—"} ·{" "}
              {events.length} activity entries
            </p>
          </section>
        )}

        {failures.length > 0 && (
          <section>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-red-400">Issues ({failures.length})</div>
            <div className="space-y-1 rounded border border-red-900/50 bg-red-950/20 p-2 font-mono text-[10px] leading-4">
              {failures.slice(-5).map((e) => (
                <div key={e.eventId} className="break-words text-red-300">
                  <span className="text-slate-600">{new Date(e.ts).toLocaleTimeString([], { hour12: false })} </span>
                  {e.message}
                  {detailOf(e) && <div className="pl-4 text-red-400/80">{detailOf(e)}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Activity ({events.length} events)
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-slate-800 bg-ink-950 p-2 font-mono text-[10px] leading-4">
            {events.length === 0 && <div className="text-slate-600">no activity yet</div>}
            {events.map((e) => (
              <div key={e.eventId} className="flex gap-2">
                <span className="shrink-0 text-slate-600">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                <span className={messageColor(e)}>{e.message ?? e.type}</span>
                {detailOf(e) && <span className="block break-words text-red-400/70">— {detailOf(e)}</span>}
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
