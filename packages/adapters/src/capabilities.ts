/**
 * Normalized capabilities agents receive. An agent never learns "this is
 * Next.js" — it gets these framework-agnostic functions backed by adapters.
 */

export interface FileEntry {
  /** POSIX repo-relative path. */
  path: string;
  sizeBytes: number;
  language: string | null;
  loc: number;
}

export interface RepoFactsInput {
  root: string;
}

export interface LanguageDetection {
  language: string;
  fileCount: number;
  loc: number;
}

export interface FrameworkDetection {
  name: string;
  evidence: string;
}

export interface RepoSnapshot {
  root: string;
  files: FileEntry[];
  /** language -> stats, sorted by loc desc. */
  languages: LanguageDetection[];
  frameworks: FrameworkDetection[];
  packageManager: string | null;
  buildSystem: string | null;
  entrypoints: string[];
  testFrameworks: string[];
  ignoredDirectories: string[];
  totalLoc: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TestRunResult {
  ok: boolean;
  command: string;
  exitCode: number;
  outputTail: string;
  durationMs: number;
}

/** Read-only filesystem facts. */
export interface FsFacts {
  snapshot(root: string): Promise<RepoSnapshot>;
  readFile(root: string, relativePath: string): Promise<string>;
  exists(root: string, relativePath: string): Promise<boolean>;
}

export interface ImportEdge {
  from: string;
  to: string;
  resolved: boolean;
}

/**
 * Static import graph. Backed by the TypeScript module resolver for TS/JS
 * (see TsImportGraph) with regex heuristics for other languages; `analyzer`
 * says which, so findings can carry the provenance.
 */
export interface ImportGraph {
  readonly analyzer: string;
  edges(): Promise<ImportEdge[]>;
  importersOf(path: string): Promise<string[]>;
}

export interface CommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ProcessResult>;
}

/** Test/build execution capability. */
export interface TestRunner {
  detectCommands(root: string): { install?: string; build?: string; test?: string; typecheck?: string; lint?: string };
  runCommand(root: string, command: string, timeoutMs?: number): Promise<TestRunResult>;
}
