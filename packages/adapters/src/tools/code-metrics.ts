import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileEntry } from "../capabilities.js";

export interface FunctionMetric {
  /** Best-effort function name (regex heuristic). */
  name: string | null;
  file: string;
  startLine: number;
  lines: number;
  maxDepth: number;
}

export interface DuplicationCluster {
  /** Normalized duplicated snippet (first occurrence text). */
  snippet: string;
  lines: number;
  occurrences: Array<{ file: string; startLine: number }>;
}

export interface FileMetrics {
  functions: FunctionMetric[];
  duplications: DuplicationCluster[];
  longFiles: Array<{ file: string; loc: number }>;
  deadCodeCandidates: Array<{ file: string; startLine: number; hint: string }>;
}

const FUNCTION_START =
  /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|def\s+([A-Za-z_][\w]*)\s*\()/g;

/** Regex-heuristic code metrics. Upgradable via tree-sitter/sidecar seam later. */
export async function computeMetrics(root: string, files: FileEntry[]): Promise<FileMetrics> {
  const functions: FunctionMetric[] = [];
  const duplications: DuplicationCluster[] = [];
  const longFiles: Array<{ file: string; loc: number }> = [];
  const deadCodeCandidates: Array<{ file: string; startLine: number; hint: string }> = [];
  const windowMap = new Map<string, Array<{ file: string; startLine: number }>>();

  const codeFiles = files.filter((f) =>
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(path.extname(f.path).toLowerCase()),
  );

  for (const file of codeFiles) {
    if (file.loc > 4000) longFiles.push({ file: file.path, loc: file.loc });
    let content: string;
    try {
      content = await fs.readFile(path.join(root, ...file.path.split("/")), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");

    // Function length + nesting depth via brace matching (JS) / indentation (PY).
    FUNCTION_START.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FUNCTION_START.exec(content)) !== null) {
      const name = m[1] ?? m[2] ?? m[3] ?? null;
      const startLine = content.slice(0, m.index).split("\n").length;
      const bodyLines = measureBody(lines, startLine - 1);
      if (bodyLines >= 30) {
        functions.push({ name, file: file.path, startLine, lines: bodyLines, maxDepth: measureDepth(lines, startLine - 1) });
      }
    }

    // Comment-marked dead code hints.
    lines.forEach((line, i) => {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
        deadCodeCandidates.push({ file: file.path, startLine: i + 1, hint: line.trim().slice(0, 120) });
      }
    });

    // Duplication: normalized 6-line windows hashed.
    for (let i = 0; i + 6 <= lines.length; i++) {
      const window = lines
        .slice(i, i + 6)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (window.length < 4) continue; // mostly blank / boilerplate
      const key = window.join("\n");
      if (key.length < 60) continue; // trivial snippet
      const list = windowMap.get(key) ?? [];
      list.push({ file: file.path, startLine: i + 1 });
      windowMap.set(key, list);
    }

    // Single-line clones: identical non-trivial lines repeated across the repo
    // (the classic vibe-code copy-paste of one "clever" expression).
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.length < 50) continue;
      if (/^(import|\/\/|\/\*|\*|#)/.test(trimmed)) continue;
      const key = `L:${trimmed}`;
      const list = windowMap.get(key) ?? [];
      list.push({ file: file.path, startLine: i + 1 });
      windowMap.set(key, list);
    }
  }

  for (const [key, occurrences] of windowMap) {
    const isSingleLine = key.startsWith("L:");
    const unique = dedupeClose(occurrences);
    if (unique.length >= 2) {
      const snippet = isSingleLine ? key.slice(2) : key;
      duplications.push({ snippet: snippet.slice(0, 400), lines: snippet.split("\n").length, occurrences: unique });
    }
  }
  duplications.sort((a, b) => b.occurrences.length - a.occurrences.length);

  return { functions, duplications, longFiles, deadCodeCandidates };
}

function measureBody(lines: string[], startIdx: number): number {
  let depth = 0;
  let seen = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{" || ch === "(") {
        depth++;
        seen = true;
      } else if (ch === "}" || ch === ")") {
        depth--;
      }
    }
    if (seen && depth <= 0) return i - startIdx + 1;
  }
  return lines.length - startIdx;
}

function measureDepth(lines: string[], startIdx: number): number {
  let depth = 0;
  let maxDepth = 0;
  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
      } else if (ch === "}") depth--;
    }
    if (depth <= 0 && i > startIdx) break;
  }
  return maxDepth;
}

/** Drop occurrences in the same file within 6 lines of each other (window overlap). */
function dedupeClose(occurrences: Array<{ file: string; startLine: number }>): Array<{ file: string; startLine: number }> {
  const sorted = [...occurrences].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  const out: typeof sorted = [];
  for (const occ of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.file === occ.file && occ.startLine - prev.startLine < 6) continue;
    out.push(occ);
  }
  return out;
}
