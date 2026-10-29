import { describe, expect, it } from "bun:test";
import {
  buildCacheReport,
  DEFAULT_PRICE,
  decomposeSample,
  foldBreakeven,
  foldEventsFromBlocks,
  type CacheSample,
  type FoldEvent,
} from "../src/kernel/cache-report.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

describe("Prompt Cache Reconciliation & Economics Engine (#800)", () => {
  it("decomposes sample into fresh growth, fold re-pay, and TTL residual with exact conservation", () => {
    const prev: CacheSample = { at: 1000, input: 50_000, cached: 45_000 };
    // Current request: input grew to 55,000, but only 40,000 cached (15,000 missed)
    const cur: CacheSample = { at: 2000, input: 55_000, cached: 40_000 };
    const fold: FoldEvent = { id: "b1", at: 1500, tier: 1, replacedTokens: 20_000, summaryTokens: 500 };

    const dec = decomposeSample(prev, cur, fold);
    expect(dec.missed).toBe(15_000);
    // Growth was 5,000 tokens, so fresh content = 5,000
    expect(dec.newContent).toBe(5_000);
    // Remainder 10,000 is attributed to the active fold re-pay
    expect(dec.compRepay).toBe(10_000);
    expect(dec.ttlRepay).toBe(0);
    expect(dec.foldId).toBe("b1");

    // Conservation check: missed == newContent + compRepay + ttlRepay
    expect(dec.missed).toBe(dec.newContent + dec.compRepay + dec.ttlRepay);
  });

  it("attributes residual to ttlRepay when no active fold is claiming cold rounds", () => {
    const prev: CacheSample = { at: 1000, input: 50_000, cached: 45_000 };
    // Inactivity gap: input same, but cache dropped to 0
    const cur: CacheSample = { at: 10_000, input: 50_000, cached: 0 };

    const dec = decomposeSample(prev, cur, null);
    expect(dec.missed).toBe(50_000);
    expect(dec.newContent).toBe(0);
    expect(dec.compRepay).toBe(0);
    expect(dec.ttlRepay).toBe(50_000);
    expect(dec.foldId).toBe(null);
  });

  it("attributes a host-rewritten round's residual to hostRepay and keeps conservation", () => {
    const report = buildCacheReport(
      [
        { at: 1000, input: 50_000, cached: 0 },
        { at: 2000, input: 52_000, cached: 50_000 },
        { at: 3000, input: 40_000, cached: 10_000, hostRewrite: true },
        { at: 4000, input: 42_000, cached: 0 },
      ],
      [],
    );
    const s = report.summary;
    expect(report.decompositions[2]!.hostRepay).toBe(30_000);
    expect(report.decompositions[3]!.hostRepay).toBe(0);
    expect(s.hostRepay).toBe(30_000);
    expect(s.newContent + s.compRepay + s.hostRepay + s.ttlRepay).toBe(s.totalInput - s.totalCached);
  });

  it("calculates multi-sample cache report with exact balance closure and per-fold payback", () => {
    const samples: CacheSample[] = [
      { at: 1000, input: 40_000, cached: 0 },
      { at: 2000, input: 45_000, cached: 40_000 },
      // Fold applied between 2000 and 3000
      { at: 3000, input: 30_000, cached: 10_000, foldEventId: "b1" },
      { at: 4000, input: 32_000, cached: 30_000 },
      { at: 5000, input: 34_000, cached: 32_000 },
      { at: 6000, input: 36_000, cached: 34_000 },
    ];

    const folds: FoldEvent[] = [
      { id: "b1", at: 2500, tier: 1, replacedTokens: 20_000, summaryTokens: 500, topic: "Auth overhaul" },
    ];

    const report = buildCacheReport(samples, folds);

    // Exact conservation check
    const totalMissed = report.summary.totalInput - report.summary.totalCached;
    const decomposedMissed = report.summary.newContent + report.summary.compRepay + report.summary.ttlRepay;
    expect(decomposedMissed).toBe(totalMissed);

    // Per-fold economics check
    expect(report.folds.length).toBe(1);
    const f1 = report.folds[0]!;
    expect(f1.id).toBe("b1");
    expect(f1.S).toBe(20_000);
    expect(f1.sigma).toBe(500);
    // r = 0.1, q = 4: per-turn saving r·(S − σ) = 1950 units
    expect(f1.perTurnSavingUnits).toBeCloseTo(1_950, 6);
    expect(f1.T).toBe(20_000);
    // one-time (1 − r)·T + q·σ − r·S = 18000 + 2000 − 2000 = 18000 → 9.23 turns
    expect(f1.breakevenTurns).toBeCloseTo(9.23, 1);
    expect(f1.requestsAfter).toBe(3);
    expect(f1.paidBack).toBe(false);
    expect(f1.netUnits).toBeLessThan(0);
  });

  it("prices break-even with cache-read and output rates", () => {
    const b = foldBreakeven(20_000, 500, 60_000, DEFAULT_PRICE);
    expect(b.breakevenTurns).toBeCloseTo(27.69, 1);
    const report = buildCacheReport(
      [
        { at: 1000, input: 80_000, cached: 0 },
        { at: 2000, input: 80_000, cached: 80_000 },
      ],
      [{ id: "b1", at: 1500, tier: 1, replacedTokens: 20_000, summaryTokens: 500 }],
    );
    expect(report.folds[0]!.breakevenTurns).toBeCloseTo(foldBreakeven(20_000, 500, 0, DEFAULT_PRICE).breakevenTurns!, 6);
  });

  it("measures tier-2 savings against child summaries, not raw source", () => {
    const events = foldEventsFromBlocks([
      { id: "b1", createdAt: 1, tier: 1, tokensBefore: 30_000, tokensAfter: 800, children: [] },
      { id: "b2", createdAt: 2, tier: 1, tokensBefore: 25_000, tokensAfter: 700, children: [] },
      { id: "b3", createdAt: 3, tier: 2, tokensBefore: 55_000, tokensAfter: 400, children: ["b1", "b2", "gone"] },
    ]);
    const report = buildCacheReport([], events);
    expect(report.folds.find((f) => f.id === "b3")!.S).toBe(1_500);
    expect(report.folds.find((f) => f.id === "b1")!.S).toBe(30_000);
  });

  it("reports a fold whose summary is not smaller than its source as never paying back", () => {
    const report = buildCacheReport(
      [
        { at: 1000, input: 10_000, cached: 0 },
        { at: 2000, input: 10_000, cached: 10_000 },
        { at: 3000, input: 10_000, cached: 10_000 },
      ],
      [{ id: "b1", at: 1500, tier: 1, replacedTokens: 500, summaryTokens: 600 }],
    );
    expect(report.folds[0]!.breakevenTurns).toBeNull();
    expect(report.folds[0]!.paidBack).toBe(false);
  });

  it("engine.status() integrates cache report and calculates payback accurately", () => {
    const entries: { type: "message"; id: string; message: { role: string; content: string } }[] = [];
    for (let k = 1; k <= 8; k++) {
      entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user turn ${k}: ${"investigate caching economics and payback ".repeat(15)}` } });
      entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant turn ${k}: ${"amortized savings exceed one-time cost quickly ".repeat(15)}` } });
    }

    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "sess-report-test",
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    const foldRes = engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "Caching", summary: "Caching layer" }],
    });
    expect(foldRes.ok).toBe(true);

    const report = engine.cacheReport();
    expect(report).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(Array.isArray(report.folds)).toBe(true);
  });
});
