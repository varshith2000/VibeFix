import type { EvidenceArtifact } from "./evidence.js";
import { RunStateSchema, type RunState } from "./run.js";
import { AgentExecutionEventSchema, type AgentExecutionEvent } from "./events.js";

/**
 * Artifact migration pipeline. Schema evolution is additive-first (new optional
 * fields need no migration). When a breaking bump happens, register a step here:
 * migrations[fromVersion] receives the raw artifact and returns the new shape.
 * Unknown future versions fail loudly in decodeArtifact.
 */
export type MigrationStep = (artifact: EvidenceArtifact) => EvidenceArtifact;

export const ARTIFACT_SCHEMA_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;

export const migrations: Record<number, MigrationStep> = {
  // v1 is current; no steps yet.
};

export function migrateArtifact(artifact: EvidenceArtifact): EvidenceArtifact {
  let current = artifact;
  while (current.schemaVersion < ARTIFACT_SCHEMA_VERSION) {
    const step: MigrationStep | undefined = migrations[current.schemaVersion];
    if (!step) {
      throw new Error(
        `No migration from artifact schemaVersion ${current.schemaVersion} for artifact ${artifact.artifactId}`,
      );
    }
    current = step(current);
  }
  if (current.schemaVersion > ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Artifact ${artifact.artifactId} has schemaVersion ${current.schemaVersion} > supported ${ARTIFACT_SCHEMA_VERSION}; upgrade VibeFix.`,
    );
  }
  return current;
}

/** MIG-02: Validate and migrate persisted RunState (`state.json`). */
export function migrateRunState(raw: unknown): RunState {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid run state: expected an object");
  }
  const obj = { ...(raw as Record<string, unknown>) };
  const version = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 1;
  if (version > STATE_SCHEMA_VERSION) {
    throw new Error(
      `Run state has schemaVersion ${version} > supported ${STATE_SCHEMA_VERSION}; upgrade VibeFix.`,
    );
  }
  if (version < STATE_SCHEMA_VERSION) {
    throw new Error(`No migration from run state schemaVersion ${version}`);
  }
  obj.schemaVersion = 1;
  return RunStateSchema.parse(obj);
}

/** MIG-02: Validate and migrate persisted AgentExecutionEvent (`events.ndjson`). */
export function migrateEvent(raw: unknown): AgentExecutionEvent {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid event: expected an object");
  }
  const obj = { ...(raw as Record<string, unknown>) };
  const version = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 1;
  if (version > EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Event ${String(obj.eventId ?? "unknown")} has schemaVersion ${version} > supported ${EVENT_SCHEMA_VERSION}; upgrade VibeFix.`,
    );
  }
  if (version < EVENT_SCHEMA_VERSION) {
    throw new Error(`No migration from event schemaVersion ${version}`);
  }
  obj.schemaVersion = 1;
  if (typeof obj.runId !== "string") obj.runId = "run_legacy";
  if (typeof obj.ts !== "string") obj.ts = new Date(0).toISOString();
  if (!obj.data || typeof obj.data !== "object") obj.data = {};
  return AgentExecutionEventSchema.parse(obj);
}
