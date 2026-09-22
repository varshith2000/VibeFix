/**
 * Unified-diff renderer: editor-style line coloring for added/removed/context
 * lines, file headers, hunk headers. Pure string parsing — no dependencies.
 */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const fileHeaderIndexes = lines
    .map((l, i) => (l.startsWith("diff --git") || l.startsWith("--- ") || l.startsWith("+++ ") ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="overflow-auto bg-ink-950 font-mono text-[11px] leading-4">
      {lines.map((line, i) => {
        if (line.startsWith("diff --git")) {
          const file = line.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
          return (
            <div key={i} className="mt-2 border-t border-slate-800 bg-slate-800/60 px-3 py-1 font-semibold text-slate-200 first:mt-0">
              {file}
            </div>
          );
        }
        if (line.startsWith("--- ") || line.startsWith("+++ ")) {
          return (
            <div key={i} className="bg-slate-800/30 px-3 py-0.5 text-slate-400">
              {line}
            </div>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <div key={i} className="bg-sky-950/40 px-3 py-0.5 text-sky-400">
              {line}
            </div>
          );
        }
        if (line.startsWith("+")) {
          return (
            <div key={i} className="whitespace-pre-wrap bg-emerald-950/40 px-3 py-0.5 text-emerald-300">
              {line}
            </div>
          );
        }
        if (line.startsWith("-")) {
          return (
            <div key={i} className="whitespace-pre-wrap bg-red-950/40 px-3 py-0.5 text-red-300">
              {line}
            </div>
          );
        }
        if (fileHeaderIndexes.includes(i)) {
          return (
            <div key={i} className="px-3 py-0.5 text-slate-500">
              {line}
            </div>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap px-3 py-0.5 text-slate-500">
            {line || " "}
          </div>
        );
      })}
      {lines.length === 0 && <div className="p-3 text-slate-600">(empty diff)</div>}
    </div>
  );
}

/** Extract the per-file chunk of a unified diff (empty string if not present). */
export function diffForFile(diff: string, filePath: string): string {
  const lines = diff.split("\n");
  const chunks: Array<{ file: string; lines: string[] }> = [];
  let current: { file: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const file = line.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
      current = { file, lines: [line] };
      chunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return chunks.find((c) => c.file === filePath)?.lines.join("\n") ?? "";
}

/** All files touched by a unified diff. */
export function filesInDiff(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) out.push(line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"));
  }
  return out;
}
