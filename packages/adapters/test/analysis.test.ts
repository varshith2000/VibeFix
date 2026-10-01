import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeMetrics, measureTsFunctions } from "../src/tools/code-metrics.js";
import { TsImportGraph, RegexImportGraph } from "../src/tools/import-graph.js";
import { NodeFsFacts } from "../src/tools/fs-facts.js";
import type { FileEntry } from "../src/capabilities.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibefix-analysis-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (p: string): FileEntry => ({ path: p, sizeBytes: 1000, language: "typescript", loc: 50 });

describe("TS-AST code metrics", () => {
  it("measures function spans correctly through braces in strings, comments and template literals", async () => {
    // This function body is poison for the old brace counter: the string and
    // comment lines contain unbalanced )({ and the template literal has ${")"}.
    const filler = Array.from({ length: 20 }, (_, i) => `  const v${i} = ")}{{("; // ((}`).join("\n");
    const source = [
      "const decoy = `template ${')}'} stays open ((`;",
      "function longOne(a: string) {",
      filler,
      "  return `done ${a}} ((`;",
      "}",
      "",
    ].join("\n");
    const fns = measureTsFunctions(source, "poison.ts");
    const longOne = fns.find((f) => f.name === "longOne");
    expect(longOne).toBeDefined();
    expect(longOne!.analyzer).toBe("ts-ast");
    // startLine 2 through line 24 (2 + 20 filler + return + closing brace)
    expect(longOne!.lines).toBe(23);
  });

  it("labels every function with its analyzer and reports the aggregate", async () => {
    const root = path.join(dir, "metrics-repo");
    await mkdir(root, { recursive: true });
    const tsFile = ["function short() { return 1; }", "function longEnough() {", ...Array.from({ length: 35 }, (_, i) => `  const x${i} = ${i};`), "}", ""].join("\n");
    await writeFile(path.join(root, "code.ts"), tsFile);
    const metrics = await computeMetrics(root, [entry("code.ts")]);
    expect(metrics.analyzer).toBe("ts-ast");
    const long = metrics.functions.find((f) => f.name === "longEnough");
    expect(long?.analyzer).toBe("ts-ast");
    expect(long?.lines).toBeGreaterThanOrEqual(30);
    // The 1-line function is below the reporting threshold.
    expect(metrics.functions.find((f) => f.name === "short")).toBeUndefined();
  });

  it("python files stay on the regex heuristic with the label", async () => {
    const root = path.join(dir, "py-repo");
    await mkdir(root, { recursive: true });
    const py = ["def long_py():", ...Array.from({ length: 35 }, (_, i) => `    x${i} = ${i}`), ""].join("\n");
    await writeFile(path.join(root, "code.py"), py);
    const metrics = await computeMetrics(root, [entry("code.py")]);
    // Aggregate label says how the repo was measured. (The legacy brace
    // counter mismeasures `def f():` as a 1-line body — that imprecision is
    // exactly why the analyzer label exists and is reported.)
    expect(metrics.analyzer).toBe("regex-heuristic");
    for (const fn of metrics.functions) expect(fn.analyzer).toBe("regex-heuristic");
  });
});

describe("analysis secret boundary", () => {
  it("excludes credential-shaped files from repository snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-sensitive-files-"));
    try {
      await writeFile(path.join(root, ".env"), "API_KEY=canary");
      await writeFile(path.join(root, "credentials.json"), "{\"token\":\"canary\"}");
      await writeFile(path.join(root, "safe.ts"), "export const safe = true;\n");
      const snapshot = await new NodeFsFacts().snapshot(root);
      expect(snapshot.files.map((file) => file.path)).toEqual(["safe.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("TS module-resolution import graph", () => {
  it("resolves aliased paths, export-from and dynamic imports; externals stay unresolved", async () => {
    const root = path.join(dir, "graph-repo");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    );
    await writeFile(path.join(root, "src", "util.ts"), "export const x = 1;\n");
    await writeFile(path.join(root, "src", "lazy.ts"), "export const y = 2;\n");
    await writeFile(
      path.join(root, "src", "main.ts"),
      [
        'import { x } from "@/util";',
        'export { x } from "./util";',
        'import "lodash";',
        "async function load() { const m = await import('./lazy'); return m; }",
        "export { load };",
        "",
      ].join("\n"),
    );
    const files = [entry("src/main.ts"), entry("src/util.ts"), entry("src/lazy.ts")];
    const graph = new TsImportGraph(root, files);
    expect(graph.analyzer).toBe("ts-module-resolution");
    const edges = await graph.edges();

    const targets = edges.filter((e) => e.from === "src/main.ts");
    // Aliased path resolves through tsconfig paths.
    expect(targets.some((e) => e.to === "src/util.ts" && e.resolved)).toBe(true);
    // Dynamic import() resolves too.
    expect(targets.some((e) => e.to === "src/lazy.ts" && e.resolved)).toBe(true);
    // External package: present, unresolved.
    expect(targets.some((e) => e.to === "lodash" && !e.resolved)).toBe(true);
    // Nothing resolves to a path outside the repo.
    expect(edges.filter((e) => e.resolved).every((e) => !e.to.startsWith("..") && !path.isAbsolute(e.to))).toBe(true);

    const importers = await graph.importersOf("src/util.ts");
    expect(importers).toContain("src/main.ts");
  });

  it("the regex graph stays available and self-labeled as heuristic", async () => {
    const root = path.join(dir, "graph-repo2");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), 'import { z } from "./b";\n');
    await writeFile(path.join(root, "src", "b.ts"), "export const z = 3;\n");
    const graph = new RegexImportGraph(root, [entry("src/a.ts"), entry("src/b.ts")]);
    expect(graph.analyzer).toBe("regex-heuristic");
    const edges = await graph.edges();
    expect(edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts" && e.resolved)).toBe(true);
  });
});
