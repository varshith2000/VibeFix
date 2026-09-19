import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useRunStore } from "./store";
import { AgentGraph } from "./components/AgentGraph";
import { EventStream } from "./components/EventStream";
import { CheckpointPanel, ExecutionPanel, FindingsPanel, ReportPanel } from "./components/panels";
import { SettingsPanel } from "./components/SettingsPanel";

type Screen = "open" | "run";

function OpenProject({ onOpened }: { onOpened: (repoPath: string, runId: string) => void }) {
  const [repoPath, setRepoPath] = useState("");
  const [mode, setMode] = useState("minimal");
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const queryClient = useQueryClient();
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const open = useMutation({
    mutationFn: () => api.openProject(repoPath.trim()),
    onSuccess: () => setError(null),
    onError: (err: Error) => setError(err.message),
  });

  const start = useMutation({
    mutationFn: () => api.createRun(repoPath.trim(), mode),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      onOpened(repoPath.trim(), result.runId);
    },
    onError: (err: Error) => setError(err.message),
  });

  const opened = open.data;

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-100">
          Vibe<span className="text-sky-400">Fix</span>
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          The multi-agent refactoring control plane. Understand → preserve → improve → verify → explain.
          Nothing is touched until you approve it.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-ink-900 p-5">
        <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Path to your project (a git repository)
        </label>
        <div className="mt-2 flex gap-2">
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="D:\\projects\\my-vibe-coded-app"
            className="flex-1 rounded border border-slate-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-sky-500"
          />
          <button
            onClick={() => open.mutate()}
            disabled={!repoPath.trim() || open.isPending}
            className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:opacity-50"
          >
            Open
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        {opened && (
          <div className="mt-4 space-y-4">
            <div className="rounded border border-emerald-800/50 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
              ✓ {opened.repoPath} — {opened.runs.length} previous run(s)
            </div>

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

            <button
              onClick={() => setShowSettings((v) => !v)}
              className="w-full rounded border border-slate-700 px-4 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              {showSettings ? "Hide models & cost limits" : "⚙ Configure models & cost limits"}
            </button>
            {showSettings && agents && (
              <div className="h-[26rem]">
                <SettingsPanel repoPath={opened.repoPath} agents={agents} onClose={() => setShowSettings(false)} />
              </div>
            )}
          </div>
        )}
      </div>

      <p className="text-center text-[11px] text-slate-600">
        Baseline runs use built-in mock providers — zero API keys, zero cost. Configure Anthropic / OpenAI / Ollama / Jev
        per agent via <code>.vibefix/config.json</code>.
      </p>
    </div>
  );
}

function RunScreen({ repoPath, runId }: { repoPath: string; runId: string }) {
  const { runState, connect } = useRunStore();
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const { data: config } = useQuery({ queryKey: ["config", repoPath], queryFn: () => api.config(repoPath) });
  const [showSettings, setShowSettings] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    connect(runId);
    return () => useRunStore.getState().disconnect();
  }, [runId, connect]);

  const phase = runState?.phase ?? "init";
  const status = runState?.status ?? "running";
  const tokens = runState?.budget.tokensSpent ?? 0;
  const tokenCap = config?.routing.budgets.runMaxTokens;
  const overWarn = tokenCap !== undefined && config !== undefined && tokens >= tokenCap * config.routing.budgets.warnFraction;

  const backToOpen = () => {
    useRunStore.getState().disconnect();
    window.location.reload();
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-ink-900 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold">
            Vibe<span className="text-sky-400">Fix</span>
          </span>
          <code className="rounded bg-ink-800 px-2 py-0.5 text-[11px] text-slate-400">{repoPath}</code>
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
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className={overWarn ? "text-yellow-400" : ""}>
            tokens {tokens.toLocaleString()}{tokenCap !== undefined ? ` / ${tokenCap.toLocaleString()}` : ""}
          </span>
          <span>committed {runState?.budget.changesCommitted ?? 0}</span>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={`rounded px-2 py-1 ${showSettings ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            title="Switch models / adjust cost limits — applies live"
          >
            ⚙ Models
          </button>
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

      <main className="relative grid flex-1 grid-cols-[1fr_380px] gap-3 overflow-hidden p-3">
        <div className="grid grid-rows-[1.6fr_1fr] gap-3 overflow-hidden">
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Agent graph
            </div>
            <div className="h-[calc(100%-33px)]">
              {agents ? <AgentGraph agents={agents} runState={runState} /> : <div className="p-3 text-xs text-slate-600">loading graph…</div>}
            </div>
          </div>
          <div className="min-h-0 overflow-hidden">
            {showSettings && agents ? (
              <SettingsPanel repoPath={repoPath} agents={agents} onClose={() => setShowSettings(false)} />
            ) : phase === "awaitingApproval" ? (
              <CheckpointPanel
                runId={runId}
                onDone={() => void queryClient.invalidateQueries()}
              />
            ) : phase === "execution" || phase === "harness" ? (
              <ExecutionPanel runId={runId} />
            ) : phase === "report" || phase === "completed" ? (
              <ReportPanel runId={runId} />
            ) : (
              <FindingsPanel runId={runId} />
            )}
          </div>
        </div>
        <EventStream />
      </main>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("open");
  const [active, setActive] = useState<{ repoPath: string; runId: string } | null>(null);

  if (screen === "open") {
    return <OpenProject onOpened={(repoPath, runId) => { setActive({ repoPath, runId }); setScreen("run"); }} />;
  }
  return active ? <RunScreen repoPath={active.repoPath} runId={active.runId} /> : null;
}
