import { describe, expect, it } from "vitest";
import {
  decodeArtifact,
  encodeArtifact,
  makeArtifact,
  migrateArtifact,
  migrateRunState,
  migrateEvent,
  RepoConfigSchema,
  DEFAULT_MODEL_ROUTING,
} from "../src/index.js";
import type { BacklogArtifact } from "../src/index.js";

const backlog: BacklogArtifact = {
  proposals: [
    {
      proposalId: "RFC-001",
      title: "deduplicate: format user",
      problem: "three copies of formatting",
      evidence: ["FND-001"],
      filesInScope: ["src/utils.js"],
      filesOutOfScope: ["package.json"],
      risk: { value: 25, band: "low", factors: [{ key: "testCoverage", weight: 5 }] },
      expectedBenefit: ["one source of truth"],
      constraints: ["no-public-api-change"],
      minimalChange: true,
      testsRequired: [],
      rollbackStrategy: { type: "discardWorktree" },
      approvalStatus: "pending",
      priority: 0.9,
      allowedInModes: ["minimal", "architecture"],
    },
  ],
  unaddressedFindings: [],
};

describe("artifact codec", () => {
  it("defaults repository command execution to denied", () => {
    const config = RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
    expect(config.executionPolicy.allowRepositoryCommands).toBe(false);
  });

  it("round-trips a valid backlog artifact", () => {
    const artifact = makeArtifact({
      artifactId: "art_test1",
      kind: "backlog",
      producer: "synthesis",
      runId: "run_test",
      data: backlog,
    });
    const { json } = encodeArtifact(artifact);
    const decoded = decodeArtifact(JSON.parse(json));
    expect(decoded.kind).toBe("backlog");
    expect((decoded.data as BacklogArtifact).proposals[0]!.proposalId).toBe("RFC-001");
  });

  it("rejects an invalid payload loudly", () => {
    const artifact = makeArtifact({
      artifactId: "art_test2",
      kind: "backlog",
      producer: "synthesis",
      runId: "run_test",
      data: { nonsense: true },
    });
    expect(() => encodeArtifact(artifact)).toThrow();
  });

  it("rejects unknown future schema versions", () => {
    const artifact = {
      ...makeArtifact({ artifactId: "art_test3", kind: "backlog", producer: "synthesis", runId: "run_test", data: backlog }),
      schemaVersion: 99,
    };
    expect(() => decodeArtifact(artifact)).toThrow(/upgrade VibeFix|No migration/);
  });

  it("fails loudly when a migration step is missing (MIG-03)", () => {
    const older = {
      ...makeArtifact({ artifactId: "art_test4", kind: "backlog", producer: "synthesis", runId: "run_test", data: backlog }),
      schemaVersion: 0,
    };
    expect(() => migrateArtifact(older as never)).toThrow(/No migration from artifact schemaVersion 0 for artifact art_test4/);
  });

  it("validates and rejects future or unsupported versions for RunState and Event schemas (MIG-02)", () => {
    const validState = {
      runId: "run_abc123",
      repoPath: "/tmp/repo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      phase: "recon",
      mode: "minimal",
      agentStates: {},
      execution: { queue: [], currentIndex: 0, attempt: 0, stage: "implement" },
      approval: { requested: false, decidedAt: null, approvedItems: [], mode: null },
      budget: { tokensSpent: 0, changesCommitted: 0, retriesUsed: 0 },
      error: null,
      schemaVersion: 1,
    };
    expect(migrateRunState(validState).runId).toBe("run_abc123");
    expect(() => migrateRunState({ ...validState, schemaVersion: 99 })).toThrow(/upgrade VibeFix/);
    expect(() => migrateRunState({ ...validState, schemaVersion: 0 })).toThrow(/No migration/);

    const validEvent = {
      eventId: "evt_1",
      runId: "run_abc123",
      ts: new Date().toISOString(),
      seq: 1,
      type: "log",
      message: "ok",
    };
    expect(migrateEvent(validEvent).schemaVersion).toBe(1);
    expect(() => migrateEvent({ ...validEvent, schemaVersion: 99 })).toThrow(/upgrade VibeFix/);
  });
});
