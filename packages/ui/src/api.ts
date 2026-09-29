import type { AgentDefinition, ChangeProposal, Finding, LedgerEntry, RepoConfig, Report, RunEvent, RunState } from "./types";

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return res.json() as Promise<T>;
};

/** base64url, matching Node's Buffer.toString("base64url"). */
export function encPath(repoPath: string): string {
  return btoa(repoPath).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Run endpoints are project-scoped on the server (`/api/projects/:enc/runs/:runId/…`)
 * — every run operation names the project it belongs to, so a runId from one
 * repository can never be acted on through another project's URL.
 */
const runUrl = (repoPath: string, runId: string, suffix = "") =>
  `/api/projects/${encPath(repoPath)}/runs/${runId}${suffix}`;

export const api = {
  agents: () => fetch("/api/agents").then(json<AgentDefinition[]>),

  /** initGit: initialize a git repository (with a baseline commit) when the
   *  folder has no git trace — VibeFix needs git for its worktree safety. */
  openProject: (repoPath: string, initGit?: boolean) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath, initGit: initGit || undefined }),
    }).then(
      json<{
        repoPath: string;
        runs: Array<{ runId: string; status: string; phase: string; createdAt: string }>;
      }>,
    ),

  createRun: (repoPath: string, mode: string) =>
    fetch(`/api/projects/${encPath(repoPath)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<{ runId: string; state: RunState }>),

  run: (repoPath: string, runId: string) => fetch(runUrl(repoPath, runId)).then(json<RunState>),

  events: (repoPath: string, runId: string, since = 0) =>
    fetch(`${runUrl(repoPath, runId)}/events?since=${since}`).then(json<{ events: RunEvent[] }>),

  findings: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/findings")).then(json<{ findings: Finding[] }>),

  intelligence: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/intelligence")).then(json<import("./types").ProjectIntelligence>),

  backlog: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/backlog")).then(
      json<{ proposals: ChangeProposal[]; unaddressedFindings: Array<{ findingId: string; reason: string }> }>,
    ),

  ledger: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/ledger")).then(json<{ entries: LedgerEntry[] }>),

  report: (repoPath: string, runId: string) => fetch(runUrl(repoPath, runId, "/report")).then(json<Report>),

  approve: (repoPath: string, runId: string, mode: string, approvedProposalIds: string[]) =>
    fetch(runUrl(repoPath, runId, "/approve"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, approvedProposalIds }),
    }).then(json<{ ok: boolean }>),

  reject: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/reject"), { method: "POST" }).then(json<{ ok: boolean }>),

  abort: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/abort"), { method: "POST" }).then(json<{ ok: boolean }>),

  resume: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/resume"), { method: "POST" }).then(json<{ ok: boolean }>),

  config: (repoPath: string) => fetch(`/api/projects/${encPath(repoPath)}/config`).then(json<RepoConfig>),

  saveConfig: (repoPath: string, config: RepoConfig) =>
    fetch(`/api/projects/${encPath(repoPath)}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }).then(json<{ ok: boolean }>),

  cloneGitHub: (url: string, token?: string) =>
    fetch("/api/projects/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, token: token || undefined }),
    }).then(json<{ repoPath: string; name: string }>),

  browseFs: (dir?: string) =>
    fetch(`/api/fs/browse${dir ? `?path=${encodeURIComponent(dir)}` : ""}`).then(
      json<{ path: string; parent: string | null; dirs: string[]; gitDirs?: string[]; drives?: string[]; error?: string }>,
    ),

  tree: (repoPath: string) =>
    fetch(`/api/projects/${encPath(repoPath)}/tree`).then(
      json<{
        files: Array<{ path: string; language: string | null; loc: number }>;
        summary: { languages: Array<{ language: string; loc: number; fileCount: number }>; frameworks: string[]; totalLoc: number; entrypoints: string[] };
      }>,
    ),

  file: (repoPath: string, path: string) =>
    fetch(`/api/projects/${encPath(repoPath)}/file?path=${encodeURIComponent(path)}`).then(
      json<{ path: string; content: string; truncated: boolean }>,
    ),

  usage: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/usage")).then(
      json<{ total: number; byAgent: Record<string, number>; byProvider: Record<string, number> }>,
    ),

  openRun: (repoPath: string, runId: string) =>
    fetch(runUrl(repoPath, runId, "/open"), { method: "POST" }).then(json<{ runId: string }>),
};
