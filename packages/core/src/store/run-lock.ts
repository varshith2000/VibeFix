import { promises as fs } from "node:fs";
import path from "node:path";

/** Exclusive writer lease for one persisted run. */
export class RunLock {
  private static readonly activePaths = new Set<string>();
  private held = false;

  constructor(private readonly filePath: string) {}

  async acquire(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (RunLock.activePaths.has(this.filePath)) throw new Error("E_RUN_LOCKED: run writer is active in this process");
    for (;;) {
      try {
        const handle = await fs.open(this.filePath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        await handle.close();
        this.held = true;
        RunLock.activePaths.add(this.filePath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let owner: { pid?: number } = {};
        try { owner = JSON.parse(await fs.readFile(this.filePath, "utf8")) as { pid?: number }; } catch { /* stale/partial lock */ }
        if (owner.pid && isProcessAlive(owner.pid) && owner.pid !== process.pid) {
          throw new Error(`E_RUN_LOCKED: run writer is active in process ${owner.pid}`);
        }
        await fs.rm(this.filePath, { force: true });
      }
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    RunLock.activePaths.delete(this.filePath);
    await fs.rm(this.filePath, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}
