import { z } from "zod";
import { ArtifactKindSchema } from "./agent.js";

/**
 * The envelope for every artifact in the Evidence Store. Agents never talk to
 * each other — they write these typed artifacts to disk and read each other's.
 * Artifacts are immutable once written (a new attempt writes a new artifactId).
 */
export const EvidenceArtifactSchema = z.object({
  artifactId: z.string().regex(/^art_[0-9a-z]+$/),
  kind: ArtifactKindSchema,
  /** agentId of the producer (or 'orchestrator' for framework-written artifacts). */
  producer: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  /** The typed payload; shape determined by `kind`. */
  data: z.unknown(),
  /** Wide on read; decodeArtifact routes unknown versions through migrations. */
  schemaVersion: z.number().int().positive(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

/** Helper to construct an artifact envelope without manual id minting. */
export function makeArtifact(input: {
  kind: z.infer<typeof ArtifactKindSchema>;
  producer: string;
  runId: string;
  data: unknown;
  artifactId: string;
  createdAt?: string;
}): EvidenceArtifact {
  return {
    artifactId: input.artifactId,
    kind: input.kind,
    producer: input.producer,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    data: input.data,
    schemaVersion: 1,
  };
}
