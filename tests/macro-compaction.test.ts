import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset, type OrigamiConfig } from "../src/config.ts";
import {
  CandidateStore,
  candidateConsolidation,
  candidateWork,
  consolidationPrompt,
  generateCandidate,
  candidateStale,
} from "../src/candidates.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

beforeAll(async () => {
  await Settings.init({ inMemory: true });
});

function turn(k: number) {
  return [
    {
      type: "message",
      id: `u${k}`,
      message: { role: "user", content: `user turn ${k}: ${"please investigate the parser edge case ".repeat(10)}` },
    },
    {
      type: "message",
      id: `a${k}`,
      message: { role: "assistant", content: `assistant turn ${k}: ${"found the off-by-one in the tokenizer loop ".repeat(10)}` },
    },
  ];
}

function makeEngine(customCfg: Partial<OrigamiConfig> = {}) {
  const entries: { type: string; id: string; message: { role: string; content: string } }[] = [];
  for (let i = 1; i <= 24; i++) entries.push(...turn(i));

  const cfg = {
    ...configFromPreset("balanced"),
    protectedTailMessages: 0,
    protectedTailTokens: 0,
    minFoldBenefitTokens: 0,
    minFoldBenefitWindowPct: 0,
    macroCompaction: "auto" as const,
    macroCompactionMinBlocks: 3,
    blockMatureFolds: 1,
    ...customCfg,
  };
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "test-macro-compaction",
      appendEvent: () => {},
      saveArtifact: async () => "/tmp/unused.md",
      windowTokens: () => 200_000,
      projectedTokens: () => 10_000,
    },
    entries,
    modelId: "test-model",
    config: cfg,
    countFn: (t) => t.length,
  });
  engine.refresh(entries);
  return { engine, entries };
}

