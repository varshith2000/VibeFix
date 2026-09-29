import path from "node:path";
import { promises as fs } from "node:fs";
import ts from "typescript";
import type { FileEntry } from "../capabilities.js";

export interface FunctionMetric {
  /** Best-effort function name. */
  name: string | null;
  file: string;
  startLine: number;
  lines: number;
  maxDepth: number;
  /**
   * How this function was measured: "ts-ast" (TypeScript compiler AST —
   * accurate for TS/JS) or "regex-heuristic" (fallback — known to mismeasure
   * nested calls, object literals, template strings, comments with braces).
   */
  analyzer: "ts-ast" | "regex-heuristic";
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
  /** Which analyzer handled the TS/JS files (Python is always regex-based). */
  analyzer: "ts-ast" | "ts-ast+regex-fallback" | "regex-heuristic";
}

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const FUNCTION_START =
  /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|def\s+([A-Za-z_][\w]*)\s*\()/g;

/**
 * Code metrics for the Smell Detector. TS/JS files are measured through the
 * TypeScript compiler AST (function spans survive braces in strings,
 * template literals, comments, regexes and JSX); the old regex scanner
 * remains as an explicitly low-confidence fallback, and every function
 * records which analyzer produced its numbers.
 */
export async function computeMetrics(root: string, files: FileEntry[]): Promise<FileMetrics> {
  const functions: FunctionMetric[] = [];
  const duplications: DuplicationCluster[] = [];
  const longFiles: Array<{ file: string; loc: number }> = [];
  const deadCodeCandidates: Array<{ file: string; startLine: number; hint: string }> = [];
  const windowMap = new Map<string, Array<{ file: string; startLine: number }>>();
  let usedAst = false;
  let usedRegexFallback = false;

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
    const ext = path.extname(file.path).toLowerCase();
    const isTsFamily = TS_EXTS.has(ext);

    let fileFunctions: Array<Omit<FunctionMetric, "file">> = [];
    if (isTsFamily) {
      try {
        fileFunctions = measureTsFunctions(content, file.path);
        usedAst = true;
      } catch {
        // Parser refused the file (exotic syntax, size) — degrade loudly.
        fileFunctions = measureRegexFunctions(content, lines);
        usedRegexFallback = true;
      }
    } else {
      // Python (and anything else): indentation heuristics only.
      fileFunctions = measureRegexFunctions(content, lines);
    }
    for (const fn of fileFunctions) {
      if (fn.lines >= 30) functions.push({ ...fn, file: file.path });
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

  return {
    functions,
    duplications,
    longFiles,
    deadCodeCandidates,
    analyzer: usedAst && !usedRegexFallback ? "ts-ast" : usedAst ? "ts-ast+regex-fallback" : "regex-heuristic",
  };
}

// ------------------------------------------------------------ TypeScript AST

/** True for every node kind that declares a function-ish body. */
function isFunctionLike(node: ts.Node): node is
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function functionName(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(sf);
  }
  // Arrow / function expression assigned to a variable or property.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** Max nesting depth inside the function (function body block = 1). */
function nestingDepth(fn: ts.Node): number {
  let max = 0;
  const walk = (node: ts.Node, depth: number): void => {
    if (ts.isBlock(node)) {
      const next = depth + 1;
      max = Math.max(max, next);
      for (const stmt of node.statements) walk(stmt, next);
      return;
    }
    ts.forEachChild(node, (child) => walk(child, depth));
  };
  ts.forEachChild(fn, (child) => walk(child, 0));
  return max;
}

/** AST-based function spans — immune to braces inside strings/comments/JSX. */
export function measureTsFunctions(content: string, fileName: string): Array<Omit<FunctionMetric, "file">> {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const out: Array<Omit<FunctionMetric, "file">> = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(node.end);
      out.push({
        name: functionName(node, sf),
        startLine: start.line + 1,
        lines: end.line - start.line + 1,
        maxDepth: nestingDepth(node),
        analyzer: "ts-ast",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// --------------------------------------------------------- regex fallback

/** Old brace/indent heuristic — kept for Python and as a labeled fallback. */
function measureRegexFunctions(content: string, lines: string[]): Array<Omit<FunctionMetric, "file">> {
  const out: Array<Omit<FunctionMetric, "file">> = [];
  FUNCTION_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION_START.exec(content)) !== null) {
    const name = m[1] ?? m[2] ?? m[3] ?? null;
    const startLine = content.slice(0, m.index).split("\n").length;
    const bodyLines = measureBody(lines, startLine - 1);
    if (bodyLines >= 30) {
      out.push({
        name,
        startLine,
        lines: bodyLines,
        maxDepth: measureDepth(lines, startLine - 1),
        analyzer: "regex-heuristic",
      });
    }
  }
  return out;
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
