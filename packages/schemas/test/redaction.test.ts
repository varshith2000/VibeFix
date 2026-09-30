import { describe, expect, it } from "vitest";
import { redactSecrets, redactUnknown } from "../src/index.js";

describe("secret boundary redaction", () => {
  it("redacts credential shapes from text", () => {
    const canaries = [
      "Authorization: Bearer super-secret-token-123456789",
      "api_key='abcdefghijklmnopqrstuvwx'",
      "https://user:password@example.com/repo.git",
      "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
    ];
    for (const canary of canaries) {
      const result = redactSecrets(canary);
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("super-secret-token-123456789");
      expect(result).not.toContain("abcdefghijklmnopqrstuvwx");
      expect(result).not.toContain("user:password@");
      expect(result).not.toContain("secret-material");
    }
  });

  it("redacts sensitive structured fields recursively", () => {
    expect(redactUnknown({ nested: { apiToken: "canary", safe: "visible" } })).toEqual({
      nested: { apiToken: "[REDACTED]", safe: "visible" },
    });
  });
});
