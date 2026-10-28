import { describe, expect, it } from "bun:test";
import { messageFacts } from "../src/kernel/message-facts.ts";

describe("Tool Call Assistant Message Fingerprinting (#4110)", () => {
  it("extracts tool_calls from top-level OpenAI wire format and creates non-empty contentHash", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"sf"}' },
        },
      ],
    };

    const facts = messageFacts(msg);
    expect(facts).not.toBeNull();
    if (!facts) return;

    expect(facts.toolCalls).toBeDefined();
    expect(facts.toolCalls).toHaveLength(1);
    expect(facts.toolCalls?.[0]?.id).toBe("call_abc123");
    expect(facts.toolCalls?.[0]?.name).toBe("get_weather");
    expect(facts.text).toContain("toolCall:call_abc123:get_weather");
    expect(facts.contentHash).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"); // Not sha256("")
  });

  it("produces distinct content hashes for different call IDs preventing cross-session collisions (#4110)", () => {
    const msgA = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_AAA", function: { name: "tool1", arguments: "{}" } }],
    };
    const msgB = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_BBB", function: { name: "tool1", arguments: "{}" } }],
    };

    const factsA = messageFacts(msgA);
    const factsB = messageFacts(msgB);

    expect(factsA?.contentHash).toBeDefined();
    expect(factsB?.contentHash).toBeDefined();
    expect(factsA?.contentHash).not.toBe(factsB?.contentHash);
  });

  it("supports top-level camelCase toolCalls array", () => {
    const msg = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_camel", name: "fetch_data", arguments: { page: 1 } }],
    };

    const facts = messageFacts(msg);
    expect(facts?.toolCalls).toEqual([{ id: "call_camel", name: "fetch_data" }]);
    expect(facts?.text).toContain("toolCall:call_camel:fetch_data");
  });
});
