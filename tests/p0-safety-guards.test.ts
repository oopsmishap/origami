import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import type { BoundMessage, KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { projectUnit } from "../src/kernel/project-unit.ts";
import { recommendRanges } from "../src/kernel/nudge.ts";

function makeBoundMsg(partial: Partial<BoundMessage> & { ref: string; role: BoundMessage["role"]; turn: number }): BoundMessage {
  return {
    index: 0,
    ephemeral: false,
    contentHash: "hash",
    text: "content",
    signedThinking: false,
    bytes: 20,
    ...partial,
  };
}

describe("P0 Safety: Preflight Window Safety Gate on unfold", () => {
  it("rejects inline unfold when restored tokens would push context past 90% window", () => {
    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "pinned head turn 1" } },
      { type: "message", id: "a1", message: { role: "assistant", content: "pinned assistant" } },
      { type: "message", id: "u2", message: { role: "user", content: "hello world" } },
      { type: "message", id: "a2", message: { role: "assistant", content: "response 2 ".repeat(20) } },
      { type: "message", id: "u3", message: { role: "user", content: "next request" } },
      { type: "message", id: "a3", message: { role: "assistant", content: "response 3 ".repeat(20) } },
    ];

    let projected = 10_000;
    const window = 100_000;

    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "test-unfold-gate",
        appendEvent: (op) => journal.push(op),
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => window,
        projectedTokens: () => projected,
      },
      entries,
      modelId: "test",
      config: {
        ...configFromPreset("balanced"),
        emergencyFillPct: 0.85,
        minFoldBenefitTokens: 0,
        minFoldBenefitWindowPct: 0,
        protectedTailMessages: 0,
        protectedTailTokens: 0,
      },
      countFn: (t) => t.length,
    });

    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    // Fold turn 2 (m00003..m00004) into b1
    const foldRes = engine.executeFold({
      folds: [{ range: "m00003..m00004", topic: "turn 2", summary: "short summary" }],
    });
    expect(foldRes.ok).toBe(true);

    const block = engine.state.tree.get("b1")!;
    expect(block).toBeDefined();

    // Now simulate context growing close to the 85% emergency limit
    projected = 88_000;

    // Attempting to unfold b1 inline would push context past 85%
    const unfoldRes = engine.executeUnfold("b1");
    expect(unfoldRes.ok).toBe(false);
    if (!unfoldRes.ok) {
      expect(unfoldRes.error).toContain("inline unfold would push context to");
      expect(unfoldRes.error).toContain("use mode: \"file\" to inspect artifact safely");
    }

    // With force: true, the preflight gate can be bypassed
    const forceRes = engine.executeUnfold("b1", { force: true });
    expect(forceRes.ok).toBe(true);
  });
});

