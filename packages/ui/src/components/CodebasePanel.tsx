import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { DiffView, diffForFile, filesInDiff } from "./DiffView";

/**
 * Codebase + live changes. Two views: the repo browser (with changed files
 * annotated) and the change ledger — every modification the agents attempt,
 * rendered as an editor-style diff.
 */
export function CodebasePanel({ repoPath, runId }: { repoPath: string; runId: string }) {
  const [tab, setTab] = useState<"files" | "changes">("files");
  const { data } = useQuery({ queryKey: ["tree", repoPath], queryFn: () => api.tree(repoPath) });
  const { data: ledger } = useQuery({
    queryKey: ["ledger", runId],
    queryFn: () => api.ledger(runId),
    refetchInterval: 3_000,
  });
  const entries = ledger?.entries ?? [];
  const changedFiles = useMemo(() => {
    const set = new Map<string, { verdict: string; proposalId: string }>();
    for (const e of [...entries].reverse()) {
      for (const f of filesInDiff(e.diff)) {
        if (!set.has(f)) set.set(f, { verdict: e.verdict, proposalId: e.proposalId });
      }
    }
    return set;
  }, [entries]);

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const { data: file } = useQuery({
    queryKey: ["file", repoPath, selected],
    queryFn: () => api.file(repoPath, selected!),
    enabled: selected !== null && tab === "files",
  });

  const files = useMemo(() => {
    const all = data?.files ?? [];
    if (!filter.trim()) return all.slice(0, 800);
    const f = filter.toLowerCase();
    return all.filter((x) => x.path.toLowerCase().includes(f)).slice(0, 800);
  }, [data, filter]);

  const activeEntry = entries.find((e) => e.ledgerId === selectedEntry) ?? null;
  const selectedDiff = selected ? (changedFiles.get(selected) ? latestDiffFor(entries, selected) : "") : "";

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Codebase</span>
          <div className="flex rounded border border-slate-800 bg-ink-950 p-0.5">
            <button
              onClick={() => setTab("files")}
              className={`rounded px-2 py-0.5 text-[10px] ${tab === "files" ? "bg-sky-800 text-white" : "text-slate-400"}`}
            >
              files
            </button>
            <button
              onClick={() => setTab("changes")}
              className={`rounded px-2 py-0.5 text-[10px] ${tab === "changes" ? "bg-sky-800 text-white" : "text-slate-400"}`}
            >
              changes{entries.length > 0 ? ` (${entries.length})` : ""}
            </button>
          </div>
        </div>
        {tab === "files" && data && (
          <span className="text-[10px] text-slate-500">
            {data.summary.totalLoc.toLocaleString()} loc ·{" "}
            {data.summary.languages.slice(0, 3).map((l) => `${l.language} (${l.loc.toLocaleString()})`).join(" · ")}
            {data.summary.frameworks.length > 0 && ` · ${data.summary.frameworks.join(", ")}`}
            {changedFiles.size > 0 && ` · ${changedFiles.size} file(s) changed by agents`}
          </span>
        )}
      </div>

      {tab === "changes" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
          <div className="flex flex-col overflow-hidden border-r border-slate-800">
            <div className="border-b border-slate-800 px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
              change ledger — every attempted modification
            </div>
            <div className="flex-1 overflow-y-auto p-1">
              {entries.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-slate-600">
                  no changes attempted yet — the execution phase produces entries here
                </div>
              )}
              {[...entries].reverse().map((e) => {
                const files = filesInDiff(e.diff);
                return (
                  <button
                    key={e.ledgerId}
                    onClick={() => setSelectedEntry(e.ledgerId)}
                    className={`mb-1 block w-full rounded border px-2.5 py-1.5 text-left ${
                      selectedEntry === e.ledgerId
                        ? "border-sky-600 bg-sky-900/30"
                        : "border-slate-800 bg-ink-800 hover:bg-slate-800/60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10px] text-slate-300">{e.proposalId}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                          e.verdict === "passed"
                            ? "bg-emerald-900/60 text-emerald-300"
                            : e.verdict === "deferred"
                              ? "bg-yellow-900/60 text-yellow-300"
                              : "bg-red-900/60 text-red-300"
                        }`}
                      >
                        {e.verdict}
                      </span>
                    </div>
                    <div className="text-[9px] text-slate-500">
                      attempt {e.attempt + 1} · {files.length} file(s) · {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                      {e.committedRef ? " · committed ✓" : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden">
            {activeEntry ? (
              <>
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
                  <span className="font-mono text-[10px] text-slate-400">{activeEntry.proposalId}</span>
                  {activeEntry.verifierNotes.length > 0 && (
                    <span className="truncate text-[10px] text-orange-400/90" title={activeEntry.verifierNotes.join("\n")}>
                      {activeEntry.verifierNotes[0]}
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <DiffView diff={activeEntry.diff} />
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-600">
                select a change to see the diff
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {data && data.summary.entrypoints.length > 0 && (
            <div className="border-b border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
              entrypoints: {data.summary.entrypoints.map((e) => <code key={e} className="mr-2 text-sky-400">{e}</code>)}
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr] overflow-hidden">
            <div className="flex flex-col overflow-hidden border-r border-slate-800">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter files…"
                className="border-b border-slate-800 bg-ink-950 px-3 py-1.5 text-[11px] text-slate-200 outline-none"
              />
              <div className="flex-1 overflow-y-auto py-1 font-mono text-[11px]">
                {files.map((f) => {
                  const change = changedFiles.get(f.path);
                  return (
                    <button
                      key={f.path}
                      onClick={() => {
                        setSelected(f.path);
                        setSelectedEntry(null);
                      }}
                      className={`block w-full truncate px-3 py-0.5 text-left hover:bg-slate-800/60 ${
                        selected === f.path ? "bg-sky-900/40 text-sky-200" : "text-slate-400"
                      }`}
                      title={f.path}
                    >
                      {change && (
                        <span
                          className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                            change.verdict === "passed" ? "bg-emerald-400" : "bg-red-400"
                          }`}
                          title={`${change.verdict} by ${change.proposalId}`}
                        />
                      )}
                      {f.path}
                      <span className="ml-1 text-slate-600">{f.loc}L</span>
                    </button>
                  );
                })}
                {files.length === 0 && <div className="px-3 py-2 text-slate-600">no files match</div>}
              </div>
            </div>
            <div className="flex min-h-0 flex-col overflow-hidden">
              {selected && selectedDiff ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="border-b border-slate-800 bg-emerald-950/20 px-3 py-1 text-[10px] text-emerald-300">
                    this file was modified by the agents — showing the diff (editor view shows the applied result)
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <DiffView diff={selectedDiff} />
                  </div>
                </div>
              ) : file ? (
                <div className="min-h-0 flex-1 overflow-auto bg-ink-950">
                  <pre className="p-3 font-mono text-[11px] leading-4 text-slate-300">
                    {file.truncated ? "(file truncated)" : file.content}
                  </pre>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-600">
                  select a file to view it
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Newest ledger entry that touched this file. */
function latestDiffFor(entries: Array<{ diff: string }>, filePath: string): string {
  for (const e of [...entries].reverse()) {
    const d = diffForFile(e.diff, filePath);
    if (d) return d;
  }
  return "";
}
