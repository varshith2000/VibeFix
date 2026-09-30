import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentDefinition, ProviderConfig, RepoConfig } from "../types";

/**
 * Models & budget settings. Edits the target repo's ModelRouting: toggle
 * providers, switch any agent to any provider (live — applies mid-run), and
 * cap costs with the token/change budgets. Keys themselves are never here:
 * they live in .env; this only names the env var each provider reads.
 */
export function SettingsPanel({
  repoPath,
  agents,
  onClose,
}: {
  repoPath: string;
  agents: AgentDefinition[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: loaded } = useQuery({
    queryKey: ["config", repoPath],
    queryFn: () => api.config(repoPath),
  });
  const [draft, setDraft] = useState<RepoConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (loaded && !draft) setDraft(structuredClone(loaded));
  }, [loaded, draft]);

  const save = useMutation({
    mutationFn: () => api.saveConfig(repoPath, draft!),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ["config", repoPath] });
    },
  });

  const costEstimate = useMemo(() => {
    if (!draft) return null;
    const used = new Set(
      Object.values(draft.routing.routes).map((r) => r.providerId),
    );
    const prices = draft.routing.providers
      .filter((p) => p.enabled && used.has(p.providerId))
      .map((p) => (p.pricePerMTokInput ?? 0) + (p.pricePerMTokOutput ?? 0));
    const worst = prices.length > 0 ? Math.max(...prices) : 0;
    return {
      worstCaseUsd: (worst * draft.routing.budgets.runMaxTokens) / 1_000_000,
      anyPriced: prices.length > 0,
    };
  }, [draft]);

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">loading config…</div>
    );
  }

  const textProviders = draft.routing.providers.filter((p) => p.kind === "TextGeneration");
  const decisionProviders = draft.routing.providers.filter((p) => p.kind === "TypedDecision");

  const setProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setDraft((d) => ({
      ...d!,
      routing: {
        ...d!.routing,
        providers: d!.routing.providers.map((p) => (p.providerId === id ? { ...p, ...patch } : p)),
      },
    }));
  };

  const setRoute = (agentId: string, patch: { providerId?: string; fallbackProviderId?: string }) => {
    setDraft((d) => ({
      ...d!,
      routing: {
        ...d!.routing,
        routes: { ...d!.routing.routes, [agentId]: { ...d!.routing.routes[agentId]!, ...patch } },
      },
    }));
  };

  const setBudget = (patch: Partial<RepoConfig["routing"]["budgets"]>) => {
    setDraft((d) => ({
      ...d!,
      routing: { ...d!.routing, budgets: { ...d!.routing.budgets, ...patch } },
    }));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Models &amp; cost limits
        </span>
        <div className="flex items-center gap-2">
          {saved && <span className="text-[10px] text-emerald-400">saved ✓ applies live</span>}
          <button onClick={onClose} className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-700">
            close
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        {/* Providers */}
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Providers</h4>
          <div className="space-y-1.5">
            {draft.routing.providers.map((p) => (
              <div key={p.providerId} className="flex items-center gap-2 rounded border border-slate-800 bg-ink-800 px-2.5 py-1.5">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => setProvider(p.providerId, { enabled: e.target.checked })}
                  />
                  <span className="w-24 text-xs font-medium text-slate-200">{p.providerId}</span>
                </label>
                <span
                  className={`rounded px-1 text-[9px] uppercase ${
                    p.kind === "TypedDecision" ? "bg-violet-900/60 text-violet-300" : "bg-sky-900/60 text-sky-300"
                  }`}
                >
                  {p.kind === "TypedDecision" ? "decide" : "text"}
                </span>
                <input
                  value={p.defaultModel}
                  onChange={(e) => setProvider(p.providerId, { defaultModel: e.target.value })}
                  disabled={!p.enabled}
                  className="w-44 rounded border border-slate-700 bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-slate-200 outline-none focus:border-sky-500 disabled:opacity-40"
                  title="Model id"
                />
                <span className="ml-auto text-[10px] text-slate-500">
                  {p.apiKeyEnv ? (
                    <>
                      key: <code className="text-amber-400">{p.apiKeyEnv}</code>
                      {p.pricePerMTokInput !== undefined && (
                        <span className="ml-2">
                          ${p.pricePerMTokInput}/${p.pricePerMTokOutput ?? p.pricePerMTokInput} per Mtok
                        </span>
                      )}
                    </>
                  ) : (
                    "no key needed"
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-600">
            Keys are read from environment variables (or the server's .env) — never stored here.
          </p>
        </section>

        {/* Agent routing */}
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Agent routing — switch any agent to any provider
          </h4>
          <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
            {agents.map((agent) => {
              const route = draft.routing.routes[agent.agentId];
              if (!route) return null;
              const pool = agent.capability === "TypedDecision" ? decisionProviders : textProviders;
              const fallbacks = pool.filter((p) => p.providerId !== route.providerId);
              return (
                <div key={agent.agentId} className="flex items-center gap-1.5 rounded border border-slate-800 bg-ink-800 px-2 py-1.5">
                  <span className="w-32 truncate text-[11px] text-slate-300" title={agent.role}>
                    {agent.label}
                  </span>
                  <select
                    value={route.providerId}
                    onChange={(e) => setRoute(agent.agentId, { providerId: e.target.value })}
                    className="flex-1 rounded border border-slate-700 bg-ink-950 px-1.5 py-0.5 text-[11px] text-slate-200 outline-none"
                  >
                    {pool.map((p) => (
                      <option key={p.providerId} value={p.providerId} disabled={!p.enabled}>
                        {p.providerId} · {p.defaultModel}
                      </option>
                    ))}
                  </select>
                  <select
                    value={route.fallbackProviderId ?? ""}
                    onChange={(e) => setRoute(agent.agentId, { fallbackProviderId: e.target.value || undefined })}
                    className="w-32 rounded border border-slate-700 bg-ink-950 px-1.5 py-0.5 text-[10px] text-slate-400 outline-none"
                    title="Fallback if the primary fails"
                  >
                    <option value="">no fallback</option>
                    {fallbacks.map((p) => (
                      <option key={p.providerId} value={p.providerId}>
                        ↳ {p.providerId}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </section>

        {/* Cost limits */}
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Repository command execution
          </h4>
          <label className="flex items-start gap-2 rounded border border-amber-900/60 bg-amber-950/20 p-2.5 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={draft.executionPolicy.allowRepositoryCommands}
              onChange={(event) => setDraft((current) => ({
                ...current!,
                executionPolicy: { allowRepositoryCommands: event.target.checked },
              }))}
              className="mt-0.5"
            />
            <span>
              Allow this repository&apos;s test, build, typecheck, and lint scripts to run on this machine.
              These commands are untrusted code. When disabled, verification fails closed and no change lands.
            </span>
          </label>
        </section>

        {/* Cost limits */}
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Cost limits</h4>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <LabeledNumber
              label="Run token cap"
              value={draft.routing.budgets.runMaxTokens}
              step={100_000}
              onChange={(v) => setBudget({ runMaxTokens: Math.max(10_000, v) })}
            />
            <LabeledNumber
              label="Max changes / run"
              value={draft.routing.budgets.maxChangesPerRun}
              step={1}
              onChange={(v) => setBudget({ maxChangesPerRun: Math.max(1, v) })}
            />
            <LabeledNumber
              label="Retries / change"
              value={draft.routing.budgets.maxRetriesPerChange}
              step={1}
              onChange={(v) => setBudget({ maxRetriesPerChange: Math.max(0, v) })}
            />
            <LabeledNumber
              label="Warn at %"
              value={Math.round(draft.routing.budgets.warnFraction * 100)}
              step={5}
              onChange={(v) => setBudget({ warnFraction: Math.min(1, Math.max(0.1, v / 100)) })}
            />
          </div>
          {costEstimate && (
            <p className="mt-2 text-[10px] text-slate-500">
              {costEstimate.anyPriced ? (
                <>
                  Estimated worst-case spend at the cap:{" "}
                  <span className="text-amber-400">${costEstimate.worstCaseUsd.toFixed(2)}</span>{" "}
                  (priciest routed provider × full token cap; real spend is usually far lower). The run hard-stops at the cap.
                </>
              ) : (
                "No priced providers routed — runs are effectively free (local Ollama or no key set)."
              )}
            </p>
          )}
        </section>
      </div>

      <div className="flex justify-end border-t border-slate-800 px-3 py-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save — applies to running runs"}
        </button>
      </div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block rounded border border-slate-800 bg-ink-800 px-2 py-1.5">
      <span className="block text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-0.5 w-full rounded border border-slate-700 bg-ink-950 px-2 py-0.5 font-mono text-xs text-slate-200 outline-none focus:border-sky-500"
      />
    </label>
  );
}