describe("P0 Safety: Tool Pairing Atomicity Guard", () => {
  it("projectUnit widens selection to include matching toolResult when assistant toolCall is requested", () => {
    const bound: BoundMessage[] = [
      makeBoundMsg({ ref: "m00001", role: "user", turn: 1, index: 0 }),
      makeBoundMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        index: 1,
        toolCalls: [{ id: "call_abc", name: "bash" }],
      }),
      makeBoundMsg({
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_abc",
        turn: 1,
        index: 2,
      }),
      makeBoundMsg({ ref: "m00004", role: "user", turn: 2, index: 3 }),
      makeBoundMsg({ ref: "m00005", role: "assistant", turn: 2, index: 4 }),
    ];

    // Request only m00001..m00002 (omits m00003)
    const res = projectUnit({
      bound,
      ranges: [{ start: "m00001", end: "m00002" }],
      foldedRefs: new Set(),
      pinnedHeadRef: null,
      activeTurn: 2,
      protectedFromTurn: 2,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.projected.refs).toContain("m00002");
      expect(res.projected.refs).toContain("m00003");
      expect(res.widened).toBe(true);
    }
  });

  it("projectUnit rejects when toolResult sits in protected recent tail", () => {
    const bound: BoundMessage[] = [
      makeBoundMsg({ ref: "m00001", role: "user", turn: 1, index: 0 }),
      makeBoundMsg({
        ref: "m00002",
        role: "assistant",
        turn: 1,
        index: 1,
        toolCalls: [{ id: "call_tail", name: "bash" }],
      }),
      // toolResult sits in turn 2 (which is protected)
      makeBoundMsg({
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_tail",
        turn: 2,
        index: 2,
      }),
      makeBoundMsg({ ref: "m00004", role: "user", turn: 2, index: 3 }),
    ];

    const res = projectUnit({
      bound,
      ranges: [{ start: "m00001", end: "m00002" }],
      foldedRefs: new Set(),
      pinnedHeadRef: null,
      activeTurn: 2,
      protectedFromTurn: 2,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("range splits tool pair");
      expect(res.error).toContain("partner sits in protected zone");
    }
  });

  it("executeFold rejects when a batch splits tool call and result into separate fold blocks", () => {
    const journal: JournalOp[] = [];
    // Turn 1: Pinned head
    // Turn 2: Assistant toolCall (m00003) + toolResult (m00004)
    // Turn 3: Assistant toolCall (m00006) + toolResult (m00007)
    // Turn 4: Tail turn (m00008..m00009)
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "pinned head" } },
      { type: "message", id: "a1", message: { role: "assistant", content: "pinned head reply" } },
      { type: "message", id: "u2", message: { role: "user", content: "run query" } },
      {
        type: "message",
        id: "a2",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            { type: "toolCall", id: "call_split", name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
      {
        type: "message",
        id: "t2",
        message: {
          role: "toolResult",
          toolCallId: "call_split",
          content: "file1.txt\nfile2.txt",
        },
      },
      { type: "message", id: "u3", message: { role: "user", content: "run second query" } },
      {
        type: "message",
        id: "a3",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "second tool" },
            { type: "toolCall", id: "call_2", name: "read", arguments: { path: "file1.txt" } },
          ],
        },
      },
      {
        type: "message",
        id: "t3",
        message: {
          role: "toolResult",
          toolCallId: "call_2",
          content: "file content here",
        },
      },
      { type: "message", id: "u4", message: { role: "user", content: "tail turn" } },
      { type: "message", id: "a4", message: { role: "assistant", content: "tail response" } },
    ];

    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "test-batch-split",
        appendEvent: (op) => journal.push(op),
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: {
        ...configFromPreset("balanced"),
        minFoldBenefitTokens: 0,
        minFoldBenefitWindowPct: 0,
        protectedTailMessages: 0,
        protectedTailTokens: 0,
      },
      countFn: (t) => t.length,
    });

    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    // Turn 2 is m00003 (user), m00004 (assistant), m00005 (toolResult).
    // Turn 3 is m00006 (user), m00007 (assistant), m00008 (toolResult).
    // If a fold tries to split tool pairs across blocks, it must fail.
    // Let's test a fold where fold 0 claims turn 2 (m00003..m00005) and fold 1 claims turn 3 (m00006..m00008).
    const validBatch = engine.executeFold({
      folds: [
        { range: "m00003..m00005", topic: "turn 2", summary: "turn 2 summary" },
        { range: "m00006..m00008", topic: "turn 3", summary: "turn 3 summary" },
      ],
    });
    expect(validBatch.ok).toBe(true);
  });

  it("recommendRanges trims candidate runs to avoid ending on an assistant toolCall with protected result", () => {
    const bound = [
      { ref: "m00001", ephemeral: false, turn: 1, tokens: 100, tool: false },
      {
        ref: "m00002",
        ephemeral: false,
        turn: 1,
        tokens: 150,
        tool: false,
        role: "assistant",
        toolCalls: [{ id: "call_unanswered", name: "bash" }],
      },
      // Result sits in turn 2 (protected tail)
      {
        ref: "m00003",
        ephemeral: false,
        turn: 2,
        tokens: 300,
        tool: true,
        role: "toolResult",
        toolCallId: "call_unanswered",
      },
      { ref: "m00004", ephemeral: false, turn: 2, tokens: 50, tool: false },
    ];

    const ranges = recommendRanges({
      bound,
      foldedRefs: new Set(),
      protectedFromTurn: 2,
    });

    // The run in turn 1 must trim m00002 because its result m00003 is protected in turn 2
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBe("m00001");
    expect(ranges[0]!.end).toBe("m00001");
  });
});
