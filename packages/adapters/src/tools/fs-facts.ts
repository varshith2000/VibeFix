import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileEntry, FsFacts, RepoSnapshot } from "../capabilities.js";
import { detectFrameworks, detectPackageManager, detectTestFrameworks } from "../languages/detect.js";

/** Directories never analyzed or touched. */
export const IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".vibefix",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "vendor",
  ".cache",
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "c",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sql": "sql",
  ".sh": "shell",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
};

/** Extensions considered code for language stats (not config/docs). */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py",
  ".go", ".rs", ".java", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".swift", ".kt",
]);

function isIgnored(dirName: string): boolean {
  return IGNORED_DIRECTORIES.includes(dirName);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function languageFor(file: string): string | null {
  return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

async function walk(root: string, relDir: string, files: FileEntry[]): Promise<void> {
  const absDir = path.join(root, relDir);
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".vibefix")) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isIgnored(entry.name) || entry.name.startsWith(".")) continue;
      await walk(root, rel, files);
    } else if (entry.isFile()) {
      const abs = path.join(root, rel);
      let size = 0;
      let loc = 0;
      try {
        const stat = await fs.stat(abs);
        size = stat.size;
        if (stat.size < 2_000_000) {
          const content = await fs.readFile(abs, "utf8");
          loc = content.length === 0 ? 0 : content.split("\n").length;
        }
      } catch {
        // unreadable file: still listed with zero stats
      }
      files.push({ path: rel, sizeBytes: size, language: languageFor(rel), loc });
    }
  }
}

function detectEntrypoints(root: string, files: FileEntry[], pkg: Record<string, unknown> | null): string[] {
  const entrypoints = new Set<string>();
  if (pkg) {
    if (typeof pkg.main === "string") entrypoints.add(pkg.main);
    if (Array.isArray(pkg.bin)) {
      for (const b of pkg.bin) if (typeof b === "string") entrypoints.add(b);
    } else if (typeof pkg.bin === "string") {
      entrypoints.add(pkg.bin);
    }
    const scripts = pkg.scripts as Record<string, string> | undefined;
    const start = scripts?.start;
    if (start) {
      const m = start.match(/(?:node|tsx|ts-node)\s+(?:--)?\s*([^\s]+)/);
      if (m?.[1]) entrypoints.add(m[1]);
    }
  }
  const paths = new Set(files.map((f) => f.path));
  for (const candidate of [
    "src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "src/app.ts",
    "index.ts", "index.js", "main.ts", "main.js", "app.py", "main.py", "manage.py",
    "server.ts", "server.js", "src/server.ts", "src/server.js",
  ]) {
    if (paths.has(candidate)) entrypoints.add(candidate);
  }
  return [...entrypoints].filter((p) => typeof p === "string" && p.length > 0);
}

export class NodeFsFacts implements FsFacts {
  async snapshot(root: string): Promise<RepoSnapshot> {
    const files: FileEntry[] = [];
    await walk(root, "", files);

    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      pkg = null;
    }

    const languageMap = new Map<string, { fileCount: number; loc: number }>();
    let totalLoc = 0;
    for (const file of files) {
      if (!file.language || !CODE_EXTENSIONS.has(path.extname(file.path).toLowerCase())) continue;
      const stats = languageMap.get(file.language) ?? { fileCount: 0, loc: 0 };
      stats.fileCount++;
      stats.loc += file.loc;
      totalLoc += file.loc;
      languageMap.set(file.language, stats);
    }

    return {
      root,
      files,
      languages: [...languageMap.entries()]
        .map(([language, s]) => ({ language, ...s }))
        .sort((a, b) => b.loc - a.loc),
      frameworks: detectFrameworks(pkg, files),
      packageManager: detectPackageManager(files),
      buildSystem: pkg ? "npm-scripts" : null,
      entrypoints: detectEntrypoints(root, files, pkg),
      testFrameworks: detectTestFrameworks(pkg, files),
      ignoredDirectories: IGNORED_DIRECTORIES,
      totalLoc,
    };
  }

  async readFile(root: string, relativePath: string): Promise<string> {
    const abs = path.join(root, ...relativePath.split("/"));
    return fs.readFile(abs, "utf8");
  }

  async exists(root: string, relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(root, ...relativePath.split("/")));
      return true;
    } catch {
      return false;
    }
  }
}

export { toPosix };
