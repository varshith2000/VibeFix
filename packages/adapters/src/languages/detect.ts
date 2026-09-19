import type { FileEntry, FrameworkDetection } from "../capabilities.js";

const FRAMEWORK_SIGNATURES: Array<{ name: string; deps: string[] }> = [
  { name: "react", deps: ["react"] },
  { name: "next", deps: ["next"] },
  { name: "vue", deps: ["vue"] },
  { name: "nuxt", deps: ["nuxt"] },
  { name: "svelte", deps: ["svelte"] },
  { name: "angular", deps: ["@angular/core"] },
  { name: "express", deps: ["express"] },
  { name: "fastify", deps: ["fastify"] },
  { name: "nest", deps: ["@nestjs/core"] },
  { name: "koa", deps: ["koa"] },
  { name: "hapi", deps: ["@hapi/hapi"] },
  { name: "django", deps: ["django"] },
  { name: "flask", deps: ["flask"] },
  { name: "fastapi", deps: ["fastapi"] },
  { name: "sqlalchemy", deps: ["sqlalchemy"] },
  { name: "prisma", deps: ["prisma", "@prisma/client"] },
  { name: "typeorm", deps: ["typeorm"] },
  { name: "mongoose", deps: ["mongoose"] },
  { name: "tailwind", deps: ["tailwindcss"] },
  { name: "electron", deps: ["electron"] },
  { name: "typescript", deps: ["typescript"] },
];

function pythonDeps(rootFiles: FileEntry[]): string[] {
  // requirements.txt / pyproject dependencies are read by callers that have fs
  // access; here we only inspect filenames (kept dependency-free).
  return rootFiles.filter((f) => /requirements.*\.txt$|pyproject\.toml$/.test(f.path)).map((f) => f.path);
}

export function detectFrameworks(
  pkg: Record<string, unknown> | null,
  files: FileEntry[],
): FrameworkDetection[] {
  const out: FrameworkDetection[] = [];
  const depNames = new Set<string>();
  if (pkg) {
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[key];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as Record<string, unknown>)) depNames.add(name);
      }
    }
  }
  for (const sig of FRAMEWORK_SIGNATURES) {
    const hit = sig.deps.find((d) => depNames.has(d));
    if (hit) out.push({ name: sig.name, evidence: `dependency: ${hit}` });
  }
  // Python markers by file presence (requirements.txt read is done in snapshot for detail)
  const pyMarkers = pythonDeps(files);
  if (pyMarkers.length > 0 && files.some((f) => f.path.endsWith(".py"))) {
    out.push({ name: "python", evidence: `manifests: ${pyMarkers.join(", ")}` });
  }
  return out;
}

export function detectPackageManager(files: FileEntry[]): string | null {
  const names = new Set(files.map((f) => f.path));
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("poetry.lock")) return "poetry";
  if (names.has("uv.lock")) return "uv";
  if (names.has("Pipfile.lock")) return "pipenv";
  return null;
}

export function detectTestFrameworks(
  pkg: Record<string, unknown> | null,
  files: FileEntry[],
): string[] {
  const found = new Set<string>();
  const depNames = new Set<string>();
  if (pkg) {
    for (const key of ["dependencies", "devDependencies"]) {
      const deps = pkg[key];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as Record<string, unknown>)) depNames.add(name);
      }
    }
  }
  const byDep: Array<[string, string]> = [
    ["vitest", "vitest"],
    ["jest", "jest"],
    ["mocha", "mocha"],
    ["@playwright/test", "playwright"],
    ["cypress", "cypress"],
    ["pytest", "pytest"],
    ["@testing-library/react", "testing-library"],
  ];
  for (const [dep, label] of byDep) {
    if (depNames.has(dep)) found.add(label);
  }
  if (files.some((f) => f.path.startsWith("tests/") || f.path.startsWith("test/"))) found.add("tests-directory");
  if (files.some((f) => /\.test\.[jt]sx?$/.test(f.path) || /\.spec\.[jt]sx?$/.test(f.path))) {
    found.add("colocated-tests");
  }
  return [...found];
}
