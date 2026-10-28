import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset, type OrigamiConfig } from "../src/config.ts";
import { JOURNAL_ENTRY_TYPE, type JournalOp } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { openDb, type OrigamiDb } from "../src/persist/db.ts";
import { decideNudge, type NudgeState } from "../src/kernel/nudge.ts";

// Turn k (1-based) is refs m(2k-1) user, m(2k) assistant. Turn 1 is the pinned head.
function conversation(turns: number) {
  const entries: { type: string; id: string; message: { role: string; content: string } }[] = [];
  for (let k = 1; k <= turns; k++) {
    entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user turn ${k}: ${"please investigate the parser edge case ".repeat(6)}` } });
    entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant turn ${k}: ${"found the off-by-one in the tokenizer loop ".repeat(6)}` } });
  }
  return entries;
}

function harness(opts: { turns?: number; config?: Partial<OrigamiConfig>; db?: OrigamiDb; sessionId?: string; entries?: ReturnType<typeof conversation> } = {}) {
  const journal: JournalOp[] = [];
  const entries = opts.entries ?? conversation(opts.turns ?? 6);
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => opts.sessionId ?? "lifecycle",
      appendEvent: (op) => journal.push(op),
      saveArtifact: async () => "/tmp/unused.md",
      windowTokens: () => 100_000,
      projectedTokens: () => 10_000,
    },
    entries,
    modelId: "test",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0, ...opts.config },
    countFn: (t) => t.length,
  });
  if (opts.db) engine.attachDb(opts.db);
  engine.refresh(entries);
  engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
  const render = () =>
    engine.render(
      entries.map((e) => e.message),
      (text, blockId) => ({ role: "custom", blockId, content: text }),
    ) as { role: string; blockId?: string }[];
  return { engine, journal, render };
}

const fold = (range: string, topic = "t") => ({ range, topic, summary: `summary of ${range}` });

