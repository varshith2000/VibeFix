import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Codebase viewer: what exists in the target repo — tree, stats, file contents. */
export function CodebasePanel({ repoPath }: { repoPath: string }) {
  const { data } = useQuery({ queryKey: ["tree", repoPath], queryFn: () => api.tree(repoPath) });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data: file } = useQuery({
    queryKey: ["file", repoPath, selected],
    queryFn: () => api.file(repoPath, selected!),
    enabled: selected !== null,
  });

  const files = useMemo(() => {
    const all = data?.files ?? [];
    if (!filter.trim()) return all.slice(0, 800);
    const f = filter.toLowerCase();
    return all.filter((x) => x.path.toLowerCase().includes(f)).slice(0, 800);
  }, [data, filter]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-800 bg-ink-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Codebase</span>
        {data && (
          <span className="text-[10px] text-slate-500">
            {data.summary.totalLoc.toLocaleString()} loc ·{" "}
            {data.summary.languages.slice(0, 3).map((l) => `${l.language} (${l.loc.toLocaleString()})`).join(" · ")}
            {data.summary.frameworks.length > 0 && ` · ${data.summary.frameworks.join(", ")}`}
          </span>
        )}
      </div>
      {data && data.summary.entrypoints.length > 0 && (
        <div className="border-b border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
          entrypoints: {data.summary.entrypoints.map((e) => <code key={e} className="mr-2 text-sky-400">{e}</code>)}
        </div>
      )}
      <div className="grid flex-1 grid-cols-[300px_1fr] overflow-hidden">
        <div className="flex flex-col overflow-hidden border-r border-slate-800">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter files…"
            className="border-b border-slate-800 bg-ink-950 px-3 py-1.5 text-[11px] text-slate-200 outline-none"
          />
          <div className="flex-1 overflow-y-auto py-1 font-mono text-[11px]">
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelected(f.path)}
                className={`block w-full truncate px-3 py-0.5 text-left hover:bg-slate-800/60 ${
                  selected === f.path ? "bg-sky-900/40 text-sky-200" : "text-slate-400"
                }`}
                title={f.path}
              >
                {f.path}
                <span className="ml-1 text-slate-600">{f.loc}L</span>
              </button>
            ))}
            {files.length === 0 && <div className="px-3 py-2 text-slate-600">no files match</div>}
          </div>
        </div>
        <div className="overflow-auto bg-ink-950">
          {file ? (
            <pre className="p-3 font-mono text-[11px] leading-4 text-slate-300">
              {file.truncated ? "(file truncated)" : file.content}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-600">
              select a file to view it
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
