import { promises as fs } from "node:fs";
import path from "node:path";
import {
  decodeArtifact,
  encodeArtifact,
  redactUnknown,
  type ArtifactKind,
  type EvidenceArtifact,
} from "@vibefix/schemas";
import { artifactId } from "../util/ids.js";
import type { RunPaths } from "./paths.js";

/** Read side: what agents consume. */
export interface EvidenceReader {
  list(producer?: string, kind?: ArtifactKind): Promise<EvidenceArtifact[]>;
  latest(kind: ArtifactKind): Promise<EvidenceArtifact | null>;
  read(artifactId: string): Promise<EvidenceArtifact | null>;
  /** Resumability: has this producer already written artifacts of these kinds? */
  hasArtifacts(producer: string, kinds: readonly ArtifactKind[]): Promise<boolean>;
}

/** Write side: what agents produce. Artifacts are immutable once written. */
export interface EvidenceWriter {
  write(input: { kind: ArtifactKind; producer: string; runId: string; data: unknown }): Promise<EvidenceArtifact>;
}

export class EvidenceStore implements EvidenceReader, EvidenceWriter {
  constructor(private readonly paths: RunPaths) {}

  private producerDir(producer: string): string {
    return path.join(this.paths.evidenceDir, producer);
  }

  async write(input: {
    kind: ArtifactKind;
    producer: string;
    runId: string;
    data: unknown;
  }): Promise<EvidenceArtifact> {
    const artifact = {
      artifactId: artifactId(),
      kind: input.kind,
      producer: input.producer,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      data: redactUnknown(input.data),
      schemaVersion: 1 as const,
    };
    const { envelope, json } = encodeArtifact(artifact);
    const dir = this.producerDir(input.producer);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`[VibeFix] Failed to create producer directory ${dir}:`, err);
      throw err;
    }
    // Immutability: refuse to silently overwrite a different content at same id (ids are unique anyway).
    try {
      await atomicWrite(path.join(dir, `${envelope.artifactId}.json`), json);
    } catch (err) {
      console.error(`[VibeFix] Failed to write artifact ${envelope.artifactId}:`, err);
      throw err;
    }
    // Convenience latest-by-kind pointers at run level.
    const pointer = path.join(this.paths.evidenceDir, `latest-${envelope.kind}.json`);
    try {
      await atomicWrite(pointer, json);
    } catch (err) {
      console.error(`[VibeFix] Failed to update latest pointer for ${envelope.kind}:`, err);
      // Non-critical: the artifact itself was written successfully
    }
    return envelope;
  }

  async list(producer?: string, kind?: ArtifactKind): Promise<EvidenceArtifact[]> {
    const dirs: string[] = [];
    if (producer) {
      dirs.push(this.producerDir(producer));
    } else {
      try {
        const entries = await fs.readdir(this.paths.evidenceDir, { withFileTypes: true });
        for (const e of entries) if (e.isDirectory()) dirs.push(path.join(this.paths.evidenceDir, e.name));
      } catch {
        return [];
      }
    }
    const out: EvidenceArtifact[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
          const artifact = decodeArtifact(raw);
          if (!kind || artifact.kind === kind) out.push(artifact);
        } catch (err) {
          // Corrupt artifact: surface as unknowns rather than crashing a run.
          out.push({
            artifactId: file.replace(/\.json$/, ""),
            kind: "report",
            producer: "orchestrator",
            runId: "unknown",
            createdAt: new Date(0).toISOString(),
            data: { corrupt: true, error: String(err) },
            schemaVersion: 1,
          });
        }
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async latest(kind: ArtifactKind): Promise<EvidenceArtifact | null> {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.paths.evidenceDir, `latest-${kind}.json`), "utf8"),
      );
      return decodeArtifact(raw);
    } catch {
      return null;
    }
  }

  async read(artifactId: string): Promise<EvidenceArtifact | null> {
    const dirs = await fs.readdir(this.paths.evidenceDir, { withFileTypes: true }).catch(() => []);
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(this.paths.evidenceDir, entry.name, `${artifactId}.json`), "utf8"),
        );
        return decodeArtifact(raw);
      } catch {
        continue;
      }
    }
    return null;
  }

  async hasArtifacts(producer: string, kinds: readonly ArtifactKind[]): Promise<boolean> {
    const artifacts = await this.list(producer);
    const produced = new Set(artifacts.map((a) => a.kind));
    return kinds.every((k) => produced.has(k));
  }
}

/**
 * Atomic file write: temp file + rename, so a crash never leaves half JSON.
 * Windows-hardened: the tmp name is unique per call (two writers in the same
 * millisecond used to share a tmp file), and the rename retries — on Windows
 * renaming over a path another handle (or antivirus) still holds fails with
 * EPERM/EACCES for a few milliseconds.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${process.pid}`;
  await fs.writeFile(tmp, content, "utf8");
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      // Exponential backoff with jitter
      const delay = Math.min(100 * Math.pow(2, attempt), 1000) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => undefined);
  throw lastError;
}