describe("fold batch validation", () => {
  it("rejects a batch whose folds overlap, writing nothing", () => {
    const { engine, journal } = harness();
    const res = engine.executeFold({ folds: [fold("m00003..m00006"), fold("m00005..m00008")] });
    expect(res).toMatchObject({ ok: false, foldIndex: 1 });
    expect(journal).toHaveLength(0);
    expect(engine.state.tree.all()).toHaveLength(0);
  });

  it("assigns a turn shared by two disjoint ranges to the earlier fold", () => {
    // m00005/m00006 form one turn; both ranges widen to cover it.
    const { engine } = harness();
    const res = engine.executeFold({ folds: [fold("m00003..m00005"), fold("m00006..m00008")] });
    expect(res.ok).toBe(true);
    expect(engine.state.tree.all().map((b) => [b.id, b.ranges])).toEqual([
      ["b1", [{ start: "m00003", end: "m00006" }]],
      ["b2", [{ start: "m00007", end: "m00008" }]],
    ]);
    expect(engine.invariants()).toEqual([]);
  });

  it("rejects a later range lying entirely inside a turn claimed earlier", () => {
    const { engine } = harness();
    const res = engine.executeFold({ folds: [fold("m00003..m00005"), fold("m00006")] });
    expect(res).toMatchObject({ ok: false, foldIndex: 1 });
    if (!res.ok) expect(res.error).toContain("claimed by an earlier fold");
  });

  it("rejects empty and non-shrinking summaries", () => {
    const { engine } = harness();
    expect(engine.executeFold({ folds: [{ range: "m00003..m00004", topic: "t", summary: "   " }] })).toMatchObject({ ok: false, error: "summary must not be empty" });
    const res = engine.executeFold({ folds: [{ range: "m00003..m00004", topic: "t", summary: "x".repeat(2000) }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("is not smaller than what it replaces");
  });

  it("a fold over an active block covers only the unfolded refs", () => {
    const { engine, render } = harness();
    expect(engine.executeFold({ folds: [fold("m00005..m00006")] }).ok).toBe(true);
    const res = engine.executeFold({ folds: [fold("m00003..m00008")] });
    expect(res.ok).toBe(true);
    expect(engine.state.tree.get("b2")!.ranges).toEqual([
      { start: "m00003", end: "m00004" },
      { start: "m00007", end: "m00008" },
    ]);
    expect(engine.invariants()).toEqual([]);
    expect(render().filter((m) => m.blockId).map((m) => m.blockId)).toEqual(["b2", "b1"]);
  });
});

describe("tiered block lifecycle", () => {
  function merged() {
    const h = harness();
    expect(h.engine.executeFold({ folds: [fold("m00003..m00004"), fold("m00005..m00006")] }).ok).toBe(true);
    expect(h.engine.executeFold({ folds: [fold("b1,b2", "merged")], tier: 2 }).ok).toBe(true);
    return h;
  }

  it("a tier-2 merge consumes its children so each source renders once", () => {
    const { engine, render } = merged();
    expect(engine.state.tree.live().map((b) => b.id)).toEqual(["b3"]);
    expect(engine.state.tree.get("b1")).toMatchObject({ status: "consumed", consumedBy: "b3" });
    const out = render();
    expect(out.filter((m) => m.blockId).map((m) => m.blockId)).toEqual(["b3"]);
    expect(out).toHaveLength(12 - 4 + 1);
    expect(engine.invariants()).toEqual([]);
  });

  it("refuses to merge a block twice or merge a consumed block", () => {
    const h = harness();
    h.engine.executeFold({ folds: [fold("m00003..m00004"), fold("m00005..m00006"), fold("m00007..m00008")] });
    expect(h.engine.executeFold({ folds: [fold("b1,b2"), fold("b2,b3")], tier: 2 })).toMatchObject({ ok: false, foldIndex: 1 });
    h.engine.executeFold({ folds: [fold("b1,b2")], tier: 2 });
    const res = h.engine.executeFold({ folds: [fold("b1,b3")], tier: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("b1 is consumed by b4");
  });

  it("unfolds through the parent: one level by default, raw messages with deep", () => {
    const { engine, render } = merged();
    expect(engine.executeUnfold("b1")).toEqual({ ok: false, error: "block b1 is consumed by b3; unfold b3 first" });

    const shallow = engine.executeUnfold("b3");
    expect(shallow.ok && shallow.unfolded).toEqual(["b3"]);
    expect(engine.state.tree.live().map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(render().filter((m) => m.blockId).map((m) => m.blockId)).toEqual(["b1", "b2"]);

    const again = merged();
    const deep = again.engine.executeUnfold("b3", { deep: true });
    expect(deep.ok && deep.unfolded).toEqual(["b3", "b1", "b2"]);
    expect(again.engine.state.tree.live()).toHaveLength(0);
    expect(again.render()).toHaveLength(12);
  });

  it("journal replay reproduces the lifecycle", () => {
    const { engine, journal } = merged();
    engine.executeUnfold("b3");
    const replay = harness();
    replay.engine.state.tree.rebuild(JSON.parse(JSON.stringify(journal)));
    expect(replay.engine.state.tree.all().map((b) => [b.id, b.status])).toEqual([
      ["b1", "active"],
      ["b2", "active"],
      ["b3", "unfolded"],
    ]);
  });
});

describe("protected recent tail", () => {
  it("rejects folds that reach into the tail and keeps it out of recommendations", () => {
    const { engine } = harness({ config: { protectedTailMessages: 4, protectedTailTokens: 0 } });
    // Last 4 messages are turns 5-6 (m00009..m00012).
    const res = engine.executeFold({ folds: [fold("m00007..m00010")] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("protected recent tail (turn 5 onward)");
    expect(engine.recommendedRanges().map((r) => `${r.start}..${r.end}`)).toEqual(["m00003..m00008"]);
    expect(engine.status().protectedFromTurn).toBe(5);
  });
});

describe("durable recall", () => {
  it("serves folded originals from the archive once they leave the branch", () => {
    const db = openDb(":memory:");
    const full = harness({ db, sessionId: "s-recall" });
    expect(full.engine.executeFold({ folds: [fold("m00003..m00004")] }).ok).toBe(true);

    const branch = harness({ db, sessionId: "s-recall", entries: conversation(6).slice(0, 2) });
    const hits = branch.engine.recall(["m00001", "m00003", "m00099"]);
    expect(hits.map((h) => h.source)).toEqual(["context", "archive", "missing"]);
    expect(hits[1]!.text).toStartWith("user turn 2:");
    db.close();
  });
});

describe("persistence degradation", () => {
  it("keeps journal-backed folding successful and disables persistence after an atomic write failure", () => {
    const db = openDb(":memory:");
    let failures = 0;
    const faulty = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "persistFoldBatch") return () => { throw new Error("disk full"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const h = harness();
    h.engine.attachDb(faulty, () => failures++);
    const result = h.engine.executeFold({ folds: [fold("m00003..m00004")] });
    expect(result.ok).toBe(true);
    expect(h.journal).toHaveLength(1);
    expect(h.engine.state.tree.get("b1")?.status).toBe("active");
    expect(failures).toBe(1);
    expect(h.engine.search("anything")).toEqual([]);
    h.engine.recordRound({ ts: 1, totalIn: 1, cacheRead: 0, cacheWrite: 0, foldEventId: null });
    expect(failures).toBe(1);
    db.close();
  });
});

describe("nudge policy", () => {
  const cfg = { growthStep: 1000, compressibleFloor: 500, emergencyFillPct: 0.9, tier2MassTokens: 300, tier3MassTokens: 600, minFoldBenefit: 0 };
  const ranges = [{ start: "m00003", end: "m00008", tokens: 2000, messages: 6, toolTokens: 1000 }];
  const base: NudgeState = {
    growthSinceFoldTokens: 1200,
    compressibleTokens: 2000,
    windowFillPct: 0.4,
    nudgedThisTurn: false,
    lastEfficiencyAtGrowth: null,
    lastPromotionAtMass: { 1: null, 2: null },
  };

  it("efficiency nudges are advisory, show composition, and back off after a deferral", () => {
    const first = decideNudge(base, ranges, [], cfg);
    expect(first.kind).toBe("efficiency");
    expect(first.text).toContain("m00003..m00008 (2.0Kt · 6 msgs · 50% tool)");
    expect(first.text).not.toContain("full");
    expect(first.text).toContain("defer");
    // Declined at 1200: silent until another half step (1700).
    expect(decideNudge({ ...base, growthSinceFoldTokens: 1600, lastEfficiencyAtGrowth: 1200 }, ranges, [], cfg).kind).toBeNull();
    expect(decideNudge({ ...base, growthSinceFoldTokens: 1700, lastEfficiencyAtGrowth: 1200 }, ranges, [], cfg).kind).toBe("efficiency");
  });

  it("emergency overrides backoff and is mandatory", () => {
    const d = decideNudge({ ...base, windowFillPct: 0.95, lastEfficiencyAtGrowth: 1200 }, ranges, [], cfg);
    expect(d.kind).toBe("emergency");
    expect(d.text).toContain("95% full");
    expect(d.text).toContain("not optional");
  });

  it("promotes tier-1 blocks once their mass crosses the tier-2 threshold", () => {
    const quiet = { ...base, growthSinceFoldTokens: 0 };
    const promo = [{ fromTier: 1 as const, blockIds: ["b1", "b2", "b4"], tokens: 320 }];
    const d = decideNudge(quiet, [], promo, cfg);
    expect(d.kind).toBe("promotion");
    expect(d.text).toContain('"b1,b2,b4"');
    expect(decideNudge(quiet, [], [{ ...promo[0]!, tokens: 299 }], cfg).kind).toBeNull();
    expect(decideNudge({ ...quiet, lastPromotionAtMass: { 1: 320, 2: null } }, [], [{ ...promo[0]!, tokens: 400 }], cfg).kind).toBeNull();
    expect(decideNudge(quiet, [], [{ fromTier: 1, blockIds: ["b1"], tokens: 900 }], cfg).kind).toBeNull();
  });
});

describe("fold benefit floor", () => {
  it("rejects a tier-1 batch that reclaims less than the floor, accepts a larger one", () => {
    const { engine, journal } = harness({ config: { minFoldBenefitTokens: 2000 } });
    const small = engine.executeFold({ folds: [fold("m00003..m00004")] });
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.error).toContain("below the minimum fold benefit of 2.0Kt");
    expect(journal).toHaveLength(0);
    expect(engine.executeFold({ folds: [fold("m00003..m00010")] }).ok).toBe(true);
  });

  it("the window share raises the floor above the absolute minimum", () => {
    // 5% of the 100K window = 5K, more than the whole foldable middle.
    const { engine } = harness({ config: { minFoldBenefitTokens: 100, minFoldBenefitWindowPct: 0.05 } });
    const res = engine.executeFold({ folds: [fold("m00003..m00010")] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("5.0Kt");
  });
});

describe("recent-zone protection", () => {
  it("protects the turn of the last user message even when later turns exist", () => {
    const entries = conversation(6);
    entries.push({ type: "custom_message", id: "c1", message: { role: "custom", content: "background job finished" } });
    entries.push({ type: "message", id: "a7", message: { role: "assistant", content: "noted the background job" } });
    const { engine } = harness({ entries });
    const res = engine.executeFold({ folds: [fold("m00011..m00012")] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("protected recent tail");
    expect(engine.executeFold({ folds: [fold("m00003..m00010")] }).ok).toBe(true);
  });

  it("keeps historical fold call/result pairs in outbound context", () => {
    const foldCall = (id: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "fold", arguments: { folds: [] } }],
    });
    const foldResult = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "1 block(s) folded" }] });
    const entries = conversation(4) as { type: string; id: string; message: Record<string, unknown> }[];
    entries.push({ type: "message", id: "fc1", message: foldCall("call-old") });
    entries.push({ type: "message", id: "fr1", message: foldResult("call-old") });
    entries.push({ type: "message", id: "u5", message: { role: "user", content: "next question" } });
    entries.push({ type: "message", id: "fc2", message: foldCall("call-new") });
    entries.push({ type: "message", id: "fr2", message: foldResult("call-new") });
    const { engine, render } = harness({ entries: entries as ReturnType<typeof conversation> });
    const out = render() as unknown as { role: string; toolCallId?: string; content?: unknown }[];
    const results = out.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
    expect(results).toEqual(["call-old", "call-new"]);
    const calls = out.filter((m) => m.role === "assistant" && Array.isArray(m.content));
    expect(calls).toHaveLength(2);
    expect(engine.invariants()).toEqual([]);
  });
});

describe("block age", () => {
  it("counts later fold calls and matures blocks into the old generation", () => {
    const entries = conversation(10);
    const { engine, journal } = harness({ entries: entries.slice(0, 12), config: { blockMatureFolds: 2 } });
    // Refresh rebuilds the tree from the session's journal entries, as the host persists them.
    const grow = (n: number) => {
      const view = entries.slice(0, n);
      engine.refresh([...view, ...journal.map((data) => ({ type: "custom", id: "j", customType: JOURNAL_ENTRY_TYPE, data }))]);
      engine.ingest(view.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    };
    expect(engine.executeFold({ folds: [fold("m00003..m00004")] }).ok).toBe(true);
    grow(14);
    expect(engine.executeFold({ folds: [fold("m00005..m00006")] }).ok).toBe(true);
    grow(16);
    // Two blocks in one call share an age.
    expect(engine.executeFold({ folds: [fold("m00007..m00008"), fold("m00009..m00010")] }).ok).toBe(true);
    const rows = new Map(engine.status().blocks.map((b) => [b.id, b]));
    expect([1, 2, 3, 4].map((i) => rows.get(`b${i}`)!.survivedFolds)).toEqual([2, 1, 0, 0]);
    expect(rows.get("b1")!.generation).toBe("old");
    expect(rows.get("b2")!.generation).toBe("young");
  });
});
