export type {
  FileEntry,
  RepoSnapshot,
  LanguageDetection,
  FrameworkDetection,
  ProcessResult,
  TestRunResult,
  FsFacts,
  ImportEdge,
  ImportGraph,
  CommandRunner,
  TestRunner,
} from "./capabilities.js";
export { NodeFsFacts, IGNORED_DIRECTORIES, toPosix } from "./tools/fs-facts.js";
export { GitTool, ShellRunner, runCommand } from "./tools/git.js";
export { RegexImportGraph, TsImportGraph, createImportGraph } from "./tools/import-graph.js";
export { NodeTestRunner } from "./tools/test-runner.js";
export { computeMetrics, type FileMetrics, type FunctionMetric, type DuplicationCluster } from "./tools/code-metrics.js";
export { detectFrameworks, detectPackageManager, detectTestFrameworks } from "./languages/detect.js";
export type { SymbolFact, SidecarResponse, SidecarAnalyzer } from "./sidecar/protocol.js";
export { NullSidecar } from "./sidecar/protocol.js";
