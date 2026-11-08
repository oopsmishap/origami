import { describe, expect, it } from "bun:test";
import { assessFoldTiming, type FoldTimingInput } from "../src/kernel/fold-timing.ts";
import { DEFAULT_PRICE } from "../src/kernel/cache-report.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { formatStatusReport } from "../src/tools/display.ts";

const base: FoldTimingInput = {
  projectedTokens: 95_000,
  windowTokens: 200_000,
  minFoldFillPct: 0.45,
  minFoldFillCapTokens: 160_000,
  boundary: "user" as const,
  cacheCold: false,
  growthSinceFoldTokens: 0,
  growthStep: 50_000,
  candidateTokens: 40_000,
  estimatedRewriteTokens: 5_000,
  summaryRatio: 0.05,
  telemetry: true,
  price: DEFAULT_PRICE,
  paybackHorizonTurns: 10,
};

describe("assessFoldTiming", () => {
  it("caps the fill floor and blocks below it", () => {
    const t = assessFoldTiming({ ...base, windowTokens: 1_000_000, projectedTokens: 50_000 });
    expect(t.fillFloorTokens).toBe(160_000);
    expect(t.allowed).toBe(false);
    expect(t.blockedBy).toBe("fill-floor");
  });

  it("allows a fold above the floor at a user boundary", () => {
    const t = assessFoldTiming(base);
    expect(t.fillFloorTokens).toBe(90_000);
    expect(t.allowed).toBe(true);
    expect(t.boundary).toBe("user");
  });

  it("blocks mid-task without a boundary, until growth reaches twice the step", () => {
    const mid = { ...base, boundary: null, growthSinceFoldTokens: 99_999 };
    expect(assessFoldTiming(mid).blockedBy).toBe("mid-task");
    const grown = assessFoldTiming({ ...mid, growthSinceFoldTokens: 100_000 });
    expect(grown.allowed).toBe(true);
    expect(grown.boundary).toBe("growth");
  });

  it("recognizes turn end before cold-cache and growth fallbacks", () => {
    const timing = assessFoldTiming({ ...base, boundary: "turn-end", cacheCold: true, growthSinceFoldTokens: 100_000 });
    expect(timing.allowed).toBe(true);
    expect(timing.boundary).toBe("turn-end");
  });

  it("a cold cache costs no rewrite, admitting a fold the warm path blocks by cost", () => {
    const warm = { ...base, candidateTokens: 6_000, estimatedRewriteTokens: 120_000 };
    const blocked = assessFoldTiming(warm);
    expect(blocked.blockedBy).toBe("cost");
    expect(blocked.breakevenTurns!).toBeGreaterThan(10);
    const cold = assessFoldTiming({ ...warm, boundary: null, cacheCold: true });
    expect(cold.allowed).toBe(true);
    expect(cold.boundary).toBe("cold-cache");
  });

  it("skips the cost gate without cache telemetry", () => {
    const t = assessFoldTiming({ ...base, candidateTokens: 6_000, estimatedRewriteTokens: 120_000, telemetry: false });
    expect(t.allowed).toBe(true);
    expect(t.breakevenTurns).toBeNull();
  });

  it("adapts payback horizon dynamically under high growth debt to prevent absorbing cost trap", () => {
    // candidate 20K, rewrite suffix 35K -> breakeven is ~18.6 turns (above normal paybackHorizonTurns 10)
    const normalGrowth = assessFoldTiming({
      ...base,
      candidateTokens: 20_000,
      estimatedRewriteTokens: 35_000,
      paybackHorizonTurns: 10,
      growthSinceFoldTokens: 25_000,
      growthStep: 25_000,
    });
    expect(normalGrowth.blockedBy).toBe("cost");

    // High growth debt (3x growthStep = 75K) scales effective horizon up to 2x (20 turns), admitting the fold
    const highGrowth = assessFoldTiming({
      ...base,
      candidateTokens: 20_000,
      estimatedRewriteTokens: 35_000,
      paybackHorizonTurns: 10,
      growthSinceFoldTokens: 75_000,
      growthStep: 25_000,
    });
    expect(highGrowth.allowed).toBe(true);
    expect(highGrowth.blockedBy).toBeNull();
  });

  it("keeps the gate open at a zero cache-read price when the summary is smaller", () => {
    const zeroPrice = { cacheRead: 0, output: 4, cacheWrite: 1 };
    for (const growth of [0, 100_000, 10_000_000]) {
      const t = assessFoldTiming({ ...base, price: zeroPrice, growthSinceFoldTokens: growth });
      expect(t.allowed).toBe(true);
      expect(t.blockedBy).toBeNull();
      expect(t.breakevenTurns).toBeNull();
    }
  });

  it("still blocks a fold whose summary is not smaller than its source at a zero price", () => {
    const t = assessFoldTiming({
      ...base,
      summaryRatio: 1.2,
      price: { cacheRead: 0, output: 4, cacheWrite: 1 },
    });
    expect(t.allowed).toBe(false);
    expect(t.blockedBy).toBe("cost");
  });
});

describe("engine fold gate", () => {
  function engineAt(windowTokens: number, projectedTokens: number) {
    const entries: { type: "message"; id: string; message: { role: string; content: string } }[] = [];
    for (let k = 1; k <= 12; k++) {
      entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user ${k}: ${"plan the cache layer ".repeat(60)}` } });
      entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant ${k}: ${"implemented a cache step ".repeat(60)}` } });
    }
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "sess-gate",
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => windowTokens,
        projectedTokens: () => projectedTokens,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 2, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    return engine;
  }

  it("emergency still nudges mid-task", () => {
    const engine = engineAt(100_000, 90_000);
    const d = engine.decideNudge();
    expect(d.kind).toBe("emergency");
    expect(engine.status().foldGate.blockedBy).toBe("mid-task");
  });

  it("reports the fill floor in fold_status text", () => {
    const engine = engineAt(1_000_000, 50_000);
    expect(engine.decideNudge().kind).toBeNull();
    expect(formatStatusReport(engine.status())).toContain("Fold gate: blocked by fill floor (context 50.0K < 80.0K)");
  });
});
