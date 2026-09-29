import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "@vibefix/adapters";

export type FixtureProfile = "small-mess" | "medium-mess" | "polyglot" | "malicious-paths" | "large-repo" | "failure-scenarios";

export interface FixtureOptions {
  seed?: number;
  profile?: FixtureProfile;
}

/**
 * Deterministic messy repos for E2E tests. Every profile is a git repo with
 * an initial commit; VibeFix requires git for worktrees.
 */
export async function createFixtureRepo(dir: string, options: FixtureOptions = {}): Promise<string> {
  const profile = options.profile ?? "small-mess";
  await fs.mkdir(dir, { recursive: true });

  switch (profile) {
    case "medium-mess":
      await writeMediumMess(dir);
      break;
    case "polyglot":
      await writePolyglot(dir);
      break;
    case "malicious-paths":
      await writeMaliciousPaths(dir);
      break;
    case "large-repo":
      await writeLargeRepo(dir);
      break;
    case "failure-scenarios":
      await writeFailureScenarios(dir);
      break;
    case "small-mess":
    default:
      await writeSmallMess(dir);
      break;
  }

  await runCommand("git", ["init", "-q"], { cwd: dir });
  await runCommand("git", ["config", "user.email", "fixture@vibefix.test"], { cwd: dir });
  await runCommand("git", ["config", "user.name", "VibeFix Fixture"], { cwd: dir });
  await runCommand("git", ["add", "-A"], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "fixture: initial messy state"], { cwd: dir });
  return path.resolve(dir);
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const target = path.join(dir, ...rel.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

/** JS god-file + duplicated utility blocks + no tests. The classic vibe-code shape. */
async function writeSmallMess(dir: string): Promise<void> {
  await write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "small-mess",
        version: "1.0.0",
        private: true,
        main: "src/index.js",
        scripts: { start: "node src/index.js" },
        dependencies: { express: "^4.19.0" },
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    dir,
    "src/index.js",
    [
      "// entrypoint: everything in one place because it was fastest",
      "const express = require('express');",
      "const { formatUser } = require('./utils');",
      "const app = express();",
      "",
      "app.get('/users/:id', function handleGetUser(req, res) {",
      "  // validation",
      "  if (!req.params.id) { return res.status(400).json({ error: 'missing id' }); }",
      "  // fake db access inline",
      "  const user = { id: req.params.id, name: 'User ' + req.params.id, email: req.params.id + '@example.com' };",
      "  // formatting inline (duplicated in utils.js)",
      "  const formatted = user.name.charAt(0).toUpperCase() + user.name.slice(1) + ' <' + user.email + '>';",
      "  // response shaping",
      "  res.json({ user: formatted });",
      "});",
      "",
      "app.post('/users', function handleCreateUser(req, res) {",
      "  if (!req.body || !req.body.name) { return res.status(400).json({ error: 'missing name' }); }",
      "  const user = { id: String(Date.now()), name: req.body.name, email: req.body.email || '' };",
      "  // same formatting copy-pasted here",
      "  const formatted = user.name.charAt(0).toUpperCase() + user.name.slice(1) + ' <' + user.email + '>';",
      "  // TODO: persist the user somewhere, anything, please",
      "  res.status(201).json({ user: formatted });",
      "});",
      "",
      "if (require.main === module) {",
      "  app.listen(3000, () => console.log('listening on 3000'));",
      "}",
      "module.exports = { app };",
      "",
    ].join("\n"),
  );
  await write(
    dir,
    "src/utils.js",
    [
      "// utils that grew by copy-paste",
      "function formatUser(user) {",
      "  // third copy of the same formatting logic",
      "  return user.name.charAt(0).toUpperCase() + user.name.slice(1) + ' <' + user.email + '>';",
      "}",
      "function formatUserAgain(user) {",
      "  return user.name.charAt(0).toUpperCase() + user.name.slice(1) + ' <' + user.email + '>';",
      "}",
      "module.exports = { formatUser, formatUserAgain };",
      "",
    ].join("\n"),
  );
  await write(dir, "README.md", "# small-mess\n\nA vibe-coded express app with everything in two files.\n");
}

