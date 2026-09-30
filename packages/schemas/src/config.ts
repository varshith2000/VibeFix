import { z } from "zod";
import { ModelRoutingSchema } from "./routing.js";
import { RefactoringModeSchema } from "./mode.js";

/** Per-repo configuration persisted at <repo>/.vibefix/config.json. */
export const RepoConfigSchema = z.object({
  routing: ModelRoutingSchema,
  defaultMode: RefactoringModeSchema.default("minimal"),
  /** Extra user-declared do-not-touch globs, merged into forbidden zones. */
  protectedPaths: z.array(z.string()).default([]),
  /** Repository scripts are untrusted code. Execution is denied until the
   * operator explicitly enables it for this project. */
  executionPolicy: z
    .object({
      allowRepositoryCommands: z.boolean().default(false),
    })
    .default({ allowRepositoryCommands: false }),
  /** Deterministic analysis adapters (Python sidecar seam). Reserved. */
  analyzer: z
    .object({
      sidecarCommand: z.array(z.string()).optional(),
      sidecarProtocolVersion: z.literal(1).default(1),
    })
    .default({ sidecarProtocolVersion: 1 }),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
