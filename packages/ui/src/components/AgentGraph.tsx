import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentDefinition, AgentRunStatus, RunState } from "../types";

/** Phase column order — mirrors the orchestrator's phase graph. */
const PHASE_ORDER = [
  "recon",
  "diagnosis",
  "riskAssessment",
  "synthesis",
  "awaitingApproval",
  "harness",
  "execution",
  "verification",
  "report",
] as const;

const STATUS_STYLE: Record<AgentRunStatus, { border: string; dot: string; label: string }> = {
  queued: { border: "border-slate-700 bg-ink-800", dot: "bg-slate-500", label: "text-slate-400" },
  running: { border: "border-sky-500 bg-ink-800 animate-pulse", dot: "bg-sky-400", label: "text-sky-300" },
  passed: { border: "border-emerald-600 bg-ink-800", dot: "bg-emerald-400", label: "text-emerald-300" },
  failed: { border: "border-red-600 bg-ink-800", dot: "bg-red-500", label: "text-red-300" },
  rejected: { border: "border-orange-500 bg-ink-800", dot: "bg-orange-400", label: "text-orange-300" },
  deferred: { border: "border-yellow-600 bg-ink-800", dot: "bg-yellow-500", label: "text-yellow-300" },
  skipped: { border: "border-slate-800 bg-ink-900", dot: "bg-slate-700", label: "text-slate-500" },
};

type AgentNodeData = {
  def: AgentDefinition;
  status: AgentRunStatus;
};

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const style = STATUS_STYLE[data.status] ?? STATUS_STYLE.queued!;
  return (
    <div className={`w-44 rounded-lg border-2 px-3 py-2 shadow-lg ${style.border}`}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} />
        <span className="truncate text-sm font-medium text-slate-100">{data.def.label}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-wide ${style.label}`}>{data.status}</span>
        <span
          className={`text-[9px] rounded px-1 ${
            data.def.capability === "TypedDecision"
              ? "bg-violet-900/60 text-violet-300"
              : "bg-sky-900/60 text-sky-300"
          }`}
          title={data.def.capability === "TypedDecision" ? "Typed decision model (e.g. Jev)" : "Text generation model"}
        >
          {data.def.capability === "TypedDecision" ? "DECIDE" : "TEXT"}
        </span>
      </div>
      {data.def.permission === "worktree-write" && (
        <div className="mt-1 text-[9px] text-amber-400">✎ sole writer (firewalled)</div>
      )}
      {data.def.freshContext && (
        <div className="mt-1 text-[9px] text-emerald-400">fresh context</div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

export function AgentGraph({
  agents,
  runState,
}: {
  agents: AgentDefinition[];
  runState: RunState | null;
}) {
  const { nodes, edges } = useMemo(() => {
    const byPhase = new Map<string, AgentDefinition[]>();
    for (const def of agents) {
      const phase = def.phase === "verification" ? "verification" : def.phase;
      const list = byPhase.get(phase) ?? [];
      list.push(def);
      byPhase.set(phase, list);
    }

    const flowNodes: Node<AgentNodeData>[] = [];
    const columnIndexes = new Map<string, number>();

    PHASE_ORDER.forEach((phase) => {
      const defs = byPhase.get(phase);
      if (!defs || defs.length === 0) return;
      columnIndexes.set(phase, columnIndexes.size);
    });

    const positions = new Map<string, { x: number; y: number }>();
    for (const [phase, defs] of byPhase) {
      const col = columnIndexes.get(phase) ?? 0;
      defs.forEach((def, row) => {
        const x = col * 240;
        const y = row * 130 + (phase === "verification" ? 90 : 20);
        positions.set(def.agentId, { x, y });
      });
    }

    for (const [phase, defs] of byPhase) {
      defs.forEach((def, row) => {
        const pos = positions.get(def.agentId)!;
        flowNodes.push({
          id: def.agentId,
          type: "agent",
          position: pos,
          data: {
            def,
            status: runState?.agentStates[def.agentId] ?? "queued",
          },
        });
        void row;
      });
      void phase;
    }

    // Edges: within a phase chain vertically; between phases connect to next phase's nodes.
    const flowEdges: Edge[] = [];
    let previousPhaseDefs: AgentDefinition[] | null = null;
    for (const phase of PHASE_ORDER) {
      const defs = byPhase.get(phase);
      if (!defs || defs.length === 0) continue;
      // Parallel pools: stack without edges between them (they run concurrently).
      if (defs.length > 1) {
        defs.slice(0, -1).forEach((def, i) => {
          flowEdges.push({
            id: `${def.agentId}->${defs[i + 1]!.agentId}`,
            source: def.agentId,
            target: defs[i + 1]!.agentId,
            style: { stroke: "#334155", strokeDasharray: "3 3" },
          });
        });
      }
      if (previousPhaseDefs) {
        for (const prev of previousPhaseDefs) {
          for (const def of defs) {
            flowEdges.push({
              id: `${prev.agentId}->${def.agentId}`,
              source: prev.agentId,
              target: def.agentId,
              style: { stroke: "#334155" },
            });
          }
        }
      }
      previousPhaseDefs = defs;
    }
    return { nodes: flowNodes, edges: flowEdges };
  }, [agents, runState]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
      </ReactFlow>
    </div>
  );
}
