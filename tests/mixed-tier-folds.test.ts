import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { decideNudge, type NudgeConfig, type NudgeRange, type NudgeState, type PromotionCandidate } from "../src/kernel/nudge.ts";
import { salvageFoldParams } from "../src/tools/salvage.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import type { SessionEntryLike } from "../src/kernel/registry.ts";
function conversation(turns: number) {
  const entries: { type: "message"; id: string; message: { role: string; content: string } }[] = [];
  for (let k = 1; k <= turns; k++) {
    entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user turn ${k}: ${"investigate parser token boundaries ".repeat(8)}` } });
    entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant turn ${k}: ${"found the boundary and verified fix ".repeat(8)}` } });
  }
  return entries;
}

function harness(turns = 12) {
  const entries: SessionEntryLike[] = conversation(turns);
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "sess-mixed-tier",
      appendEvent: (op) => entries.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: op }),
      saveArtifact: async () => "/tmp/art.md",
      windowTokens: () => 200_000,
      projectedTokens: () => 20_000,
    },
    entries,
    modelId: "test-model",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    countFn: (t) => t.length,
  });
  engine.refresh(entries);
  engine.ingest(entries.filter((e): e is { type: "message"; message: { role: string; content: string } } => (e as { type: string }).type === "message").map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
  return { engine, entries };
}

