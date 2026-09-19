import { z } from "zod";

export const GraphNodeTypeSchema = z.enum([
  "repo",
  "module",
  "file",
  "function",
  "class",
  "endpoint",
  "test",
  "externalService",
  "config",
]);
export type GraphNodeType = z.infer<typeof GraphNodeTypeSchema>;

export const GraphEdgeTypeSchema = z.enum([
  "imports",
  "calls",
  "extends",
  "implements",
  "tests",
  "exposes",
  "dependsOn",
  "configures",
]);
export type GraphEdgeType = z.infer<typeof GraphEdgeTypeSchema>;

export const GraphNodeSchema = z.object({
  nodeId: z.string().min(1),
  nodeType: GraphNodeTypeSchema,
  /** POSIX-normalized repo-relative path for file-ish nodes; otherwise a name. */
  path: z.string().optional(),
  name: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  edgeType: GraphEdgeTypeSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const KnowledgeGraphSummarySchema = z.object({
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  entrypoints: z.array(z.string()),
  buildSystem: z.string().nullable(),
  packageManager: z.string().nullable(),
  testFrameworks: z.array(z.string()),
  loc: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  /** Things the recon phase could not determine. Surfaced honestly to the user. */
  unknowns: z.array(z.string()),
});
export type KnowledgeGraphSummary = z.infer<typeof KnowledgeGraphSummarySchema>;

export const KnowledgeGraphSchema = z.object({
  summary: KnowledgeGraphSummarySchema,
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraphSchema>;
