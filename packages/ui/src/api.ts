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
};
