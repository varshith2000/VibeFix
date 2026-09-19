import type { Finding, KnowledgeGraph } from "@vibefix/schemas";
import type { ProposalExplanation } from "@vibefix/schemas";

/** Sanitize a path into a mermaid-safe node id. */
function nodeId(path: string): string {
  return `n_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function fileOf(f: Finding): string {
  return f.location.split(":")[0] ?? f.location;
}

/**
 * Deterministic before/after explanations per change category. Written to
 * TEACH: what exists, what will exist, and the principle at stake. The LLM
 * (when routed) polishes these; the structure never depends on it.
 */
export function categoryExplanation(finding: Finding): ProposalExplanation {
  const file = fileOf(finding);
  switch (finding.recommendedChangeCategory) {
    case "deduplicate":
      return {
        currentState: `The same logic is copy-pasted across ${finding.evidence.length} places (${finding.evidence.slice(0, 4).join(", ")}). Every location must be understood and changed separately, and they have already started drifting apart.`,
        proposedState: `One shared implementation in ${file}; every former copy becomes a single-line call to it. There is exactly one place to fix, test, and reason about.`,
        whyItMatters: `DRY (Don't Repeat Yourself). Duplicated logic is the classic vibe-code failure: a bug fixed in one copy silently survives in the others. Consolidation makes future changes one-edit-safe.`,
      };
    case "extract-function":
      return {
        currentState: `${file} contains a function long enough (${finding.title.match(/\d+/)?.[0] ?? "many"} lines) to hide several distinct jobs — validation, data access, formatting — behind one name.`,
        proposedState: `The long function becomes a short orchestrator that reads like a table of contents; each extracted helper owns one job with a name saying what it does.`,
        whyItMatters: `Single Responsibility Principle. Long functions cannot be tested in isolation, so regressions hide between the lines; extraction makes each piece testable and reviewable.`,
      };
    case "extract-module":
    case "extract-service":
      return {
        currentState: `${file} has grown into a god module: many unrelated responsibilities share one file, so every change — however small — risks breaking something unrelated.`,
        proposedState: `Responsibilities split into focused modules with explicit boundaries (e.g. data access, business rules, entry handling), each importable and testable independently.`,
        whyItMatters: `Separation of Concerns and high cohesion. Boundaries localize blast radius: persistence changes stop rippling into presentation, and the structure starts explaining itself.`,
      };
    case "introduce-boundary":
      return {
        currentState: `Modules import each other in cycles or reach across layers directly (${finding.evidence.slice(0, 3).join("; ")}). There is no direction of dependency — everything depends on everything.`,
        proposedState: `A dependency direction is established (e.g. UI → service → data), with the tangle broken by extracting the shared core that both sides actually need.`,
        whyItMatters: `Acyclic, layered dependencies are what make a codebase modifiable. Cycles mean no module can be tested, moved, or deleted alone — every change is a global change.`,
      };
    case "delete-dead-code":
      return {
        currentState: `${file} carries code that is never exercised — written for a path that no longer exists.`,
        proposedState: `The dead code is removed; everything that remains is reachable and alive.`,
        whyItMatters: `YAGNI. Dead code is pure liability: readers waste time understanding it, and tools can't tell it's safe to ignore.`,
      };
    case "add-tests":
      return {
        currentState: `These paths have no safety net — nothing pins down what "working" currently means.`,
        proposedState: `Characterization tests record today's actual behavior, giving every later refactor a tripwire.`,
        whyItMatters: `Without tests, "refactor" is a hope, not an engineering activity. The baseline is what makes behavior preservation provable.`,
      };
    case "move-code":
      return {
        currentState: `This code lives in the wrong place — far from the module that owns the concept it manipulates.`,
        proposedState: `It moves next to its owners, with imports updated mechanically.`,
        whyItMatters: `Locality of behavior: code that changes together should live together.`,
      };
    case "rename":
      return {
        currentState: `The current name hides intent — readers must open the implementation to learn what it does.`,
        proposedState: `A name that says what it means; call sites updated mechanically.`,
        whyItMatters: `Code is read far more than written. Honest names remove a whole class of misunderstanding.`,
      };
    default:
      return {
        currentState: `Current state: ${finding.title} at ${finding.location}.`,
        proposedState: `A minimal, behavior-preserving cleanup scoped to ${file}.`,
        whyItMatters: finding.impact,
      };
  }
}

