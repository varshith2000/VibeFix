import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const FORBIDDEN_FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);
const FORBIDDEN_PROMPT_IDENTS = new Set(["planPrompt", "rawPrompt", "messages", "promptBody", "rawResponse"]);

/**
 * Statically lints one TypeScript/TSX source file against VibeFix architectural
 * and security invariants (GATE-03, SAFE-04, DAT-04, SEC-11).
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function lintSource(filePath, content) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const isTsx = normalizedPath.endsWith(".tsx");
  const sf = ts.createSourceFile(
    normalizedPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  // 1. Parse diagnostics check
  const parseDiagnostics = sf.parseDiagnostics ?? [];
  for (const diag of parseDiagnostics) {
    const { line, character } = sf.getLineAndCharacterOfPosition(diag.start);
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    violations.push(`${normalizedPath}:${line + 1}:${character + 1} [syntax] ${msg}`);
  }

  const isAgentSrc = normalizedPath.includes("packages/agents/src/");
  const isEngineerAgent = normalizedPath.endsWith("packages/agents/src/agents/engineer.ts");
  const isFixture = normalizedPath.includes("packages/test-fixtures/");
  const isTest = normalizedPath.includes("/test/") || normalizedPath.endsWith(".test.ts");

  const visit = (node) => {
    // 2. SAFE-04: forbid node:fs imports in packages/agents/src outside engineer.ts
    if (isAgentSrc && !isEngineerAgent) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = node.moduleSpecifier.text;
        if (FORBIDDEN_FS_MODULES.has(mod)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(
            `${normalizedPath}:${line + 1} [SAFE-04] Forbidden '${mod}' import in non-engineer agent module; use ctx.tools.fs or EvidenceStore`,
          );
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        FORBIDDEN_FS_MODULES.has(node.arguments[0].text)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push(
          `${normalizedPath}:${line + 1} [SAFE-04] Forbidden dynamic import('${node.arguments[0].text}') in non-engineer agent module`,
        );
      }
    }

    // 3. DAT-04: forbid logging raw prompt / message identifiers in logger or events.append
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sf);
      const isLogCall =
        /^(?:debug|info|warn|error|logger\.(?:debug|info|warn|error))$/.test(exprText) ||
        exprText.endsWith(".events.append") ||
        exprText === "events.append";
      if (isLogCall) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && FORBIDDEN_PROMPT_IDENTS.has(arg.text)) {
            const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
            violations.push(
              `${normalizedPath}:${line + 1} [DAT-04] Forbidden raw prompt/message identifier '${arg.text}' passed to ${exprText}`,
            );
          }
        }
      }

      // 4. SEC-11 / command safety: forbid eval() in production source
      if (!isFixture && !isTest && exprText === "eval") {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push(`${normalizedPath}:${line + 1} [SEC-12] Forbidden eval() call in production source`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

async function collectTsFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTsFiles(full, out);
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

export async function lintWorkspace(rootDir = process.cwd()) {
  const packagesDir = path.join(rootDir, "packages");
  const files = await collectTsFiles(packagesDir);
  const violations = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = path.relative(rootDir, file);
    violations.push(...lintSource(rel, content));
  }
  return { filesChecked: files.length, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { filesChecked, violations } = await lintWorkspace(process.cwd());
  if (violations.length > 0) {
    for (const v of violations) console.error(v);
    console.error(`Lint failed with ${violations.length} violation(s) across ${filesChecked} files.`);
    process.exit(1);
  }
  console.log(`Lint passed (${filesChecked} files checked, 0 violations).`);
}

