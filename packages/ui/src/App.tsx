import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useRunStore } from "./store";
import { AgentGraph } from "./components/AgentGraph";
import { EventStream } from "./components/EventStream";
import { CheckpointPanel, ExecutionPanel, FindingsPanel, ReportPanel } from "./components/panels";
import { SettingsPanel } from "./components/SettingsPanel";
import { CodebasePanel } from "./components/CodebasePanel";
import { AgentDetail } from "./components/AgentDetail";
import { HealthPanel } from "./components/HealthPanel";
import type { RepoConfig } from "./types";

type Screen = "open" | "run";
type View = "overview" | "health" | "codebase" | "findings" | "checkpoint" | "execution" | "report" | "runs" | "settings";

const RECENTS_KEY = "vibefix.recentProjects";

function loadRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function saveRecent(repoPath: string): void {
  const next = [repoPath, ...loadRecents().filter((r) => r !== repoPath)].slice(0, 6);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // private mode etc.
  }
}

// ---------------------------------------------------------------- Open screen

function FolderBrowser({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState<string | undefined>(undefined);
  const { data } = useQuery({ queryKey: ["browse", dir], queryFn: () => api.browseFs(dir) });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-700 bg-ink-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Choose a folder</span>
          <button onClick={onClose} className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400">close</button>
        </div>
        <div className="truncate border-b border-slate-800 px-3 py-1.5 font-mono text-[11px] text-sky-400">
          {data?.path ?? "…"}
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {data?.parent && (
            <button onClick={() => setDir(data.parent!)} className="block w-full px-3 py-1 text-left font-mono text-[11px] text-slate-400 hover:bg-slate-800/60">
              ../ (parent)
            </button>
          )}
          {(data?.dirs ?? []).map((d) => (
            <button
              key={d}
              onClick={() => setDir(`${data!.path.replace(/[\\/]+$/, "")}/${d}`)}
              className="block w-full truncate px-3 py-1 text-left font-mono text-[11px] text-slate-300 hover:bg-slate-800/60"
            >
              {d}/
            </button>
          ))}
          {data?.dirs.length === 0 && <div className="px-3 py-2 text-[11px] text-slate-600">no subfolders</div>}
        </div>
        <div className="border-t border-slate-800 p-2">
          <button
            onClick={() => data && onPick(data.path)}
            className="w-full rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}

function QuickModelPick({ repoPath }: { repoPath: string }) {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config", repoPath], queryFn: () => api.config(repoPath) });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (next: RepoConfig) => api.saveConfig(repoPath, next),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      void queryClient.invalidateQueries({ queryKey: ["config", repoPath] });
    },
  });
  if (!config) return null;
  const text = config.routing.providers.filter((p) => p.kind === "TextGeneration" && p.enabled);
  const decision = config.routing.providers.filter((p) => p.kind === "TypedDecision" && p.enabled);

  const assign = (kind: "TextGeneration" | "TypedDecision", providerId: string) => {
    const next = structuredClone(config);
    for (const [agentId, route] of Object.entries(next.routing.routes)) {
      const isDecision = [
        "risk-assessor",
        "synthesis",
        "minimality",
        "verifier",
        "principle-reviewer",
        "regression-sentinel",
      ].includes(agentId);
      if ((kind === "TypedDecision") === isDecision) route.providerId = providerId;
    }
    save.mutate(next);
  };

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Models</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="rounded border border-slate-800 bg-ink-800 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Generates code &amp; analysis</div>
          <select
            value={config.routing.routes.cartographer?.providerId ?? ""}
            onChange={(e) => assign("TextGeneration", e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-ink-950 px-2 py-1 text-xs text-slate-200"
          >
            {text.map((p) => (
              <option key={p.providerId} value={p.providerId}>{p.providerId} · {p.defaultModel}</option>
            ))}
          </select>
        </label>
        <label className="rounded border border-slate-800 bg-ink-800 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Makes decisions (risk, verdicts)</div>
          <select
            value={config.routing.routes["risk-assessor"]?.providerId ?? ""}
            onChange={(e) => assign("TypedDecision", e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-ink-950 px-2 py-1 text-xs text-slate-200"
          >
            {decision.map((p) => (
              <option key={p.providerId} value={p.providerId}>{p.providerId} · {p.defaultModel}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-1 text-[10px] text-slate-600">
        {saved ? "saved ✓" : "Per-agent routing lives in ⚙ Settings — this sets all generators / decision agents at once."}
      </p>
    </div>
  );
}

function OpenProject({ onOpened }: { onOpened: (repoPath: string, runId: string | null) => void }) {
  const [tab, setTab] = useState<"local" | "github">("local");
  const [repoPath, setRepoPath] = useState("");
  const [ghUrl, setGhUrl] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [mode, setMode] = useState("minimal");
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const queryClient = useQueryClient();
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const open = useMutation({
    mutationFn: (path: string) => api.openProject(path),
    onSuccess: (_data, path) => {
      setError(null);
      saveRecent(path);
    },
    onError: (err: Error) => setError(err.message),
  });
  const clone = useMutation({
    mutationFn: () => api.cloneGitHub(ghUrl.trim(), ghToken.trim()),
    onSuccess: (res) => {
      setError(null);
      saveRecent(res.repoPath);
      open.mutate(res.repoPath);
    },
    onError: (err: Error) => setError(err.message),
  });
  const start = useMutation({
    mutationFn: () => api.createRun(open.data?.repoPath ?? repoPath.trim(), mode),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      onOpened(open.data?.repoPath ?? repoPath.trim(), result.runId);
    },
    onError: (err: Error) => setError(err.message),
  });
  const openPrevious = useMutation({
    mutationFn: async (runId: string) => {
      await api.openRun(open.data!.repoPath, runId);
      return runId;
    },
    onSuccess: (runId) => onOpened(open.data!.repoPath, runId),
  });

  const opened = open.data;
  const recents = loadRecents().filter((r) => r !== (open.variables ?? ""));

  return (
    <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 px-6 py-10">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-600/10 blur-3xl" />
        <div className="absolute -right-16 bottom-20 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>
      <div>
        <h1 className="font-display text-4xl tracking-tight text-slate-100">
          Vibe<span className="text-sky-400">Fix</span>
        </h1>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
          Software-engineering control plane for vibe-coded repos.
          Understand → preserve → improve → verify → explain.
          <span className="text-emerald-400"> Nothing changes until you approve it.</span>
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-ink-900 p-5">
        <div className="mb-4 flex gap-1 rounded border border-slate-800 bg-ink-950 p-1">
          {(["local", "github"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-3 py-1 text-xs font-medium ${tab === t ? "bg-sky-700 text-white" : "text-slate-400"}`}
            >
              {t === "local" ? "Local project" : "GitHub repo"}
            </button>
          ))}
        </div>

        {tab === "local" ? (
          <div className="flex gap-2">
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="D:\\projects\\my-app"
              className="flex-1 rounded border border-slate-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-sky-500"
            />
            <button onClick={() => setBrowsing(true)} className="rounded bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600">
              Browse…
            </button>
            <button
              onClick={() => open.mutate(repoPath.trim())}
              disabled={!repoPath.trim() || open.isPending}
              className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:opacity-50"
            >
              Open
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              value={ghUrl}
              onChange={(e) => setGhUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="w-full rounded border border-slate-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-sky-500"
            />
            <input
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              placeholder="personal access token (optional — for private repos)"
              type="password"
              className="w-full rounded border border-slate-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-sky-500"
            />
            <button
              onClick={() => clone.mutate()}
              disabled={!ghUrl.trim() || clone.isPending}
              className="w-full rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:opacity-50"
            >
              {clone.isPending ? "Cloning…" : "Clone & open"}
            </button>
            <p className="text-[10px] text-slate-600">
              Cloned into VibeFix's central workspace — your project folder is never used for run data.
            </p>
          </div>
        )}

        {recents.length > 0 && tab === "local" && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {recents.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setRepoPath(r);
                  open.mutate(r);
                }}
                className="rounded bg-ink-800 px-2 py-1 font-mono text-[10px] text-slate-400 hover:bg-slate-800"
              >
                {r}
              </button>
            ))}
          </div>
        )}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        {opened && (
          <div className="mt-4 space-y-4">
            <div className="rounded border border-emerald-800/50 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
              ✓ {opened.repoPath}
            </div>

            <QuickModelPick repoPath={opened.repoPath} />

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Refactoring mode</div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: "minimal", label: "Minimal", desc: "smallest safe diffs" },
                  { id: "architecture", label: "Architecture", desc: "boundary changes" },
                  { id: "modernization", label: "Modernization", desc: "larger moves" },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    className={`rounded border px-3 py-2 text-left ${mode === m.id ? "border-sky-500 bg-sky-950/30" : "border-slate-800 bg-ink-800"}`}
                  >
                    <div className="text-xs font-semibold text-slate-200">{m.label}</div>
                    <div className="text-[10px] text-slate-500">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => start.mutate()}
              disabled={start.isPending}
              className="w-full rounded bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {start.isPending ? "Starting…" : "Analyze codebase →"}
            </button>

            {opened.runs.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Previous runs</div>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {opened.runs.map((r) => (
                    <button
                      key={r.runId}
                      onClick={() => openPrevious.mutate(r.runId)}
                      className="flex w-full items-center justify-between rounded border border-slate-800 bg-ink-800 px-3 py-1.5 text-left hover:bg-slate-800"
                    >
                      <code className="text-[11px] text-slate-400">{r.runId}</code>
                      <span className="text-[10px] text-slate-500">
                        {new Date(r.createdAt).toLocaleString()} · {r.phase} · {r.status}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setShowSettings((v) => !v)}
              className="w-full rounded border border-slate-700 px-4 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              {showSettings ? "Hide models & cost limits" : "⚙ Advanced: per-agent models & cost limits"}
            </button>
            {showSettings && agents && (
              <div className="h-[26rem]">
                <SettingsPanel repoPath={opened.repoPath} agents={agents} onClose={() => setShowSettings(false)} />
              </div>
            )}
          </div>
        )}
      </div>

      {browsing && (
        <FolderBrowser
          onPick={(p) => {
            setBrowsing(false);
            setRepoPath(p);
            open.mutate(p);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Run screen

const NAV: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Pipeline" },
  { id: "health", label: "Health" },
  { id: "codebase", label: "Codebase" },
  { id: "findings", label: "Findings" },
  { id: "checkpoint", label: "Checkpoint" },
  { id: "execution", label: "Execution" },
  { id: "report", label: "Report" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
];

function RunScreen({
  repoPath,
  runId,
  onSwitchRun,
}: {
  repoPath: string;
  runId: string;
  onSwitchRun: (runId: string) => void;
}) {
  const { runState, connect, usage } = useRunStore();
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const { data: config } = useQuery({ queryKey: ["config", repoPath], queryFn: () => api.config(repoPath) });
  const [view, setView] = useState<View>("overview");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    connect(runId);
    return () => useRunStore.getState().disconnect();
  }, [runId, connect]);

  // Polling fallback: even if the WebSocket drops, the UI re-syncs state,
  // usage AND the event stream (the REST log reads from disk too, so this
  // also works for runs whose runtime is no longer live in the server).
  useEffect(() => {
    const timer = setInterval(() => {
      void api.run(runId).then((s) => useRunStore.getState().applySnapshot(s)).catch((err) => {
        console.warn(`[VibeFix] Failed to sync run state: ${err instanceof Error ? err.message : String(err)}`);
      });
      void api.usage(runId).then((u) => useRunStore.getState().applyUsage(u)).catch((err) => {
        console.warn(`[VibeFix] Failed to sync usage: ${err instanceof Error ? err.message : String(err)}`);
      });
      void useRunStore.getState().syncEvents();
    }, 3_000);
    return () => clearInterval(timer);
  }, [runId]);

  const phase = runState?.phase ?? "init";
  const status = runState?.status ?? "running";
  const tokens = runState?.budget.tokensSpent ?? usage.total;
  const tokenCap = config?.routing.budgets.runMaxTokens;
  const overWarn = tokenCap !== undefined && config !== undefined && tokens >= tokenCap * config.routing.budgets.warnFraction;

  const backToOpen = () => {
    useRunStore.getState().disconnect();
    window.location.reload();
  };

  const autoView: View | null =
    phase === "awaitingApproval" ? "checkpoint" : phase === "execution" || phase === "harness" ? "execution" : phase === "report" || phase === "completed" ? "report" : null;
  const activeView = view;
  const banner = phase === "awaitingApproval";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-ink-900 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold">
            Vibe<span className="text-sky-400">Fix</span>
          </span>
          <code className="max-w-[280px] truncate rounded bg-ink-800 px-2 py-0.5 text-[11px] text-slate-400" title={repoPath}>
            {repoPath}
          </code>
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
              status === "awaitingApproval"
                ? "bg-violet-900/60 text-violet-300"
                : status === "completed"
                  ? "bg-emerald-900/60 text-emerald-300"
                  : status === "aborted" || status === "failed"
                    ? "bg-red-900/60 text-red-300"
                    : "bg-sky-900/60 text-sky-300"
            }`}
          >
            {phase} · {status}
          </span>
          {autoView && autoView !== activeView && (
            <button onClick={() => setView(autoView)} className="rounded bg-violet-800 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-700">
              action needed → {autoView}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className={overWarn ? "text-yellow-400" : ""}>
            tokens {tokens.toLocaleString()}{tokenCap !== undefined ? ` / ${tokenCap.toLocaleString()}` : ""}
          </span>
          <span>committed {runState?.budget.changesCommitted ?? 0}</span>
          <button
            onClick={() => void api.abort(runId).then(() => queryClient.invalidateQueries())}
            className="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
          >
            Abort
          </button>
          <button onClick={backToOpen} className="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700">
            Close
          </button>
        </div>
      </header>

      {runState?.error && (
        <div className="border-b border-red-900 bg-red-950/40 px-4 py-1.5 text-xs text-red-300">
          ⚠ {runState.error}
        </div>
      )}
      {banner && (
        <div className="border-b border-violet-900 bg-violet-950/40 px-4 py-1.5 text-xs text-violet-300">
          Checkpoint: review the backlog before any code is touched — VibeFix never changes your codebase without your approval.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Organized step navigation */}
        <nav className="flex w-44 shrink-0 flex-col border-r border-slate-800 bg-ink-900 p-2">
          {NAV.map((item) => {
            const highlight = autoView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`rounded px-3 py-1.5 text-left text-xs ${
                  activeView === item.id
                    ? "bg-sky-800 text-white"
                    : highlight
                      ? "bg-violet-900/40 text-violet-200"
                      : "text-slate-400 hover:bg-slate-800"
                }`}
              >
                {item.label}
                {highlight && <span className="ml-1 text-[9px]">●</span>}
              </button>
            );
          })}
          <div className="mt-auto space-y-1 px-2 text-[10px] text-slate-600">
            <div>run <code>{runId.slice(0, 16)}…</code></div>
            <div>started {runState ? new Date(runState.createdAt).toLocaleTimeString() : "…"}</div>
          </div>
        </nav>

        <main className="relative grid flex-1 grid-cols-[1fr_340px] gap-3 overflow-hidden p-3">
          <div className="min-h-0 overflow-hidden">
            {activeView === "overview" && (
              <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
                <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Agent orchestration — click any agent for details
                </div>
                <div className="relative h-[calc(100%-33px)]">
                  {agents ? (
                    <AgentGraph
                      agents={agents}
                      runState={runState}
                      usageByAgent={usage.byAgent}
                      onAgentClick={(id) => setSelectedAgent(id)}
                    />
                  ) : (
                    <div className="p-3 text-xs text-slate-600">loading graph…</div>
                  )}
                  {selectedAgent && agents && (
                    <AgentDetail
                      def={agents.find((a) => a.agentId === selectedAgent)!}
                      runState={runState}
                      onClose={() => setSelectedAgent(null)}
                    />
                  )}
                </div>
              </div>
            )}
            {activeView === "health" && <HealthPanel runId={runId} />}
            {activeView === "codebase" && <CodebasePanel repoPath={repoPath} runId={runId} />}
            {activeView === "findings" && <FindingsPanel runId={runId} />}
            {activeView === "checkpoint" && (
              <CheckpointPanel runId={runId} onDone={() => void queryClient.invalidateQueries()} />
            )}
            {activeView === "execution" && <ExecutionPanel runId={runId} />}
            {activeView === "report" && <ReportPanel runId={runId} />}
            {activeView === "runs" && (
              <RunsPanel
                repoPath={repoPath}
                currentRunId={runId}
                onOpened={(id) => {
                  onSwitchRun(id);
                  void queryClient.invalidateQueries();
                }}
              />
            )}
            {activeView === "settings" && agents && (
              <SettingsPanel repoPath={repoPath} agents={agents} onClose={() => setView("overview")} />
            )}
          </div>
          <EventStream />
        </main>
      </div>
    </div>
  );
}

function RunsPanel({ repoPath, currentRunId, onOpened }: { repoPath: string; currentRunId: string; onOpened: (runId: string) => void }) {
  const { data } = useQuery({ queryKey: ["runs", repoPath], queryFn: () => api.openProject(repoPath), refetchInterval: 5_000 });
  const open = useMutation({
    mutationFn: async (runId: string) => {
      await api.openRun(repoPath, runId);
      return runId;
    },
    onSuccess: (runId) => onOpened(runId),
  });
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Previous runs
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {(data?.runs ?? []).map((r) => (
          <div key={r.runId} className="mb-1.5 flex items-center justify-between rounded border border-slate-800 bg-ink-800 px-3 py-2">
            <div>
              <code className="text-[11px] text-slate-300">{r.runId}</code>
              {r.runId === currentRunId && <span className="ml-2 text-[9px] text-sky-400">current</span>}
              <div className="text-[10px] text-slate-500">{new Date(r.createdAt).toLocaleString()} · {r.phase} · {r.status}</div>
            </div>
            {r.status === "awaitingApproval" || r.status === "running" || r.status === "paused" ? (
              <button
                onClick={() => open.mutate(r.runId)}
                className="rounded bg-violet-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-600"
              >
                Resume
              </button>
            ) : (
              <button
                onClick={() => open.mutate(r.runId)}
                className="rounded bg-slate-700 px-3 py-1 text-[11px] text-white hover:bg-slate-600"
              >
                View
              </button>
            )}
          </div>
        ))}
        {(data?.runs ?? []).length === 0 && <div className="p-3 text-xs text-slate-600">no runs yet</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("open");
  const [active, setActive] = useState<{ repoPath: string; runId: string | null } | null>(null);

  if (screen === "open") {
    return (
      <OpenProject
        onOpened={(repoPath, runId) => {
          if (runId) {
            setActive({ repoPath, runId });
            setScreen("run");
          }
        }}
      />
    );
  }
  return active?.runId ? (
    <RunScreen
      repoPath={active.repoPath}
      runId={active.runId}
      onSwitchRun={(nextId) => setActive({ repoPath: active.repoPath, runId: nextId })}
    />
  ) : null;
}
