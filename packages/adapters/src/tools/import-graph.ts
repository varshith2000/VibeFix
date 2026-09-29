import path from "node:path";
import { promises as fs } from "node:fs";
import ts from "typescript";
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
 * Regex-based static import scanner — the explicitly heuristic fallback.
 * Kept for Python and for consumers that want the cheap graph; the default
 * for TS/JS projects is {@link TsImportGraph}.
 */
export class RegexImportGraph implements ImportGraph {
  readonly analyzer = "regex-heuristic";

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

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Import graph built on the TypeScript compiler: AST module-specifier
 * extraction (import/export-from/dynamic import()/require) and
 * ts.resolveModuleName resolution (extension probing, index files, tsconfig
 * baseUrl/paths aliases). Handles `export ... from`, dynamic imports, path
 * mappings and Windows paths that the regex scanner misses. Python files
 * still go through the regex patterns — those edges are the heuristic part
 * and are reported unresolved.
 */
export class TsImportGraph implements ImportGraph {
  readonly analyzer = "ts-module-resolution";
  private readonly compilerOptions: ts.CompilerOptions;

  constructor(
    private readonly root: string,
    private readonly files: FileEntry[],
  ) {
    this.compilerOptions = this.readCompilerOptions();
  }

  /** tsconfig.json baseUrl/paths etc. — best effort, defaults are fine. */
  private readCompilerOptions(): ts.CompilerOptions {
    try {
      const configPath = ts.findConfigFile(this.root, ts.sys.fileExists, "tsconfig.json");
      if (!configPath) return {};
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      if (raw.error) return {};
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
      return parsed.options;
    } catch {
      return {};
    }
  }

  private toRepoRelative(absolute: string): string {
    return path.relative(this.root, absolute).replace(/\\/g, "/");
  }

  private resolveSpec(fromFile: string, spec: string, filePaths: Set<string>): { to: string; resolved: boolean } {
    const host: ts.ModuleResolutionHost = {
      fileExists: (fileName) => {
        const rel = this.toRepoRelative(fileName);
        return filePaths.has(rel) || filePaths.has(rel.replace(/\.js$/, ".ts")) || ts.sys.fileExists(fileName);
      },
      readFile: (fileName) => ts.sys.readFile(fileName),
      directoryExists: (fileName) => ts.sys.directoryExists(fileName),
      getCurrentDirectory: () => this.root,
      getDirectories: (fileName) => ts.sys.getDirectories(fileName),
    };
    const result = ts.resolveModuleName(spec, path.join(this.root, fromFile), this.compilerOptions, host);
    const mod = result.resolvedModule;
    if (!mod) return { to: spec, resolved: false };
    const rel = this.toRepoRelative(mod.resolvedFileName);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // Resolved outside the repository (node_modules, SDK) — external edge.
      return { to: spec, resolved: false };
    }
    return { to: rel, resolved: true };
  }

  /** Every string module specifier in the file, via the AST. */
  private extractSpecifiers(sf: ts.SourceFile): string[] {
    const specs: string[] = [];
    const pushIfString = (expr: ts.Expression): void => {
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) specs.push(expr.text);
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        pushIfString(node.moduleSpecifier);
      } else if (ts.isCallExpression(node)) {
        // import("...") — expression.kind === ImportKeyword
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
          pushIfString(node.arguments[0]);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0]) {
          pushIfString(node.arguments[0]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...new Set(specs)];
  }

  private async scan(): Promise<ImportEdge[]> {
    const filePaths = new Set(this.files.map((f) => f.path));
    const edges: ImportEdge[] = [];
    for (const file of this.files) {
      const ext = path.extname(file.path).toLowerCase();
      const isTsFamily = TS_EXTS.has(ext);
      const isPy = ext === ".py";
      if (!isTsFamily && !isPy) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, ...file.path.split("/")), "utf8");
      } catch {
        continue;
      }
      if (content.length > 500_000) continue;
      if (isTsFamily) {
        const sf = ts.createSourceFile(file.path, content, ts.ScriptTarget.Latest, true);
        for (const spec of this.extractSpecifiers(sf)) {
          const { to, resolved } = this.resolveSpec(file.path, spec, filePaths);
          edges.push({ from: file.path, to, resolved });
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

/** Default graph for a repo: TS module resolution, with regex for Python. */
export function createImportGraph(root: string, files: FileEntry[]): ImportGraph {
  return new TsImportGraph(root, files);
}
