import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentDefinition, AgentRunStatus, RunState } from "../types";

/** Phase column order — the organized pipeline: each step after the other. */
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

const PHASE_LABEL: Record<string, string> = {
  recon: "1 · Understand",
  diagnosis: "2 · Diagnose",
  riskAssessment: "3 · Assess risk",
  synthesis: "4 · Backlog",
  awaitingApproval: "5 · Your approval",
  harness: "6 · Safety net",
  execution: "7 · Transform",
  verification: "8 · Verify",
  report: "9 · Explain",
};

const STATUS_STYLE: Record<AgentRunStatus, { border: string; dot: string; label: string }> = {
  queued: { border: "border-slate-700 bg-ink-800", dot: "bg-slate-500", label: "text-slate-400" },
  running: { border: "border-sky-400 bg-sky-950/40 shadow-[0_0_18px_rgba(56,189,248,0.55)]", dot: "bg-sky-300 animate-ping", label: "text-sky-200" },
  passed: { border: "border-emerald-600 bg-ink-800", dot: "bg-emerald-400", label: "text-emerald-300" },
  failed: { border: "border-red-600 bg-ink-800", dot: "bg-red-500", label: "text-red-300" },
  rejected: { border: "border-orange-500 bg-ink-800", dot: "bg-orange-400", label: "text-orange-300" },
  deferred: { border: "border-yellow-600 bg-ink-800", dot: "bg-yellow-500", label: "text-yellow-300" },
  skipped: { border: "border-slate-800 bg-ink-900", dot: "bg-slate-700", label: "text-slate-500" },
};

type AgentNodeData = {
  def: AgentDefinition;
  status: AgentRunStatus;
  tokens: number;
};

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const style = STATUS_STYLE[data.status] ?? STATUS_STYLE.queued!;
  return (
    <div
      className={`w-44 rounded-lg border-2 px-3 py-2 shadow-lg transition-all ${style.border} ${
        data.status === "running" ? "scale-105" : ""
      }`}
    >
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
      {data.tokens > 0 && (
        <div className="mt-0.5 text-[9px] text-amber-400/80">{data.tokens.toLocaleString()} tok</div>
      )}
      {data.def.permission === "worktree-write" && (
        <div className="mt-0.5 text-[9px] text-amber-400">✎ sole writer (firewalled)</div>
      )}
      {data.def.freshContext && <div className="text-[9px] text-emerald-400">fresh context</div>}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function PhaseHeaderNode({ data }: NodeProps<Node<{ label: string; active: boolean }>>) {
  return (
    <div
      className={`rounded px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-widest ${
        data.active ? "bg-sky-900/50 text-sky-300" : "text-slate-500"
      }`}
    >
      {data.label}
    </div>
  );
}

const nodeTypes = { agent: AgentNode, phaseHeader: PhaseHeaderNode };

const COLUMN_W = 250;
const HEADER_H = 60;

function GraphInner({
  agents,
  runState,
  usageByAgent,
  onAgentClick,
}: {
  agents: AgentDefinition[];
  runState: RunState | null;
  usageByAgent: Record<string, number>;
  onAgentClick: (agentId: string) => void;
}) {
  const { fitView } = useReactFlow();
  const layoutKey = useRef(0);

  const { nodes, edges } = useMemo(() => {
    const byPhase = new Map<string, AgentDefinition[]>();
    for (const def of agents) {
      const list = byPhase.get(def.phase) ?? [];
      list.push(def);
      byPhase.set(def.phase, list);
    }

    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];
    const columnOf = new Map<string, number>();
    let col = 0;
    for (const phase of PHASE_ORDER) {
      const defs = byPhase.get(phase);
      if (!defs || defs.length === 0) continue;
      columnOf.set(phase, col++);
    }

    const nodePos = new Map<string, { x: number; y: number }>();
    for (const [phase, defs] of byPhase) {
      const c = columnOf.get(phase) ?? 0;
      flowNodes.push({
        id: `phase:${phase}`,
        type: "phaseHeader",
        position: { x: c * COLUMN_W, y: 0 },
        data: { label: PHASE_LABEL[phase] ?? phase, active: runState?.phase === phase },
        draggable: false,
        selectable: false,
      });
      defs.forEach((def, row) => {
        const pos = { x: c * COLUMN_W, y: HEADER_H + row * 120 };
        nodePos.set(def.agentId, pos);
        flowNodes.push({
          id: def.agentId,
          type: "agent",
          position: pos,
          data: {
            def,
            status: runState?.agentStates[def.agentId] ?? "queued",
            tokens: usageByAgent[def.agentId] ?? 0,
          },
        });
      });
    }

    // Edges: previous phase -> every agent of next phase (organized flow).
    let prev: AgentDefinition[] | null = null;
    for (const phase of PHASE_ORDER) {
      const defs = byPhase.get(phase);
      if (!defs || defs.length === 0) continue;
      if (prev) {
        for (const p of prev) {
          for (const def of defs) {
            const active =
              prev!.length > 0 &&
              runState?.agentStates[p.agentId] === "passed" &&
              runState?.agentStates[def.agentId] === "running";
            flowEdges.push({
              id: `${p.agentId}->${def.agentId}`,
              source: p.agentId,
              target: def.agentId,
              animated: active,
              style: { stroke: active ? "#38bdf8" : "#334155", strokeWidth: active ? 2 : 1 },
            });
          }
        }
      }
      prev = defs;
    }
    return { nodes: flowNodes, edges: flowEdges };
  }, [agents, runState, usageByAgent]);

  useEffect(() => {
    void layoutKey;
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [nodes.length, fitView]);

  const rearrange = useCallback(() => {
    layoutKey.current += 1;
    void fitView({ padding: 0.15, duration: 400 });
  }, [fitView]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (!node.id.startsWith("phase:")) onAgentClick(node.id);
        }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesConnectable={false}
        minZoom={0.15}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!bg-ink-800 !border-slate-700 [&>button]:!bg-ink-800 [&>button]:!border-slate-700 [&>button]:!fill-slate-300"
        />
      </ReactFlow>
      <button
        onClick={rearrange}
        className="absolute right-3 top-2 z-10 rounded border border-slate-700 bg-ink-800/90 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-700"
        title="Re-layout and fit the pipeline"
      >
        ⇄ Rearrange
      </button>
    </div>
  );
}

export function AgentGraph(props: {
  agents: AgentDefinition[];
  runState: RunState | null;
  usageByAgent: Record<string, number>;
  onAgentClick: (agentId: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
