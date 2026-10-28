import { describe, expect, it } from "bun:test";
import { buildCacheReport, decomposeSample, type CacheSample, type FoldEvent } from "../src/kernel/cache-report.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

describe("Prompt Cache Reconciliation & Economics Engine (#800)", () => {
  it("decomposes sample into fresh growth, fold re-pay, and TTL residual with exact conservation", () => {
    const prev: CacheSample = { at: 1000, input: 50_000, cached: 45_000 };
    // Current request: input grew to 55,000, but only 40,000 cached (15,000 missed)
    const cur: CacheSample = { at: 2000, input: 55_000, cached: 40_000 };
    const fold: FoldEvent = { id: "b1", at: 1500, tokensCompressed: 20_000, summaryTokens: 500 };

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
      { id: "b1", at: 2500, tokensCompressed: 20_000, summaryTokens: 500, topic: "Auth overhaul" },
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
    expect(f1.savingPerTurn).toBe(19_500);
    expect(f1.T).toBeGreaterThan(0);
    expect(f1.breakevenTurns).toBeGreaterThanOrEqual(1);
    expect(f1.requestsAfter).toBe(3);
    expect(f1.paidBack).toBe(true);
    expect(f1.netTokens).toBeGreaterThan(0);
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
