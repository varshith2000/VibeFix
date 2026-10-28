import { describe, expect, it } from "vitest";
import { redactSecrets, redactUnknown } from "../src/index.js";

describe("secret boundary redaction", () => {
  it("redacts credential shapes from text", () => {
    const canaries = [
      "Authorization: Bearer super-secret-token-123456789",
      "Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQtYmFzaWMtdG9rZW4=",
      "api_key='abcdefghijklmnopqrstuvwx'",
      "OPENAI_API_KEY=sk-proj-canary1234567890abcdef",
      "GITHUB_TOKEN=ghp_canaryTokenValue1234567890",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "https://user:password@example.com/repo.git",
      "https://x-access-token:ghs_secretAccessToken987654321@github.com/owner/repo.git",
      "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
    ];
    for (const canary of canaries) {
      const result = redactSecrets(canary);
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("super-secret-token-123456789");
      expect(result).not.toContain("dXNlcjpzdXBlci1zZWNyZXQtYmFzaWMtdG9rZW4=");
      expect(result).not.toContain("abcdefghijklmnopqrstuvwx");
      expect(result).not.toContain("sk-proj-canary1234567890abcdef");
      expect(result).not.toContain("ghp_canaryTokenValue1234567890");
      expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result).not.toContain("user:password@");
      expect(result).not.toContain("ghs_secretAccessToken987654321");
      expect(result).not.toContain("secret-material");
    }
  });

  it("redacts sensitive structured fields recursively while preserving token count metrics", () => {
    expect(
      redactUnknown({
        nested: { apiToken: "canary", safe: "visible", tokensSpent: 420, runMaxTokens: 1000 },
      }),
    ).toEqual({
      nested: { apiToken: "[REDACTED]", safe: "visible", tokensSpent: 420, runMaxTokens: 1000 },
    });
  });
});
