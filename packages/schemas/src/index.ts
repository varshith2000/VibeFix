import { z } from "zod";
import { EvidenceArtifactSchema, type EvidenceArtifact } from "./evidence.js";
import type { ArtifactKind } from "./agent.js";
import { KnowledgeGraphSchema } from "./graph.js";
import { FindingsArtifactSchema, RiskAssessmentsArtifactSchema } from "./finding.js";
import {
  BacklogArtifactSchema,
  BehavioralBaselineArtifactSchema,
  ChangeAttemptArtifactSchema,
  VerdictArtifactSchema,
} from "./proposal.js";
import {
  CharacterizationPlanSchema,
  FirewallViolationSchema,
  TestSurveyArtifactSchema,
} from "./survey.js";
import { ReportArtifactSchema } from "./report.js";
import { migrateArtifact, ARTIFACT_SCHEMA_VERSION } from "./migrations.js";

export * from "./agent.js";
export * from "./mode.js";
export * from "./run.js";
export * from "./events.js";
export * from "./evidence.js";
export * from "./graph.js";
export * from "./finding.js";
export * from "./proposal.js";
export * from "./routing.js";
export * from "./config.js";
export * from "./survey.js";
export * from "./report.js";
export { ARTIFACT_SCHEMA_VERSION, migrateArtifact } from "./migrations.js";

/** kind -> payload schema. The single registry that makes artifact I/O typed. */
export const ARTIFACT_PAYLOAD_SCHEMAS: Record<ArtifactKind, z.ZodTypeAny> = {
  "knowledge-graph": KnowledgeGraphSchema,
  "test-survey": TestSurveyArtifactSchema,
  findings: FindingsArtifactSchema,
  "risk-assessments": RiskAssessmentsArtifactSchema,
  backlog: BacklogArtifactSchema,
  "characterization-plan": CharacterizationPlanSchema,
  "behavioral-baseline": BehavioralBaselineArtifactSchema,
  "change-attempt": ChangeAttemptArtifactSchema,
  verdict: VerdictArtifactSchema,
  "firewall-violation": FirewallViolationSchema,
  report: ReportArtifactSchema,
};

/**
 * Validate + migrate a raw artifact read from disk.
 * Throws with the artifactId on any mismatch — fail loudly, never silently drop.
 */
export function decodeArtifact(raw: unknown): EvidenceArtifact {
  const parsed = EvidenceArtifactSchema.parse(raw);
  const migrated = migrateArtifact(parsed);
  const payloadSchema = ARTIFACT_PAYLOAD_SCHEMAS[migrated.kind];
  if (!payloadSchema) {
    throw new Error(`Unknown artifact kind '${migrated.kind}' (${migrated.artifactId})`);
  }
  const payload = payloadSchema.parse(migrated.data);
  return { ...migrated, data: payload };
}

/** Validate an artifact about to be written. Symmetric with decodeArtifact. */
export function encodeArtifact(
  artifact: EvidenceArtifact,
): { envelope: EvidenceArtifact; json: string } {
  const payloadSchema = ARTIFACT_PAYLOAD_SCHEMAS[artifact.kind];
  if (!payloadSchema) {
    throw new Error(`Unknown artifact kind '${artifact.kind}'`);
  }
  const validated = payloadSchema.parse(artifact.data);
  const envelope = EvidenceArtifactSchema.parse({ ...artifact, data: validated });
  return { envelope, json: JSON.stringify(envelope, null, 2) };
}
