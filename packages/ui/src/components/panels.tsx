import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ChangeProposal, Finding, LedgerEntry, Report } from "../types";

const BAND_COLOR: Record<string, string> = {
  low: "bg-emerald-900/60 text-emerald-300",
  medium: "bg-yellow-900/60 text-yellow-300",
  high: "bg-orange-900/60 text-orange-300",
  forbidden: "bg-red-900/70 text-red-300",
};

export function RiskBadge({ band, value }: { band: string; value: number }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BAND_COLOR[band] ?? BAND_COLOR.medium}`}>
      {band} · {value}
    </span>
  );
}

export function FindingsPanel({ runId }: { runId: string }) {
  const { data } = useQuery({ queryKey: ["findings", runId], queryFn: () => api.findings(runId), refetchInterval: 4_000 });
  const findings: Finding[] = data?.findings ?? [];
  const [category, setCategory] = useState<string>("all");
  const categories = ["all", ...new Set(findings.map((f) => f.category))];
  const shown = category === "all" ? findings : findings.filter((f) => f.category === category);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Findings ({findings.length})
        </span>
        <div className="flex gap-1">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded px-2 py-0.5 text-[10px] ${category === c ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-400"}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {findings.length === 0 && <div className="p-3 text-xs text-slate-600">no findings yet — diagnosis pool still working</div>}
        {shown.map((f) => (
          <details key={f.findingId} className="mb-2 rounded border border-slate-800 bg-ink-800 px-3 py-2">
            <summary className="cursor-pointer list-none">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-slate-200">{f.title}</span>
                <RiskBadge band={f.risk.band} value={f.risk.value} />
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                <code className="text-sky-400">{f.location || "—"}</code>
                <span>{f.findingId}</span>
                <span>conf {(f.confidence * 100).toFixed(0)}%</span>
              </div>
            </summary>
            <p className="mt-2 text-[11px] text-slate-400">{f.impact}</p>
            <ul className="mt-1 list-disc pl-4 text-[10px] text-slate-500">
              {f.evidence.slice(0, 8).map((e, i) => (
                <li key={i} className="font-mono">{e}</li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

export function CheckpointPanel({ runId, onDone }: { runId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["backlog", runId], queryFn: () => api.backlog(runId) });
  const [mode, setMode] = useState("minimal");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  const proposals: ChangeProposal[] = data?.proposals ?? [];
  if (proposals.length > 0 && !ready) {
    setSelected(new Set(proposals.filter((p) => p.allowedInModes.includes(mode)).map((p) => p.proposalId)));
    setReady(true);
  }

  const approve = useMutation({
    mutationFn: () => api.approve(runId, mode, [...selected]),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone();
    },
  });
  const reject = useMutation({
    mutationFn: () => api.abort(runId),
    onSuccess: onDone,
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const changeMode = (m: string) => {
    setMode(m);
    setSelected(new Set(proposals.filter((p) => p.allowedInModes.includes(m)).map((p) => p.proposalId)));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-violet-900/50 bg-ink-900">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-violet-300">
        Checkpoint — approve the Remediation Backlog before anything is touched
      </div>
      <div className="flex gap-2 border-b border-slate-800 px-3 py-2">
        {[
          { id: "minimal", label: "Minimal", desc: "smallest diffs, preserve everything" },
          { id: "architecture", label: "Architecture", desc: "allow boundary changes" },
          { id: "modernization", label: "Modernization", desc: "larger transformations" },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => changeMode(m.id)}
            className={`flex-1 rounded border px-2 py-1.5 text-left ${mode === m.id ? "border-violet-500 bg-violet-950/40" : "border-slate-800 bg-ink-800"}`}
          >
            <div className="text-xs font-semibold text-slate-200">{m.label}</div>
            <div className="text-[10px] text-slate-500">{m.desc}</div>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {proposals.length === 0 && <div className="p-3 text-xs text-slate-600">waiting for the backlog…</div>}
        {proposals.map((p) => {
          const allowed = p.allowedInModes.includes(mode);
          return (
            <label
              key={p.proposalId}
              className={`mb-2 flex cursor-pointer items-start gap-2 rounded border px-3 py-2 ${allowed ? "border-slate-800 bg-ink-800" : "border-slate-900 bg-ink-950 opacity-40"}`}
            >
              <input
                type="checkbox"
                checked={selected.has(p.proposalId)}
                disabled={!allowed}
                onChange={() => toggle(p.proposalId)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium text-slate-200">{p.title}</span>
                  <RiskBadge band={p.risk.band} value={p.risk.value} />
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{p.problem}</p>
                <div className="mt-1 text-[10px] text-slate-500">
                  scope: <code className="text-sky-400">{p.filesInScope.join(", ")}</code>
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2">
        <span className="text-[11px] text-slate-500">{selected.size} selected</span>
        <div className="flex gap-2">
          <button
            onClick={() => reject.mutate()}
            className="rounded bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
          >
            Reject all
          </button>
          <button
            onClick={() => approve.mutate()}
            disabled={selected.size === 0 || approve.isPending}
            className="rounded bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            Approve {selected.size} → start transformation
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExecutionPanel({ runId }: { runId: string }) {
  const { data } = useQuery({ queryKey: ["ledger", runId], queryFn: () => api.ledger(runId), refetchInterval: 3_000 });
  const entries: LedgerEntry[] = data?.entries ?? [];
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Change ledger
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {entries.length === 0 && <div className="p-3 text-xs text-slate-600">no attempts yet…</div>}
        {entries.map((entry) => (
          <details key={entry.ledgerId} className="mb-2 rounded border border-slate-800 bg-ink-800 px-3 py-2">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-200">
                  {entry.proposalId} <span className="text-slate-500">attempt {entry.attempt + 1}</span>
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    entry.verdict === "passed"
                      ? "bg-emerald-900/60 text-emerald-300"
                      : entry.verdict === "deferred"
                        ? "bg-yellow-900/60 text-yellow-300"
                        : "bg-red-900/60 text-red-300"
                  }`}
                >
                  {entry.verdict}
                  {entry.committedRef ? " ✓ committed" : ""}
                </span>
              </div>
            </summary>
            {entry.verifierNotes.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-[10px] text-slate-400">
                {entry.verifierNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-slate-400">
              {entry.diff.slice(0, 4_000) || "(empty diff)"}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}

export function ReportPanel({ runId }: { runId: string }) {
  const { data, error } = useQuery({ queryKey: ["report", runId], queryFn: () => api.report(runId), retry: false });
  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-slate-800 bg-ink-900 text-xs text-slate-600">
        report not ready yet
      </div>
    );
  }
  const report = data as Report;
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Final report
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-xs leading-5">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">State of your codebase</h3>
        <p className="mb-4 text-slate-400">{report.stateOfCodebase}</p>

        <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {[
            ["proposed", report.totals.changesProposed],
            ["committed", report.totals.changesCommitted],
            ["rejected", report.totals.changesRejected],
            ["deferred", report.totals.changesDeferred],
            ["API changes", report.totals.publicApiChanges],
            ["tokens", report.totals.tokensSpent],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded border border-slate-800 bg-ink-800 p-2 text-center">
              <div className="text-lg font-bold text-slate-100">{String(value)}</div>
              <div className="text-[10px] uppercase text-slate-500">{String(label)}</div>
            </div>
          ))}
        </div>

        <h3 className="mb-1 text-sm font-semibold text-slate-100">Changes</h3>
        <ul className="mb-4 list-disc pl-4 text-slate-400">
          {report.changeExplainers.map((c) => (
            <li key={c.proposalId}>
              <span className="text-slate-200">{c.proposalId}: {c.what}</span> — {c.why}{" "}
              <span className="text-sky-400">({c.principle})</span>
            </li>
          ))}
        </ul>

        <h3 className="mb-1 text-sm font-semibold text-emerald-400">What did NOT change</h3>
        <ul className="mb-4 list-disc pl-4 text-emerald-300/80">
          {report.whatDidNotChange.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>

        <h3 className="mb-1 text-sm font-semibold text-slate-100">Learning summary</h3>
        <p className="text-slate-400">{report.learningSummary}</p>
      </div>
    </div>
  );
}
