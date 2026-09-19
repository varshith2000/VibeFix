import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileEntry, ImportEdge, ImportGraph } from "../capabilities.js";

const JS_IMPORT_PATTERNS = [
  /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
  /import\s+['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
];
const PY_IMPORT_PATTERNS = [/^\s*import\s+([.\w]+)/gm, /^\s*from\s+([.\w]+)/gm];

function resolveJsImport(fromFile: string, spec: string, filePaths: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // external package
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  for (const candidate of candidates) {
    if (filePaths.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Regex-based static import scanner. Deliberately simple: VibeFix agents get
 * *facts* cheap; the tree-sitter/Python-sidecar seam upgrades accuracy later
 * without changing the ImportGraph interface.
 */
export class RegexImportGraph implements ImportGraph {
  constructor(
    private readonly root: string,
    private readonly files: FileEntry[],
  ) {}

  private async scan(): Promise<ImportEdge[]> {
    const filePaths = new Set(this.files.map((f) => f.path));
    const edges: ImportEdge[] = [];
    for (const file of this.files) {
      const ext = path.extname(file.path).toLowerCase();
      const isJs = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
      const isPy = ext === ".py";
      if (!isJs && !isPy) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, ...file.path.split("/")), "utf8");
      } catch {
        continue;
      }
      if (content.length > 500_000) continue;
      if (isJs) {
        for (const pattern of JS_IMPORT_PATTERNS) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(content)) !== null) {
            const spec = m[1]!;
            const resolved = resolveJsImport(file.path, spec, filePaths);
            edges.push({ from: file.path, to: resolved ?? spec, resolved: resolved !== null });
          }
        }
      } else {
        for (const pattern of PY_IMPORT_PATTERNS) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(content)) !== null) {
            edges.push({ from: file.path, to: m[1]!, resolved: false });
          }
        }
      }
    }
    return edges;
  }

  private cached: ImportEdge[] | null = null;
  private async edgesCached(): Promise<ImportEdge[]> {
    if (!this.cached) this.cached = await this.scan();
    return this.cached;
  }

  async edges(): Promise<ImportEdge[]> {
    return this.edgesCached();
  }

  async importersOf(target: string): Promise<string[]> {
    const all = await this.edgesCached();
    const set = new Set<string>();
    for (const edge of all) {
      if (edge.to === target && edge.resolved) set.add(edge.from);
    }
    return [...set];
  }
}
