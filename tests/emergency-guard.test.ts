import { describe, expect, it } from "bun:test";
import { planElision, selectElideCandidates, applyElision, elideLabel } from "../src/kernel/guard.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/kernel/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";

describe("Emergency guard test (overflow elision)", () => {
  it("leaves context untouched when under emergency threshold", () => {
    const candidates = [
      { ref: "m00003", index: 2, tokens: 10_000, turn: 2 },
      { ref: "m00005", index: 4, tokens: 15_000, turn: 2 },
    ];
    const plan = planElision({
      projectedTokens: 80_000,
      windowTokens: 100_000,
      candidates,
      thresholds: { elideFillPct: 0.85, targetFillPct: 0.7 },
    });

    expect(plan.elided.length).toBe(0);
  });

  it("plans elision to bring context below target fill when crossing emergency threshold", () => {
    const candidates = [
      { ref: "m00003", index: 2, tokens: 10_000, turn: 2 },
      { ref: "m00005", index: 4, tokens: 15_000, turn: 2 },
      { ref: "m00007", index: 6, tokens: 5_000, turn: 2 },
    ];
    // 90K / 100K = 90% >= 85% elideFillPct. Target = 70K
    const plan = planElision({
      projectedTokens: 90_000,
      windowTokens: 100_000,
      candidates,
      thresholds: { elideFillPct: 0.85, targetFillPct: 0.7 },
    });

    // Shed at least 20K to get <= 70K.
    // Cache-aware elision prefers candidates near the tail (m00007 @ index 6, m00005 @ index 4)
    // to preserve prefix cache at index 2 (m00003).
    // 15K (m00005) + 5K (m00007) = 20K shed -> 70K <= 70K.
    expect(plan.elided.length).toBe(2);
    expect(plan.elided.map((e) => e.ref)).toEqual(["m00005", "m00007"]);
  });

  it("never selects assistant, user, or thinking messages as elide candidates", () => {
    const bound = [
      { ref: "m00001", index: 0, role: "system", tokens: 500, ephemeral: true, turn: 1 },
      { ref: "m00002", index: 1, role: "user", tokens: 2_000, ephemeral: false, turn: 1 },
      { ref: "m00003", index: 2, role: "assistant", tokens: 8_000, ephemeral: false, turn: 1 },
      { ref: "m00004", index: 3, role: "toolResult", tokens: 25_000, ephemeral: false, turn: 2 },
      { ref: "m00005", index: 4, role: "assistant", tokens: 6_000, ephemeral: false, turn: 2 },
    ];

    const candidates = selectElideCandidates(bound, {
      foldedRefs: new Set<string>(),
      bookkeepingRefs: new Set<string>(),
      protectedFromTurn: 99,
      activeTurn: 0,
    });
    // ONLY the toolResult is selected! Assistant and user are excluded.
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.ref).toBe("m00004");
  });

  it("excludes folded, bookkeeping, protected-tail and active-turn tool results", () => {
    const bound = [
      { ref: "m00003", index: 2, role: "toolResult", tokens: 900, ephemeral: false, turn: 2 },
      { ref: "m00004", index: 3, role: "toolResult", tokens: 900, ephemeral: false, turn: 3 },
      { ref: "m00005", index: 4, role: "toolResult", tokens: 900, ephemeral: false, turn: 4 },
      { ref: "m00006", index: 5, role: "toolResult", tokens: 900, ephemeral: false, turn: 5 },
      { ref: "m00007", index: 6, role: "toolResult", tokens: 900, ephemeral: false, turn: 6 },
    ];

    const candidates = selectElideCandidates(bound, {
      foldedRefs: new Set(["m00004"]),
      bookkeepingRefs: new Set(["m00005"]),
      protectedFromTurn: 5,
      activeTurn: 6,
    });

    expect(candidates.map((c) => c.ref)).toEqual(["m00003"]);
  });

  it("applies elision labels cleanly to tool results while preserving assistant signed thinking", () => {
    interface TestMsg {
      role: string;
      content: unknown;
    }

    const messages: TestMsg[] = [
      { role: "user", content: "read a huge log file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "analyzing log data...", thinkingSignature: "sig_log_safe" },
          { type: "text", text: "Reading the log file now." },
        ],
      },
      { role: "toolResult", content: "A".repeat(50_000) },
    ];

    const plan = {
      elided: [{ ref: "m00003", index: 2, tokens: 20_000 }],
      label: elideLabel,
    };

    const out = applyElision(
      messages,
      plan,
      () => "m00003",
      (m, label) => ({ ...m, content: label }),
    );

    expect(out.length).toBe(3);
    // Assistant message and signed thinking remain completely byte-exact
    const asst = out[1]!.content as { type: string; thinkingSignature?: string }[];
    expect(asst[0]!.type).toBe("thinking");
    expect(asst[0]!.thinkingSignature).toBe("sig_log_safe");

    // Tool result is replaced with clean elide label
    expect(out[2]!.content).toBe("[#m00003 · 20,000t · elided]");
  });

  it("engine render integrates emergency elision without touching the protected tail", () => {
    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "m0", message: { role: "system", content: "system prompt" } },
      { type: "message", id: "m1", message: { role: "user", content: "prepare command" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "prepared" } },
      { type: "message", id: "m3", message: { role: "user", content: "run command" } },
      { type: "message", id: "m4", message: { role: "assistant", content: "running..." } },
      { type: "message", id: "m5", message: { role: "toolResult", content: "old output\n" + "X".repeat(5000) } },
      { type: "message", id: "m6", message: { role: "assistant", content: "done" } },
      { type: "message", id: "m7", message: { role: "user", content: "next prompt" } },
      { type: "message", id: "m8", message: { role: "toolResult", content: "recent output\n" + "Y".repeat(6000) } },
      { type: "message", id: "m9", message: { role: "assistant", content: "a" } },
      { type: "message", id: "m10", message: { role: "assistant", content: "b" } },
      { type: "message", id: "m11", message: { role: "assistant", content: "c" } },
      { type: "message", id: "m12", message: { role: "user", content: "latest prompt" } },
    ];

    let projected = 96_000;
    const host = {
      sessionId: () => "sess-guard",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/art",
      windowTokens: () => 100_000,
      projectedTokens: () => projected,
      entries: () => entries,
    };

    const config = configFromPreset("balanced");
    const engine = new OrigamiEngine({
      host,
      entries,
      modelId: "test-model",
      config,
      countFn: (t) => t.length,
    });

    const syncFacts = () => {
      engine.refresh(entries);
      const facts: KernelMessage[] = [];
      for (const e of entries) {
        const f = messageFacts(e.message);
        if (f) facts.push(f);
      }
      engine.ingest(facts);
    };

    syncFacts();

    const makeFold = (text: string, blockId: string) => ({
      role: "custom",
      customType: "origami:fold",
      blockId,
      text,
    });

    // 1. With projectedTokens at 96K (>= 95K elideFillPct): the old tool result is elided.
    const elidedRender = engine.render(entries.map((e) => e.message), makeFold);
    const oldTool = elidedRender[5] as { role: string; content: string };
    expect(oldTool.role).toBe("toolResult");
    expect(oldTool.content).toContain("· elided]");

    // The tool result inside the protected tail stays verbatim.
    const recentTool = elidedRender[8] as { role: string; content: string };
    expect(recentTool.content).toContain("recent output");

    // 2. If projectedTokens drops back to 50K (< 95K): no elision fires
    projected = 50_000;
    const normalRender = engine.render(entries.map((e) => e.message), makeFold);
    const normalToolMsg = normalRender[5] as { role: string; content: string };
    expect(normalToolMsg.content).toContain("old output");
  });

  it("does not elide after a fold reclaimed enough to clear the emergency threshold", () => {
    const journal: JournalOp[] = [];
    const M = (role: string, content: string) => ({ type: "message", message: { role, content } });
    const entries = [
      M("user", "task one"),
      M("assistant", "working one"),
      M("user", "task two"),
      M("assistant", "working two"),
      M("toolResult", "big output\n" + "X".repeat(20_000)),
      M("assistant", "done two"),
      M("user", "task three"),
      M("assistant", "three a"),
      M("assistant", "three b"),
      M("assistant", "three c"),
      M("assistant", "three d\n" + "Y".repeat(6_000)),
      M("user", "latest"),
    ];

    // Host anchor still reports the pre-fold fill: 96% of the window.
    const host = {
      sessionId: () => "sess-stale",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/art",
      windowTokens: () => 100_000,
      projectedTokens: () => 96_000,
      entries: () => entries,
    };

    const engine = new OrigamiEngine({
      host,
      entries,
      modelId: "test-model",
      config: configFromPreset("balanced"),
      countFn: (t) => t.length,
    });

    engine.refresh(entries);
    const facts: KernelMessage[] = [];
    for (const e of entries) {
      const f = messageFacts(e.message);
      if (f) facts.push(f);
    }
    engine.ingest(facts);

    // Fold the whole second turn: the re-paid prefix correction must clear the elision gate.
    const result = engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "t", summary: "s" }],
      tier: 1,
      force: true,
    });
    expect(result.ok).toBe(true);

    const rendered = engine.render(entries.map((e) => e.message), (text: string, blockId: string) => ({
      role: "custom",
      customType: "origami:fold",
      blockId,
      text,
    })) as { role: string; content: string }[];

    // The folded tool result is replaced by the block, never by an elide label.
    for (const message of rendered) {
      expect(typeof message.content === "string" ? message.content : "").not.toContain("· elided]");
    }
  });
});