/** Mermaid before/after contrast, only for categories where a picture helps. */
export function beforeAfterMermaid(
  finding: Finding,
  scope: readonly string[],
): string | undefined {
  const file = fileOf(finding);
  const target = nodeId(file);
  const label = file.length > 28 ? `${file.slice(0, 25)}…` : file;
  switch (finding.recommendedChangeCategory) {
    case "deduplicate":
      return [
        "graph LR",
        '  subgraph BEFORE["BEFORE — copies drifting apart"]',
        ...scope.slice(0, 4).map((s, i) => `    c${i}["${s}"] --- c${i}v["own copy of the logic"]`),
        "  end",
        '  subgraph AFTER["AFTER — one source of truth"]',
        ...scope.slice(0, 4).map((_, i) => `    a${i}["${scope[i]}"] --> shared["shared helper in ${label}"]`),
        "  end",
      ].join("\n");
    case "extract-service":
    case "extract-module":
    case "introduce-boundary":
      return [
        "graph LR",
        '  subgraph BEFORE["BEFORE — one entangled block"]',
        `    ${target}["${label}"] --> db[("data + logic + entry")]`,
        "  end",
        '  subgraph AFTER["AFTER — explicit boundaries"]',
        `    entry["entry handling"] --> svc["service logic"]`,
        `    svc --> repo[("data access")]`,
        "  end",
      ].join("\n");
    case "extract-function":
      return [
        "graph TD",
        '  subgraph BEFORE["BEFORE — one opaque function"]',
        `    big["long function (${finding.title.match(/\d+/)?.[0] ?? "many"} lines)"]`,
        "  end",
        '  subgraph AFTER["AFTER — readable steps"]',
        "    step1[\"1 · validate\"] --> step2[\"2 · core job\"] --> step3[\"3 · shape result\"]",
        "  end",
      ].join("\n");
    default:
      return undefined;
  }
}

/**
 * Architecture diagram of the system as it EXISTS: top modules by import
 * traffic. Derived deterministically from the knowledge graph.
 */
export function architectureMermaid(graph: KnowledgeGraph): string {
  const moduleEdges = graph.edges.filter((e) => e.edgeType === "imports");
  const strength = new Map<string, { from: string; to: string; count: number }>();
  for (const edge of moduleEdges) {
    const from = edge.fromNodeId.replace(/^file:/, "");
    const to = edge.toNodeId.replace(/^file:/, "");
    const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "(root)";
    const toDir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "(root)";
    if (fromDir === toDir) continue; // intra-module imports don't show structure
    const key = `${fromDir}->${toDir}`;
    const entry = strength.get(key) ?? { from: fromDir, to: toDir, count: 0 };
    entry.count += 1;
    strength.set(key, entry);
  }
  const top = [...strength.values()].sort((a, b) => b.count - a.count).slice(0, 14);
  const seen = new Set<string>();
  const lines = ["graph TD"];
  for (const edge of top) {
    for (const dir of [edge.from, edge.to]) {
      if (!seen.has(dir)) {
        seen.add(dir);
        const label = dir.length > 24 ? `${dir.slice(0, 21)}…` : dir;
        lines.push(`  ${nodeId(dir)}["${label}"]`);
      }
    }
    lines.push(`  ${nodeId(edge.from)} -->|${edge.count}| ${nodeId(edge.to)}`);
  }
  for (const [i, entry] of graph.summary.entrypoints.slice(0, 4).entries()) {
    lines.push(`  ep${i}(("${entry.length > 20 ? `${entry.slice(0, 17)}…` : entry}"))`);
  }
  if (seen.size === 0 && graph.summary.entrypoints.length === 0) {
    lines.push('  empty["no cross-module imports detected"]');
  }
  return lines.join("\n");
}

/** Narrative walkthrough of the existing architecture, from the graph. */
export function existingArchitectureNarrative(graph: KnowledgeGraph): string {
  const parts: string[] = [];
  const langs = graph.summary.languages.length > 0 ? graph.summary.languages.join(", ") : "no code detected";
  parts.push(`The codebase is ${graph.summary.fileCount} files / ${graph.summary.loc.toLocaleString()} lines, written in ${langs}.`);
  if (graph.summary.frameworks.length > 0) {
    parts.push(`It is built on ${graph.summary.frameworks.slice(0, 5).join(", ")}.`);
  }
  if (graph.summary.entrypoints.length > 0) {
    parts.push(`Execution enters through: ${graph.summary.entrypoints.slice(0, 5).join(", ")}. Everything else exists to serve those entry points.`);
  }
  const moduleEdges = graph.edges.filter((e) => e.edgeType === "imports");
  if (moduleEdges.length === 0) {
    parts.push("Modules barely import each other — the code is a set of islands rather than a layered system, which is common in quickly-grown projects.");
  } else {
    const fanIn = new Map<string, number>();
    for (const e of moduleEdges) {
      const to = e.toNodeId.replace(/^file:/, "");
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
    }
    const hubs = [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (hubs.length > 0 && hubs[0]![1] >= 3) {
      parts.push(
        `Import traffic concentrates on a few hubs — ${hubs.map(([f, c]) => `${f} (imported by ${c})`).join(", ")} — these are the structural center of gravity of the system.`,
      );
    }
  }
  if (graph.summary.testFrameworks.length === 0) {
    parts.push("There is no test framework: behavior is currently unpinned, which is why VibeFix builds a baseline before touching anything.");
  }
  if (graph.summary.unknowns.length > 0) {
    parts.push(`Unknowns (stated honestly): ${graph.summary.unknowns.join("; ")}.`);
  }
  return parts.join(" ");
}
