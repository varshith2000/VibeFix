import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { ProjectIntelligence } from "../types";

function ScoreRing({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? "text-emerald-400" : value >= 50 ? "text-amber-400" : "text-rose-400";
  const bar =
    value >= 75 ? "bg-emerald-500" : value >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="rounded-lg border border-white/5 bg-ink-800/80 px-3 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</span>
        <span className={`font-display text-2xl tabular-nums ${color}`}>{value}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-950">
        <div className={`h-full rounded-full transition-all duration-700 ${bar}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function HealthPanel({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: ["intelligence", runId],
    queryFn: () => api.intelligence(runId),
    refetchInterval: 4_000,
  });
  const intel: ProjectIntelligence | undefined = data;

  if (!intel) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-slate-800 bg-ink-900 text-xs text-slate-600">
        Mapping your codebase…
      </div>
    );
  }

  const { health, findingCounts, intent, graph, survey } = intel;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <section className="rounded-lg border border-slate-800 bg-ink-900 p-4">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="font-display text-lg text-slate-100">Project health</h2>
            <p className="text-[11px] text-slate-500">
              Evidence-backed scores — not vibes. {findingCounts.total} findings across the diagnosis pool.
            </p>
          </div>
          <div className="flex gap-2 text-[10px]">
            {(["forbidden", "high", "medium", "low"] as const).map((b) => (
              <span key={b} className="rounded bg-ink-800 px-2 py-1 text-slate-400">
                <span className="font-semibold text-slate-200">{findingCounts.byBand[b] ?? 0}</span> {b}
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <ScoreRing label="Architecture" value={health.architecture} />
          <ScoreRing label="Maintainability" value={health.maintainability} />
          <ScoreRing label="Testing" value={health.testing} />
          <ScoreRing label="Security" value={health.security} />
          <ScoreRing label="Dependencies" value={health.dependencyHygiene} />
          <ScoreRing label="Documentation" value={health.documentation} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-800 bg-ink-900 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-sky-400">What exists</h3>
          {graph ? (
            <div className="space-y-2 text-[12px] text-slate-300">
              <div>
                <span className="text-slate-500">Languages · </span>
                {graph.summary.languages.join(", ") || "—"}
              </div>
              <div>
                <span className="text-slate-500">Frameworks · </span>
                {graph.summary.frameworks.join(", ") || "none detected"}
              </div>
              <div>
                <span className="text-slate-500">Scale · </span>
                {graph.summary.fileCount} files · {graph.summary.loc.toLocaleString()} LOC
              </div>
              <div>
                <span className="text-slate-500">Entrypoints · </span>
                <code className="text-[11px] text-emerald-400">{graph.summary.entrypoints.slice(0, 6).join(", ") || "—"}</code>
              </div>
              {graph.summary.unknowns.length > 0 && (
                <div className="rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200/80">
                  Unknowns: {graph.summary.unknowns.slice(0, 4).join("; ")}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-600">Waiting on Cartographer…</p>
          )}
        </section>

        <section className="rounded-lg border border-slate-800 bg-ink-900 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-violet-400">Product intent</h3>
          {intent ? (
            <div className="space-y-2 text-[12px] text-slate-300">
              <p className="leading-relaxed text-slate-200">{intent.productSummary}</p>
              <div>
                <span className="text-slate-500">Core · </span>
                {intent.coreAreas.slice(0, 6).join(", ") || "—"}
              </div>
              <div>
                <span className="text-slate-500">Active churn · </span>
                {intent.activeChurnAreas.slice(0, 5).join(", ") || "—"}
              </div>
              <div>
                <span className="text-slate-500">Frozen · </span>
                {intent.frozenAreas.slice(0, 5).join(", ") || "—"}
              </div>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-slate-500">
                {intent.intentConstraints.slice(0, 4).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-slate-600">Waiting on Historian…</p>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-slate-800 bg-ink-900 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-amber-400">What&apos;s missing</h3>
        <div className="grid grid-cols-2 gap-3 text-[12px] md:grid-cols-4">
          {Object.entries(findingCounts.byCategory).map(([cat, n]) => (
            <div key={cat} className="rounded border border-white/5 bg-ink-800 px-3 py-2">
              <div className="text-lg font-semibold text-slate-100">{n}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{cat}</div>
            </div>
          ))}
          {survey && (
            <>
              <div className="rounded border border-white/5 bg-ink-800 px-3 py-2">
                <div className="text-lg font-semibold text-slate-100">{survey.testFileCount}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">test files</div>
              </div>
              <div className="rounded border border-white/5 bg-ink-800 px-3 py-2">
                <div className="text-lg font-semibold text-slate-100">{survey.untestedPaths.length}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">untested paths</div>
              </div>
            </>
          )}
          {findingCounts.total === 0 && (
            <p className="col-span-full text-xs text-slate-600">Diagnosis pool still working…</p>
          )}
        </div>
      </section>
    </div>
  );
}
