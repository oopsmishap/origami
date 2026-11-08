/**
 * Hot-path benchmark: the three costs that scale with session length.
 *
 *   bun bench/hot-path.ts
 *
 * Each case is measured against a synthetic session; the numbers printed here are the
 * ones quoted in CHANGELOG v0.6.1. No assertions: this is a manual regression check.
 */
import { SessionState } from "../src/kernel/state.ts";
import type { SessionEntryLike } from "../src/kernel/registry.ts";
import { planRender } from "../src/kernel/render.ts";
import { buildCacheReport, type CacheSample, type FoldEvent } from "../src/kernel/cache-report.ts";
import type { Block, BoundMessage } from "../src/kernel/types.ts";

function ref(n: number): string {
  return `m${String(n).padStart(5, "0")}`;
}

function entries(n: number): SessionEntryLike[] {
  const out: SessionEntryLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: "message",
      id: `e${i}`,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ${"context text ".repeat(40)}` },
    });
  }
  return out;
}

function measure(label: string, run: () => void, iterations = 5): void {
  run();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) run();
  const ms = (performance.now() - started) / iterations;
  console.log(`${label.padEnd(44)} ${ms.toFixed(2).padStart(8)} ms`);
}

function refreshCase(n: number): void {
  const all = entries(n);
  const appended: SessionEntryLike[] = [...all, { type: "message", id: "extra", message: { role: "user", content: "one more turn" } }];
  // The state build is setup, not cost: measure only the append into a fresh state.
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const state = new SessionState({ sessionId: "bench", modelId: "test", entries: all, countFn: null });
    const started = performance.now();
    state.refresh(appended);
    samples.push(performance.now() - started);
  }
  const ms = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  console.log(`${`refresh · one append @ ${n} messages`.padEnd(44)} ${ms.toFixed(3).padStart(8)} ms`);
}

function renderCase(n: number, blockCount: number): void {
  const bound: BoundMessage[] = [];
  for (let i = 0; i < n; i++) {
    bound.push({
      index: i,
      ref: ref(i + 1),
      ephemeral: i % 5 === 0,
      turn: Math.floor(i / 10),
      role: i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "toolResult",
      contentHash: `h${i}`,
      signedThinking: false,
      text: `text ${i}`,
      prose: `text ${i}`,
      isError: false,
      bytes: 10,
    });
  }
  const blocks: Block[] = [];
  const per = Math.floor(n / (blockCount + 1));
  for (let b = 0; b < blockCount; b++) {
    blocks.push({
      id: `b${b + 1}`,
      tier: 1,
      ranges: [{ start: ref(b * per + 1), end: ref((b + 1) * per) }],
      topic: "t",
      summary: "s",
      children: [],
      status: "active",
      consumedBy: null,
      tokensBefore: 1_000,
      tokensAfter: 100,
      createdAt: b,
      anchorRef: null,
    });
  }
  measure(`planRender · ${n} messages / ${blockCount} blocks`, () => planRender({ bound, blocks, pinnedHeadIndex: 0 }));
}

function reportCase(sampleCount: number, foldCount: number): void {
  const samples: CacheSample[] = [];
  const folds: FoldEvent[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push({ at: i * 1_000, input: 100_000 + i, cached: i % 20 === 0 ? 10_000 : 95_000, write: 1_000, foldEventId: null, hostRewrite: false });
  }
  for (let f = 0; f < foldCount; f++) {
    folds.push({
      id: `b${f + 1}`,
      at: Math.floor(((f + 1) * sampleCount) / (foldCount + 1)) * 1_000,
      tier: 1,
      replacedTokens: 40_000,
      summaryTokens: 800,
    });
  }
  measure(`buildCacheReport · ${sampleCount} rounds / ${foldCount} folds`, () => buildCacheReport(samples, folds));
}

console.log("origami hot path");
refreshCase(16_000);
renderCase(10_000, 100);
reportCase(8_000, 50);