describe("autonomous macro-compaction", () => {
  it("detects when mature tier-1 blocks are eligible for consolidation", () => {
    const { engine, entries } = makeEngine({ blockMatureFolds: 2, macroCompactionMinBlocks: 3 });
    const store = new CandidateStore();

    // Wave 1: Turns 1..4 (m00001..m00008). Turn 4 in-flight, fold Turns 2..3
    engine.ingest(entries.slice(0, 8).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const r1 = engine.executeFold({ folds: [{ range: "m00003..m00006", topic: "Block 1", summary: "Summary 1" }], tier: 1 });
    expect(r1.ok).toBe(true);

    // Wave 2: Turns 1..6 (m00001..m00012). Fold Turns 4..5
    engine.ingest(entries.slice(0, 12).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const r2 = engine.executeFold({ folds: [{ range: "m00007..m00010", topic: "Block 2", summary: "Summary 2" }], tier: 1 });
    expect(r2.ok).toBe(true);

    // Wave 3: Turns 1..8 (m00001..m00016). Fold Turns 6..7
    engine.ingest(entries.slice(0, 16).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const r3 = engine.executeFold({ folds: [{ range: "m00011..m00014", topic: "Block 3", summary: "Summary 3" }], tier: 1 });
    expect(r3.ok).toBe(true);

    // Blocks have fold ages: b1 (age 2), b2 (age 1), b3 (age 0).
    // With blockMatureFolds = 2, only b1 is mature (age >= 2).
    expect(candidateConsolidation(engine, store)).toBeNull();

    // Wave 4: Turns 1..10 (m00001..m00020). Fold Turns 8..9
    engine.ingest(entries.slice(0, 20).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const r4 = engine.executeFold({ folds: [{ range: "m00015..m00018", topic: "Block 4", summary: "Summary 4" }], tier: 1 });
    expect(r4.ok).toBe(true);

    // Wave 5: Turns 1..12 (m00001..m00024). Fold Turns 10..11
    engine.ingest(entries.slice(0, 24).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const r5 = engine.executeFold({ folds: [{ range: "m00019..m00022", topic: "Block 5", summary: "Summary 5" }], tier: 1 });
    expect(r5.ok).toBe(true);

    // Now b1 (age 4), b2 (age 3), and b3 (age 2) all have age >= 2!
    const cand = candidateConsolidation(engine, store);
    expect(cand).not.toBeNull();
    expect(cand!.fromTier).toBe(1);
    expect(cand!.toTier).toBe(2);
    expect(cand!.blocks.length).toBeGreaterThanOrEqual(3);
    expect(cand!.blocks.map((b) => b.id).slice(0, 3)).toEqual(["b1", "b2", "b3"]);

    // Consolidation prompt contains summaries and doctrine instructions
    const prompt = consolidationPrompt(cand!);
    expect(prompt).toContain("Consolidate these");
    expect(prompt).toContain("tier-2 distillation");
    expect(prompt).toContain("b1");
    expect(prompt).toContain("Summary 1");
  });

  it("respects macroCompaction: 'off'", () => {
    const { engine, entries } = makeEngine({ macroCompaction: "off", blockMatureFolds: 1 });
    const store = new CandidateStore();

    engine.ingest(entries.slice(0, 8).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00003..m00006", topic: "B1", summary: "S1" }], tier: 1 });

    engine.ingest(entries.slice(0, 12).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00007..m00010", topic: "B2", summary: "S2" }], tier: 1 });

    engine.ingest(entries.slice(0, 16).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00011..m00014", topic: "B3", summary: "S3" }], tier: 1 });

    engine.ingest(entries.slice(0, 20).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00015..m00018", topic: "B4", summary: "S4" }], tier: 1 });

    expect(candidateConsolidation(engine, store)).toBeNull();
  });

  it("automatically applies consolidation in 'auto' mode without queuing pending candidate", async () => {
    const { engine, entries } = makeEngine({
      macroCompaction: "auto",
      macroCompactionMinBlocks: 3,
      blockMatureFolds: 1,
    });
    const store = new CandidateStore();

    engine.ingest(entries.slice(0, 8).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "Milestone 1", summary: "Detailed summary of milestone 1", keep: [{ kind: "decision", text: "Decision 1" }] }],
      tier: 1,
    });

    engine.ingest(entries.slice(0, 12).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({
      folds: [{ range: "m00007..m00010", topic: "Milestone 2", summary: "Detailed summary of milestone 2", keep: [{ kind: "decision", text: "Decision 2" }] }],
      tier: 1,
    });

    engine.ingest(entries.slice(0, 16).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({
      folds: [{ range: "m00011..m00014", topic: "Milestone 3", summary: "Detailed summary of milestone 3", keep: [{ kind: "decision", text: "Decision 3" }] }],
      tier: 1,
    });

    engine.ingest(entries.slice(0, 20).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({
      folds: [{ range: "m00015..m00018", topic: "Milestone 4", summary: "Detailed summary of milestone 4" }],
      tier: 1,
    });

    const work = candidateWork(engine, store);
    expect(work).not.toBeNull();
    expect(work!.kind).toBe("consolidation");

    let autoAppliedOutcome: unknown = null;
    let autoAppliedCandidate: unknown = null;

    // Simulate ephemeral side turn consolidating b1..b3
    const fakeRun = async () => ({
      replyText: JSON.stringify({
        range: "b1..b3",
        topic: "Consolidated Architectural Milestones 1-3",
        summary: "Dense synthesized summary of milestones 1, 2, and 3",
        keep: [
          { kind: "decision", text: "Decision 1" },
          { kind: "decision", text: "Decision 2" },
        ],
        tier: 2,
      }),
    });

    await generateCandidate(engine, store, fakeRun, work!, {
      onAutoApplied: (outcome, candidate) => {
        autoAppliedOutcome = outcome;
        autoAppliedCandidate = candidate;
      },
    });

    // In 'auto' mode, store.pending remains null (no UI interruption needed)
    expect(store.pending).toBeNull();
    expect(autoAppliedOutcome).not.toBeNull();
    expect(autoAppliedCandidate).not.toBeNull();

    // The newly created block should be Tier 2
    const live = engine.state.tree.live();
    const tier2 = live.find((b) => b.tier === 2);
    expect(tier2).toBeDefined();
    expect(tier2!.topic).toBe("Consolidated Architectural Milestones 1-3");
    expect(tier2!.children).toEqual(["b1", "b2", "b3"]);

    // Old child blocks are consumed
    expect(engine.state.tree.get("b1")!.consumedBy).toBe(tier2!.id);
    expect(engine.state.tree.get("b2")!.consumedBy).toBe(tier2!.id);
    expect(engine.state.tree.get("b3")!.consumedBy).toBe(tier2!.id);
  });

  it("queues consolidation for review in 'review' mode and allows acceptance", async () => {
    const { engine, entries } = makeEngine({
      macroCompaction: "review",
      macroCompactionMinBlocks: 2,
      blockMatureFolds: 1,
    });
    const store = new CandidateStore();

    engine.ingest(entries.slice(0, 8).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00003..m00006", topic: "B1", summary: "Summary of b1" }], tier: 1 });

    engine.ingest(entries.slice(0, 12).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00007..m00010", topic: "B2", summary: "Summary of b2" }], tier: 1 });

    engine.ingest(entries.slice(0, 16).map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    engine.executeFold({ folds: [{ range: "m00011..m00014", topic: "B3", summary: "Summary of b3" }], tier: 1 });

    const work = candidateWork(engine, store);
    expect(work).not.toBeNull();
    expect(work!.kind).toBe("consolidation");

    const fakeRun = async () => ({
      replyText: JSON.stringify({
        range: "b1..b2",
        topic: "Milestones 1 & 2 Review",
        summary: "Merged summary of milestones 1 and 2",
        tier: 2,
      }),
    });

    await generateCandidate(engine, store, fakeRun, work!);

    // In 'review' mode, store.pending holds the candidate for user/agent review
    expect(store.pending).not.toBeNull();
    expect(store.pending!.spec.tier).toBe(2);
    expect(store.pending!.spec.range).toBe("b1..b2");

    // Staleness check: if b1 is unfolded, candidate becomes stale
    engine.executeUnfold("b1");
    expect(candidateStale(engine, store.pending!)).toBe(true);
  });
});
