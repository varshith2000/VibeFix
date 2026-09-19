import type { EvidenceArtifact } from "./evidence.js";

/**
 * Artifact migration pipeline. Schema evolution is additive-first (new optional
 * fields need no migration). When a breaking bump happens, register a step here:
 * migrations[fromVersion] receives the raw artifact and returns the new shape.
 * Unknown future versions fail loudly in decodeArtifact.
 */
export type MigrationStep = (artifact: EvidenceArtifact) => EvidenceArtifact;

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

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
