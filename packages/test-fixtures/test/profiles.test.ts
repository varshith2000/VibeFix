import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureRepo } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeFixture(profile: "malicious-paths" | "large-repo" | "failure-scenarios"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vibefix-test-fixture-"));
  roots.push(root);
  return createFixtureRepo(path.join(root, "repo"), { profile });
}

describe("test fixture profiles", () => {
  it("provides static unsafe path and process patterns without executing them", async () => {
    const repo = await makeFixture("malicious-paths");
    const source = await readFile(path.join(repo, "src", "unsafe-handler.js"), "utf8");
    expect(source).toContain("path.join(root, requested)");
    expect(source).toContain("exec(command)");
  });

  it("generates a deterministic large repository profile", async () => {
    const repo = await makeFixture("large-repo");
    const generated = await readdir(path.join(repo, "src", "generated"));
    expect(generated).toHaveLength(128);
    expect(generated[0]).toBe("module-000.js");
    expect(generated.at(-1)).toBe("module-127.js");
  }, 30_000);

  it("provides build and test commands that fail for recovery testing", async () => {
    const repo = await makeFixture("failure-scenarios");
    const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      scripts: { build: string; test: string };
    };
    expect(manifest.scripts.build).toBe("node scripts/fail.js");
    expect(manifest.scripts.test).toBe("node scripts/fail.js");
    expect(await readFile(path.join(repo, "scripts", "fail.js"), "utf8")).toContain("process.exitCode = 1");
  });
});
