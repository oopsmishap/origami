import { describe, expect, it } from "bun:test";
import {
  computeToolPairGroups,
  buildToolPairPartnerMap,
  widenSelectedToolPairs,
} from "../src/kernel/tool-pairs.ts";
import type { BoundMessage } from "../src/kernel/types.ts";

function makeMsg(partial: Partial<BoundMessage> & { ref: string; role: BoundMessage["role"] }): BoundMessage {
  return {
    index: 0,
    ephemeral: false,
    turn: 1,
    contentHash: "hash",
    text: "text",
    prose: "text",
    isError: false,
    signedThinking: false,
    bytes: 10,
    ...partial,
  };
}

describe("computeToolPairGroups and buildToolPairPartnerMap", () => {
  it("groups assistant toolCall with single toolResult", () => {
    const bound: BoundMessage[] = [
      makeMsg({ ref: "m00001", role: "user", turn: 1 }),
      makeMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        toolCalls: [{ id: "call_1", name: "read", arguments: null }],
      }),
      makeMsg({
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_1",
        turn: 1,
      }),
    ];

    const groups = computeToolPairGroups(bound);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.callRef).toBe("m00002");
    expect(groups[0]!.resultRefs).toEqual(["m00003"]);
    expect([...groups[0]!.allRefs].sort()).toEqual(["m00002", "m00003"]);

    const map = buildToolPairPartnerMap(bound);
    expect(map.get("m00001")).toBeUndefined();
    expect([...map.get("m00002")!].sort()).toEqual(["m00002", "m00003"]);
    expect([...map.get("m00003")!].sort()).toEqual(["m00002", "m00003"]);
  });

  it("groups assistant with multiple parallel toolCalls and matching results", () => {
    const bound: BoundMessage[] = [
      makeMsg({ ref: "m00001", role: "user", turn: 1 }),
      makeMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        toolCalls: [
          { id: "call_a", name: "read", arguments: null },
          { id: "call_b", name: "grep", arguments: null },
        ],
      }),
      makeMsg({ ref: "m00003", role: "toolResult", toolCallId: "call_a", turn: 1 }),
      makeMsg({ ref: "m00004", role: "toolResult", toolCallId: "call_b", turn: 1 }),
    ];

    const groups = computeToolPairGroups(bound);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.resultRefs).toEqual(["m00003", "m00004"]);
    expect([...groups[0]!.allRefs].sort()).toEqual(["m00002", "m00003", "m00004"]);
  });
});

describe("widenSelectedToolPairs", () => {
  it("widens when missing partner is eligible", () => {
    const bound: BoundMessage[] = [
      makeMsg({ ref: "m00001", role: "user", turn: 1, index: 0 }),
      makeMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        index: 1,
        toolCalls: [{ id: "call_1", name: "read", arguments: null }],
      }),
      makeMsg({
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_1",
        turn: 1,
        index: 2,
      }),
    ];

    // Only m00002 selected
    const selected = new Set<number>([1]);
    const res = widenSelectedToolPairs({
      selected,
      bound,
      isEligible: (idx) => idx !== 0, // all except user
    });

    expect(res.widened).toBe(true);
    expect(res.split).toBeUndefined();
    expect([...selected].sort()).toEqual([1, 2]);
  });

  it("fails with split when partner is protected", () => {
    const bound: BoundMessage[] = [
      makeMsg({ ref: "m00001", role: "user", turn: 1, index: 0 }),
      makeMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        index: 1,
        toolCalls: [{ id: "call_1", name: "read", arguments: null }],
      }),
      makeMsg({
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_1",
        turn: 2, // In turn 2
        index: 2,
      }),
    ];

    // Only m00002 selected, but index 2 (m00003) is in turn 2 which is protected
    const selected = new Set<number>([1]);
    const res = widenSelectedToolPairs({
      selected,
      bound,
      isEligible: (idx) => idx < 2, // index 2 is protected
    });

    expect(res.split).toBeDefined();
    expect(res.split?.callerRef).toBe("m00002");
    expect(res.split?.partnerRef).toBe("m00003");
  });
});
