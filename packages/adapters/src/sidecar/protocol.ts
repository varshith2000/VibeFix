import type { FileEntry, ImportEdge } from "../capabilities.js";

/**
 * Analyzer sidecar seam — the designed hook for the future Python deep-AST
 * analyzer. Protocol: VibeFix spawns the command, writes a JSON request to
 * the child's stdin, reads one JSON response from stdout. Versioned so a
 * Python implementation can land later without touching callers.
 *
 * Request:  { protocolVersion: 1, root: string, files: FileEntry[] }
 * Response: { protocolVersion: 1, importEdges: ImportEdge[], symbols: SymbolFact[], error?: string }
 */

export interface SymbolFact {
  file: string;
  name: string;
  kind: "function" | "class" | "method";
  startLine: number;
  endLine: number;
}

export interface SidecarResponse {
  protocolVersion: number;
  importEdges: ImportEdge[];
  symbols: SymbolFact[];
  error?: string;
}

export interface SidecarAnalyzer {
  readonly available: boolean;
  analyze(root: string, files: FileEntry[]): Promise<SidecarResponse>;
}

/** Default when no sidecar is configured: honest "not available". */
export class NullSidecar implements SidecarAnalyzer {
  readonly available = false;
  async analyze(): Promise<SidecarResponse> {
    return { protocolVersion: 1, importEdges: [], symbols: [], error: "no analyzer sidecar configured" };
  }
}