describe("Safe Anchor Attribution & Mixed-Tier Batch Folds", () => {
  it("safe anchor: tier 2 distillation does not advance frontier anchor or wipe turn growth", () => {
    const { engine, entries } = harness(10);

    // Initial Tier 1 fold covering m00003..m00004
    const res1 = engine.executeFold({
      folds: [{ range: "m00003..m00004", topic: "T1", summary: "Summary 1 with plenty of detail to satisfy net shrink tests later" }],
    });
    expect(res1.ok).toBe(true);

    // Second Tier 1 fold covering m00005..m00006
    const res2 = engine.executeFold({
      folds: [{ range: "m00005..m00006", topic: "T2", summary: "Summary 2 with plenty of detail to satisfy net shrink tests later" }],
    });
    expect(res2.ok).toBe(true);

    // Turn 11 completes and Turn 12 starts, producing growth since the fold
    entries.push({ type: "message", id: "u11", message: { role: "user", content: "turn 11 completed user text with lots of tokens ".repeat(6) } });
    entries.push({ type: "message", id: "a11", message: { role: "assistant", content: "turn 11 completed asst text with lots of tokens ".repeat(6) } });
    entries.push({ type: "message", id: "u12", message: { role: "user", content: "turn 12 in-flight user text" } });
    engine.refresh(entries);
    engine.ingest(entries.filter((e): e is { type: "message"; message: { role: string; content: string } } => (e as { type: string }).type === "message").map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    const growthBefore = engine.status().growthSinceFold;
    expect(growthBefore).toBeGreaterThan(0);

    // Now execute Tier 2 distillation of b1 and b2 with a compact merged summary
    const resDistill = engine.executeFold({
      folds: [{ range: "b1,b2", topic: "Distilled", summary: "Compact merged summary" }],
      tier: 2,
    });
    expect(resDistill.ok).toBe(true);

    // Distillation block b3 should have inherited anchor from b1/b2, NOT jumped to newest bound ref!
    const b3 = engine.state.tree.get("b3");
    expect(b3).toBeDefined();
    expect(b3?.tier).toBe(2);

    // Critical assertion: growthSinceFold must NOT be wiped to 0!
    const growthAfter = engine.status().growthSinceFold;
    expect(growthAfter).toBeGreaterThan(0);
    expect(growthAfter).toBe(growthBefore);
  });

  it("mixed-tier batch: executes tier 1 message compression and tier 2 distillation in a single call", () => {
    const { engine } = harness(12);

    // First create two lower-tier blocks to merge with enough tokens for distillation
    engine.executeFold({ folds: [{ range: "m00003..m00004", topic: "T1", summary: "Summary 1 with substantial token mass for testing" }] });
    engine.executeFold({ folds: [{ range: "m00005..m00006", topic: "T2", summary: "Summary 2 with substantial token mass for testing" }] });

    // Now execute a mixed batch:
    // Fold 0: Tier 1 compressing raw messages m00007..m00008
    // Fold 1: Tier 2 distilling blocks b1 and b2
    const resMixed = engine.executeFold({
      folds: [
        { range: "m00007..m00008", topic: "T3 raw fold", summary: "Summary of 7 and 8", tier: 1 },
        { range: "b1,b2", topic: "Merged", summary: "Compact merge", tier: 2 },
      ],
    });

    expect(resMixed.ok).toBe(true);
    if (resMixed.ok) {
      expect(resMixed.outcome.foldCount).toBe(2);
      expect(resMixed.outcome.blocks[0]?.tier).toBe(1);
      expect(resMixed.outcome.blocks[1]?.tier).toBe(2);
    }

    const b3 = engine.state.tree.get("b3");
    const b4 = engine.state.tree.get("b4");
    expect(b3?.tier).toBe(1);
    expect(b4?.tier).toBe(2);
    expect(engine.state.tree.get("b1")?.status).toBe("consumed");
    expect(engine.state.tree.get("b2")?.status).toBe("consumed");
  });

  it("salvageFoldParams auto-infers per-spec tiers in mixed batches", () => {
    const raw = {
      folds: [
        { range: "m00005..m00010", topic: "Raw messages", summary: "Summary of messages" },
        { range: "b1..b3", topic: "Distill blocks", summary: "Summary of blocks" },
      ],
    };

    const salvaged = salvageFoldParams(raw);
    expect(salvaged.ok).toBe(true);
    if (salvaged.ok) {
      expect(salvaged.params.folds[0]?.tier).toBe(1);
      expect(salvaged.params.folds[1]?.tier).toBe(2);
    }
  });
});

describe("Compound & Backlog-Aware Nudges", () => {
  const cfg: NudgeConfig = {
    growthStep: 10_000,
    compressibleFloor: 5_000,
    emergencyFillPct: 0.9,
    tier2MassTokens: 20_000,
    tier3MassTokens: 40_000,
    minFoldBenefit: 1_000,
    cooldownTurns: 2,
  };

  const ranges: NudgeRange[] = [
    { start: "m00010", end: "m00030", tokens: 15_000, messages: 20, toolTokens: 7_000 },
  ];

  it("emits compound nudge when both efficiency candidate ranges and tier promotions are eligible", () => {
    const state: NudgeState = {
      growthSinceFoldTokens: 12_000, // exceeds growthStep (10K)
      compressibleTokens: 15_000,
      windowFillPct: 0.4,
      nudgedThisTurn: false,
      activeTurn: 10,
      lastFoldTurn: null,
      lastEfficiencyAtGrowth: null,
      lastPromotionAtMass: { 1: null, 2: null },
      advisoryAllowed: true,
      promotionAllowed: true,
    };

    const promo: PromotionCandidate[] = [
      { fromTier: 1, blockIds: ["b1", "b2", "b3"], tokens: 25_000 },
    ];

    const decision = decideNudge(state, ranges, promo, cfg);
    expect(decision.kind).toBe("efficiency");
    expect(decision.text).toContain("Candidate ranges");
    expect(decision.text).toContain("Additionally, 3 tier-1 blocks hold 25.0K tokens of summaries");
    expect(decision.text).toContain("Wrap up candidate tier-1 ranges first to reclaim prompt space");
  });

  it("includes pending raw candidate notice when promotion is eligible but growth floor not yet reached", () => {
    const state: NudgeState = {
      growthSinceFoldTokens: 4_000, // below growthStep (10K)
      compressibleTokens: 15_000,
      windowFillPct: 0.4,
      nudgedThisTurn: false,
      activeTurn: 10,
      lastFoldTurn: null,
      lastEfficiencyAtGrowth: null,
      lastPromotionAtMass: { 1: null, 2: null },
      advisoryAllowed: true,
      promotionAllowed: true,
    };

    const promo: PromotionCandidate[] = [
      { fromTier: 1, blockIds: ["b1", "b2", "b3"], tokens: 25_000 },
    ];

    const decision = decideNudge(state, ranges, promo, cfg);
    expect(decision.kind).toBe("promotion");
    expect(decision.text).toContain("Notice: ~15.0K tokens of raw history are also foldable in candidate ranges");
    expect(decision.text).toContain("Tier-1 folds reclaim prompt space, whereas tier-2 distillation only consolidates summaries");
  });
});
