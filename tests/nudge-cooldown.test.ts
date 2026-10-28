import { describe, expect, test } from "bun:test";
import { decideNudge, type NudgeConfig, type NudgeRange, type NudgeState, type PromotionCandidate } from "../src/kernel/nudge.ts";
import { historicalFoldCallRefs, FOLD_TOOL_NAMES } from "../src/kernel/fold-calls.ts";
import type { BoundMessage } from "../src/kernel/types.ts";

describe("Nudge Self-Amplification Prevention (#5058)", () => {
  const baseConfig: NudgeConfig = {
    growthStep: 10_000,
    compressibleFloor: 5_000,
    emergencyFillPct: 0.9,
    tier2MassTokens: 20_000,
    tier3MassTokens: 40_000,
    minFoldBenefit: 1_000,
    cooldownTurns: 2,
  };

  const sampleRanges: NudgeRange[] = [
    { start: "m00001", end: "m00020", tokens: 12_000, messages: 20, toolTokens: 6_000 },
  ];

  test("historicalFoldCallRefs identifies all origami bookkeeping tools across turns", () => {
    expect(FOLD_TOOL_NAMES.fold).toBe(true);
    expect(FOLD_TOOL_NAMES.unfold).toBe(true);
    expect(FOLD_TOOL_NAMES.fold_recall).toBe(true);
    expect(FOLD_TOOL_NAMES.fold_search).toBe(true);
    expect(FOLD_TOOL_NAMES.fold_status).toBe(true);
    expect(FOLD_TOOL_NAMES.fold_cache).toBe(true);

    const bound: BoundMessage[] = [
      {
        index: 0,
        ref: "m00001",
        role: "user",
        text: "Please search old notes",
        bytes: 20,
        turn: 1,
        ephemeral: false,
        contentHash: "h1",
        signedThinking: false,
      },
      // Assistant calls fold_search on turn 2
      {
        index: 1,
        ref: "m00002",
        role: "assistant",
        text: "",
        bytes: 0,
        turn: 2,
        ephemeral: false,
        contentHash: "h2",
        signedThinking: false,
        toolCalls: [{ id: "call_search_1", name: "fold_search" }],
      },
      {
        index: 2,
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_search_1",
        text: "Found 2 blocks",
        bytes: 50,
        turn: 2,
        ephemeral: false,
        contentHash: "h3",
        signedThinking: false,
      },
      // Assistant calls fold (which failed or succeeded) on turn 3
      {
        index: 3,
        ref: "m00004",
        role: "assistant",
        text: "",
        bytes: 0,
        turn: 3,
        ephemeral: false,
        contentHash: "h4",
        signedThinking: false,
        toolCalls: [{ id: "call_fold_1", name: "fold" }],
      },
      {
        index: 4,
        ref: "m00005",
        role: "toolResult",
        toolCallId: "call_fold_1",
        text: "error: overlapping range",
        bytes: 30,
        turn: 3,
        ephemeral: false,
        contentHash: "h5",
        signedThinking: false,
      },
      // Regular user/assistant tool call
      {
        index: 5,
        ref: "m00006",
        role: "assistant",
        text: "",
        bytes: 0,
        turn: 4,
        ephemeral: false,
        contentHash: "h6",
        signedThinking: false,
        toolCalls: [{ id: "call_bash_1", name: "bash" }],
      },
      {
        index: 6,
        ref: "m00007",
        role: "toolResult",
        toolCallId: "call_bash_1",
        text: "ok",
        bytes: 10,
        turn: 4,
        ephemeral: false,
        contentHash: "h7",
        signedThinking: false,
      },
    ];

    const refs = historicalFoldCallRefs(bound);
    // fold_search and fold calls are marked bookkeeping refs across turns
    expect(refs.has("m00002")).toBe(true);
    expect(refs.has("m00003")).toBe(true);
    expect(refs.has("m00004")).toBe(true);
    expect(refs.has("m00005")).toBe(true);

    // Regular tools are NOT marked
    expect(refs.has("m00006")).toBe(false);
    expect(refs.has("m00007")).toBe(false);
  });

  test("decideNudge suppresses advisory efficiency and promotion nudges during turn cooldown", () => {
    // Fold happened on turn 5, current turn is turn 6 (inside 2-turn cooldown)
    const stateInCooldown: NudgeState = {
      growthSinceFoldTokens: 15_000, // exceeds growthStep (10K)
      compressibleTokens: 12_000,
      windowFillPct: 0.35,
      nudgedThisTurn: false,
      activeTurn: 6,
      lastFoldTurn: 5,
      lastEfficiencyAtGrowth: null,
      lastPromotionAtMass: { 1: null, 2: null },
    };

    const promo: PromotionCandidate[] = [
      { fromTier: 1, blockIds: ["b1", "b2"], tokens: 25_000 },
    ];

    const decision = decideNudge(stateInCooldown, sampleRanges, promo, baseConfig);
    expect(decision.kind).toBeNull();
    expect(decision.text).toBeNull();
  });

  test("decideNudge fires advisory efficiency nudge once turn cooldown has elapsed", () => {
    // Fold happened on turn 5, current turn is turn 7 (5 + 2 = 7, cooldown elapsed)
    const stateCooldownElapsed: NudgeState = {
      growthSinceFoldTokens: 15_000, // exceeds growthStep (10K)
      compressibleTokens: 12_000,
      windowFillPct: 0.35,
      nudgedThisTurn: false,
      activeTurn: 7,
      lastFoldTurn: 5,
      lastEfficiencyAtGrowth: null,
      lastPromotionAtMass: { 1: null, 2: null },
    };

    const decision = decideNudge(stateCooldownElapsed, sampleRanges, [], baseConfig);
    expect(decision.kind).toBe("efficiency");
    expect(decision.text).toContain("[origami] 15.0K tokens have accumulated since the last fold");
  });

  test("decideNudge always fires emergency nudge regardless of cooldown", () => {
    // Context is near limit (92% full) right after a fold on turn 5
    const stateEmergencyInCooldown: NudgeState = {
      growthSinceFoldTokens: 2_000,
      compressibleTokens: 10_000,
      windowFillPct: 0.92, // Exceeds emergency threshold (0.90)
      nudgedThisTurn: false,
      activeTurn: 6,
      lastFoldTurn: 5,
      lastEfficiencyAtGrowth: null,
      lastPromotionAtMass: { 1: null, 2: null },
    };

    const decision = decideNudge(stateEmergencyInCooldown, sampleRanges, [], baseConfig);
    expect(decision.kind).toBe("emergency");
    expect(decision.text).toContain("Context is 92% full. Fold NOW before continuing; this is not optional.");
  });
});
