import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import { resolveListenConfig } from "../src/main.js";
import { assertBindingAllowed } from "../src/security.js";

describe("default loopback binding and remote binding guard (SEC-01 / SEC-02)", () => {
  it("resolves 127.0.0.1:8630 by default when VIBEFIX_HOST and VIBEFIX_PORT are unset (SEC-01)", async () => {
    const config = resolveListenConfig({});
    expect(config).toEqual({ host: "127.0.0.1", port: 8630 });

    const home = await mkdtemp(path.join(tmpdir(), "vibefix-bind-test-"));
    const prevHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = home;
    const app = await buildApp(new ProjectRegistry(), { security: { token: "bind-test-token-123456" } });
    try {
      await app.listen({ host: config.host, port: 0 });
      const addr = app.server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(addr.port).toBeGreaterThan(0);
    } finally {
      await app.close();
      if (prevHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses non-loopback binding unless both VIBEFIX_ALLOW_REMOTE=1 and a strong token are provided (SEC-02)", () => {
    expect(() => assertBindingAllowed("0.0.0.0", {})).toThrow(/VIBEFIX_ALLOW_REMOTE=1/);
    expect(() => assertBindingAllowed("0.0.0.0", { VIBEFIX_ALLOW_REMOTE: "1" })).toThrow(/VIBEFIX_API_TOKEN/);
    expect(() =>
      assertBindingAllowed("0.0.0.0", {
        VIBEFIX_ALLOW_REMOTE: "1",
        VIBEFIX_API_TOKEN: "strong-explicit-token-value-123456",
      }),
    ).not.toThrow();
  });
});