/** TS + mixed patterns + a few tests. */
async function writeMediumMess(dir: string): Promise<void> {
  await write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "medium-mess",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "tsc -p .", test: "vitest run", typecheck: "tsc --noEmit" },
        dependencies: { express: "^4.19.0" },
        devDependencies: { typescript: "^5.5.0", vitest: "^2.0.0", "@types/express": "^4.17.0", "@types/node": "^20.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    dir,
    "tsconfig.json",
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist", skipLibCheck: true } },
      null,
      2,
    ) + "\n",
  );
  await write(dir, ".gitignore", "node_modules\ndist\n.vibefix\n");
  await write(
    dir,
    "src/index.ts",
    [
      'import express from "express";',
      'import { OrderService } from "./orders/service";',
      'import { paymentGateway } from "./orders/payment";',
      'import { sendEmail } from "./orders/email";',
      "",
      "const app = express();",
      "app.use(express.json());",
      "",
      "// controller doing validation + db + payment + email + response",
      "app.post('/api/orders', function createOrder(req, res) {",
      "  if (!req.body?.productId) { return res.status(400).json({ error: 'productId required' }); }",
      "  const service = new OrderService();",
      "  const order = service.create(req.body.productId, req.body.quantity ?? 1);",
      "  paymentGateway.charge(order.total);",
      "  sendEmail('order-confirmed', order.id);",
      "  return res.status(201).json({ id: order.id, status: order.status });",
      "});",
      "",
      "export default app;",
      "",
    ].join("\n"),
  );
  await write(
    dir,
    "src/orders/service.ts",
    [
      "export interface Order { id: string; productId: string; quantity: number; total: number; status: string }",
      "",
      "export class OrderService {",
      "  // in-memory 'database' — three different data-access styles live in this codebase",
      "  private orders: Order[] = [];",
      "",
      "  create(productId: string, quantity: number): Order {",
      "    const order: Order = {",
      "      id: 'ord_' + (this.orders.length + 1),",
      "      productId,",
      "      quantity,",
      "      total: quantity * 42,",
      "      status: 'created',",
      "    };",
      "    this.orders.push(order);",
      "    return order;",
      "  }",
      "",
      "  list(): Order[] {",
      "    return this.orders;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await write(
    dir,
    "src/orders/payment.ts",
    [
      "export const paymentGateway = {",
      "  charge(amount: number): boolean {",
      "    // FIXME: no error handling, no retry, definitely no real gateway",
      "    return amount > 0;",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await write(
    dir,
    "src/orders/email.ts",
    [
      "export function sendEmail(template: string, ref: string): void {",
      "  // HACK: logs instead of sending email",
      "  console.log(`[email:${template}] ${ref}`);",
      "}",
      "",
    ].join("\n"),
  );
  // components reaching into 'data' — layering violation for arch-auditor
  await write(
    dir,
    "src/components/OrderList.tsx",
    [
      'import { OrderService } from "../orders/service";',
      "",
      "export function OrderList(): string {",
      "  // UI calling the 'db' service directly",
      "  const orders = new OrderService().list();",
      "  return `<ul>${orders.map((o) => `<li>${o.id}</li>`).join('')}</ul>`;",
      "}",
      "",
    ].join("\n"),
  );
  await write(
    dir,
    "src/orders/service.test.ts",
    [
      'import { describe, it, expect } from "vitest";',
      'import { OrderService } from "./service";',
      "",
      "describe('OrderService', () => {",
      "  it('creates orders', () => {",
      "    const s = new OrderService();",
      "    const o = s.create('p1', 2);",
      "    expect(o.total).toBe(84);",
      "  });",
      "});",
      "",
    ].join("\n"),
  );
}

/** TS + Python side by side (detection coverage). */
async function writePolyglot(dir: string): Promise<void> {
  await writeSmallMess(dir);
  await write(
    dir,
    "scripts/report.py",
    [
      "import json",
      "from pathlib import Path",
      "",
      "def build_report(data_dir: Path) -> str:",
      "    rows = []",
      "    for f in data_dir.glob('*.json'):",
      "        # naive but works",
      "        rows.append(json.loads(f.read_text()))",
      "    return json.dumps(rows)",
      "",
      "if __name__ == '__main__':",
      "    print(build_report(Path('data')))",
      "",
    ].join("\n"),
  );
  await write(dir, "requirements.txt", "requests==2.32.0\n");
}

async function writeMaliciousPaths(dir: string): Promise<void> {
  await write(dir, "package.json", JSON.stringify({ name: "hostile-fixture", version: "1.0.0", private: true }, null, 2) + "\n");
  await write(
    dir,
    "src/unsafe-handler.js",
    [
      "const path = require('node:path');",
      "const { exec } = require('node:child_process');",
      "function readRequestedFile(root, requested) {",
      "  return require('node:fs').readFileSync(path.join(root, requested), 'utf8');",
      "}",
      "function runRequestedCommand(command) { exec(command); }",
      "module.exports = { readRequestedFile, runRequestedCommand };",
      "",
    ].join("\n"),
  );
  await write(dir, "README.md", "# Hostile path fixture\n\nStatic analysis fixture containing unsafe path and process patterns.\n");
}

async function writeLargeRepo(dir: string): Promise<void> {
  await writeSmallMess(dir);
  await Promise.all(Array.from({ length: 128 }, async (_, index) => {
    const name = String(index).padStart(3, "0");
    await write(dir, `src/generated/module-${name}.js`, `module.exports = { index: ${index} };\n`);
  }));
}

async function writeFailureScenarios(dir: string): Promise<void> {
  await write(
    dir,
    "package.json",
    JSON.stringify(
      { name: "failing-fixture", version: "1.0.0", private: true, scripts: { build: "node scripts/fail.js", test: "node scripts/fail.js" } },
      null,
      2,
    ) + "\n",
  );
  await write(dir, "scripts/fail.js", "process.stderr.write('fixture failure\\n');\nprocess.exitCode = 1;\n");
  await write(dir, "README.md", "# Failure fixture\n\nBuild and test commands intentionally exit unsuccessfully.\n");
}
