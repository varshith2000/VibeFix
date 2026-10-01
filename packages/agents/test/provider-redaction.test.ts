import { describe, expect, it } from "vitest";
import type { TextGenerationClient } from "@vibefix/llm";
import { redactTextClient } from "../src/executor.js";

describe("provider secret boundary", () => {
  it("redacts repository credentials before a text provider sees them", async () => {
    let seen = "";
    const client: TextGenerationClient = {
      kind: "TextGeneration",
      providerId: "test",
      model: "test",
      complete: async (options) => {
        seen = `${options.system ?? ""}\n${options.messages.map((message) => message.content).join("\n")}`;
        return { text: "ok", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: "test", providerId: "test" };
      },
    };
    const protectedClient = redactTextClient(client)!;
    await protectedClient.complete({
      system: "Review this repository",
      messages: [{ role: "user", content: "API_KEY=super-secret-canary" }],
    });
    expect(seen).not.toContain("super-secret-canary");
    expect(seen).toContain("[REDACTED]");
  });
});
