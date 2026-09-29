import { z } from "zod";
import { RefactoringModeSchema } from "./mode.js";

export const CloneProjectRequestSchema = z.object({
  url: z.string().trim().min(1).max(500),
  token: z.string().min(1).max(4096).optional(),
}).strict();

export const OpenProjectRequestSchema = z.object({
  repoPath: z.string().min(1),
  initGit: z.boolean().optional(),
}).strict();

export const CreateRunRequestSchema = z.object({
  mode: RefactoringModeSchema.optional(),
}).strict();

export const ApproveRunRequestSchema = z.object({
  mode: RefactoringModeSchema.optional(),
  approvedProposalIds: z.array(z.string().regex(/^RFC-[0-9]{3,}$/)).max(10).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).strict();

export const IdempotentCommandRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).strict();

export function parseRequestBody<T extends z.ZodTypeAny>(schema: T, body: unknown) {
  const result = schema.safeParse(body);
  if (result.success) return { success: true as const, data: result.data as z.infer<T> };
  return {
    success: false as const,
    issues: result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ path: [...issue.path, key].join("."), message: "Unrecognized key" }))
        : [{ path: issue.path.join("."), message: issue.message }],
    ),
  };
}