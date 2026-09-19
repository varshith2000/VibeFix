import { z } from "zod";

/**
 * Refactoring modes — the user's declared appetite for intervention.
 * Ordered from most conservative to most aggressive. Every ChangeProposal
 * declares which modes it is allowed in; the checkpoint filters by the
 * chosen mode; the engineer's charter gets mode constraints injected.
 */
export const RefactoringModeSchema = z.enum(["minimal", "architecture", "modernization"]);
export type RefactoringMode = z.infer<typeof RefactoringModeSchema>;

export const REFACTORING_MODES: readonly RefactoringMode[] = ["minimal", "architecture", "modernization"];

/**
 * Modes are ordered: a proposal allowed in `architecture` is also a candidate
 * whenever a *more* aggressive mode is selected? No — the semantics are
 * explicit: `allowedInModes` lists every mode in which the proposal may run.
 * This helper just checks membership.
 */
export function modeAllows(proposalModes: readonly RefactoringMode[], selected: RefactoringMode): boolean {
  return proposalModes.includes(selected);
}
