import { describe, expect, it } from "bun:test";
import { messageFacts } from "../src/kernel/message-facts.ts";

describe("messageFacts provenance", () => {
  it("keeps canonical text stable while separating prose and structured calls", () => {
    const raw = {
      role: "assistant",
      content: [
        { type: "text", text: "Inspect src/main.ts" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/main.ts", nested: [1, 2] } },
      ],
      tool_calls: [{ id: "c1", function: { name: "read", arguments: "duplicate" } }],
    };
    const facts = messageFacts(raw)!;
    expect(facts.text).toBe('text:Inspect src/main.ts\ntoolCall:c1:read:{"nested":[1,2],"path":"src/main.ts"}');
    expect(facts.prose).toBe("Inspect src/main.ts");
    expect(facts.toolCalls).toEqual([{ id: "c1", name: "read", arguments: { path: "src/main.ts", nested: [1, 2] } }]);
    expect(facts.contentHash).toBe(messageFacts(raw)!.contentHash);
  });

  it("preserves top-level function arguments and normalizes explicit failures only", () => {
    const assistant = messageFacts({ role: "assistant", tool_calls: [{ id: "c2", function: { name: "bash", arguments: '{"command":"false"}' } }] })!;
    expect(assistant.toolCalls).toEqual([{ id: "c2", name: "bash", arguments: '{"command":"false"}' }]);
    expect(assistant.prose).toBe("");
    expect(assistant.isError).toBe(false);
    expect(messageFacts({ role: "toolResult", content: "failed", isError: true })!.isError).toBe(true);
    expect(messageFacts({ role: "toolResult", content: "failed" })!.isError).toBe(false);
    expect(messageFacts({ role: "user", content: "failed", isError: true })!.isError).toBe(false);
  });
});
