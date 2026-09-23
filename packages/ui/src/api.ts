import type { AgentDefinition, ChangeProposal, Finding, LedgerEntry, RepoConfig, Report, RunEvent, RunState } from "./types";

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return res.json() as Promise<T>;
};

/** base64url, matching Node's Buffer.toString("base64url"). */
function encPath(repoPath: string): string {
  return btoa(repoPath).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const api = {
  agents: () => fetch("/api/agents").then(json<AgentDefinition[]>),

  openProject: (repoPath: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
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

  run: (runId: string) => fetch(`/api/runs/${runId}`).then(json<RunState>),

  events: (runId: string, since = 0) =>
    fetch(`/api/runs/${runId}/events?since=${since}`).then(json<{ events: RunEvent[] }>),

  findings: (runId: string) => fetch(`/api/runs/${runId}/findings`).then(json<{ findings: Finding[] }>),

  intelligence: (runId: string) =>
    fetch(`/api/runs/${runId}/intelligence`).then(json<import("./types").ProjectIntelligence>),

  backlog: (runId: string) =>
    fetch(`/api/runs/${runId}/backlog`).then(
      json<{ proposals: ChangeProposal[]; unaddressedFindings: Array<{ findingId: string; reason: string }> }>,
    ),

  ledger: (runId: string) => fetch(`/api/runs/${runId}/ledger`).then(json<{ entries: LedgerEntry[] }>),

  report: (runId: string) => fetch(`/api/runs/${runId}/report`).then(json<Report>),

  approve: (runId: string, mode: string, approvedProposalIds: string[]) =>
    fetch(`/api/runs/${runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, approvedProposalIds }),
    }).then(json<{ ok: boolean }>),

  reject: (runId: string) =>
    fetch(`/api/runs/${runId}/reject`, { method: "POST" }).then(json<{ ok: boolean }>),

  abort: (runId: string) =>
    fetch(`/api/runs/${runId}/abort`, { method: "POST" }).then(json<{ ok: boolean }>),

  resume: (runId: string) =>
    fetch(`/api/runs/${runId}/resume`, { method: "POST" }).then(json<{ ok: boolean }>),

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

  usage: (runId: string) =>
    fetch(`/api/runs/${runId}/usage`).then(
      json<{ total: number; byAgent: Record<string, number>; byProvider: Record<string, number> }>,
    ),

  openRun: (repoPath: string, runId: string) =>
    fetch(`/api/projects/${encPath(repoPath)}/runs/${runId}/open`, { method: "POST" }).then(
      json<{ runId: string }>,
    ),
};
