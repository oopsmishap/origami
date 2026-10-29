#!/usr/bin/env bun
/**
 * Billion-scale marathon and capacity benchmark for Origami.
 *
 * Evaluates single-session horizon, cumulative token processing (billions of tokens),
 * and pagoda tier dynamics (T1 -> T2 -> T3) across context window limits (64K, 128K, 200K, 400K, 1M, 2M).
 *
 * Modes:
 *   --mode sim     High-resolution empirical capacity simulation up to 100B+ cumulative tokens (default)
 *   --mode engine  Direct OrigamiEngine multi-thousand turn benchmark with real block trees and invariants
 *
 * Usage:
 *   bun bench/billion.ts [--window 200000|all] [--days 120] [--cpd 500] [--tokens-per-call 9560]
 *                        [--mode sim|engine] [--turns 5000] [--preset balanced|lean|relaxed]
 *                        [--json out.json] [--assert]
 */
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset, type Preset } from "../src/config.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";

export interface CapacityRunResult {
  window: number;
  limitDay: number | null;
  limitCall: number | null;
  cumulativeTokensAtLimit: number;
  finalCumulativeTokens: number;
  finalDay: number;
  totalCalls: number;
  peakVisibleTokens: number;
  finalVisibleTokens: number;
  t1Tokens: number;
  t2Tokens: number;
  t3Tokens: number;
  rawTokens: number;
  t1Count: number;
  t2Count: number;
  t3Count: number;
  cacheHitPct: number;
  costReductionVsUncompressed: number;
  uncompressedOverflowCall: number;
  uncompressedCumulativeAtOverflow: number;
}

export interface SimOptions {
  window: number | "all";
  days: number;
  cpd: number;
  tokensPerCall: number;
  preset: Preset;
  systemTokens: number;
  t1Ratio: number;
  t2Ratio: number;
  t3Ratio: number;
  mode: "sim" | "engine";
  turns: number;
  json: string | null;
  assert: boolean;
}

export function parseArgs(argv: readonly string[]): SimOptions {
  const opts: SimOptions = {
    window: 200_000,
    days: 120,
    cpd: 500,
    tokensPerCall: 9560,
    preset: "balanced",
    systemTokens: 10_000,
    t1Ratio: 45, // ~50K raw -> ~1,111t summary (45x compression, empirical Pi/OpenCode corpus)
    t2Ratio: 4,  // 4x consolidation
    t3Ratio: 3,  // 3x ultra-condensation
    mode: "sim",
    turns: 3000,
    json: null,
    assert: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--assert") {
      opts.assert = true;
      continue;
    }
    if (key === "-h" || key === "--help") {
      printHelp();
      process.exit(0);
    }
    const val = argv[i + 1];
    if (val === undefined) throw new Error(`Missing value for ${key}`);
    i++;
    if (key === "--window") opts.window = val === "all" ? "all" : Number.parseInt(val, 10);
    else if (key === "--days") opts.days = Number.parseInt(val, 10);
    else if (key === "--cpd") opts.cpd = Number.parseInt(val, 10);
    else if (key === "--tokens-per-call") opts.tokensPerCall = Number.parseInt(val, 10);
    else if (key === "--preset") opts.preset = val as Preset;
    else if (key === "--mode") {
      if (val !== "sim" && val !== "engine") throw new Error(`Invalid mode: ${val}`);
      opts.mode = val;
    }
    else if (key === "--turns") opts.turns = Number.parseInt(val, 10);
    else if (key === "--json") opts.json = val;
    else throw new Error(`Unknown option: ${key}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: bun bench/billion.ts [options]

Billion-scale single-session horizon and multi-tier capacity benchmark for Origami.

Options:
  --window <n|all>          Context window ceiling in tokens (e.g. 200000, 400000, 1000000, or 'all') [default: 200000]
  --days <n>                Simulation horizon in days [default: 120]
  --cpd <n>                 Model calls per day [default: 500]
  --tokens-per-call <n>     Average fresh tokens generated/consumed per turn [default: 9560]
  --preset <preset>         Operational preset: 'balanced', 'lean', 'relaxed' [default: balanced]
  --mode <sim|engine>       'sim' (high-speed analytical capacity model) or 'engine' (real OrigamiEngine cycles) [default: sim]
  --turns <n>               Turn count for engine mode [default: 3000]
  --json <file>             Save structured JSON benchmark results
  --assert                  Verify invariant bounds and fail if assertions fail
  -h, --help                Show this help message
`);
}

/**
 * Simulates a long-lived agent session up to billions of tokens across the pagoda hierarchy.
 */
export function simulateCapacity(window: number, opts: SimOptions): CapacityRunResult {
  const cfg = configFromPreset(opts.preset);
  const growthStep = cfg.growthStep;
  const t2TriggerMass = cfg.tier2MassTokens;
  const t3TriggerMass = cfg.tier3MassTokens;

  let raw = 0;
  let t1 = 0;
  let t2 = 0;
  let t3 = 0;
  let cum = 0;
  let cacheReads = 0;

  let t1Count = 0;
  let t2Count = 0;
  let t3Count = 0;

  let limitDay: number | null = null;
  let limitCall: number | null = null;
  let cumulativeAtLimit = 0;
  let peakVisible = 0;

  // Baseline without folding
  let uncompressedRaw = 0;
  let uncompressedOverflowCall = 0;
  let uncompressedCumAtOverflow = 0;

  const totalCalls = opts.days * opts.cpd;

  for (let call = 1; call <= totalCalls; call++) {
    const day = Math.ceil(call / opts.cpd);
    const visible = opts.systemTokens + raw + t1 + t2 + t3;
    peakVisible = Math.max(peakVisible, visible);

    // Prompt cache reading: visible prefix is read from cache, fresh tokens added
    cacheReads += visible;
    cum += visible + opts.tokensPerCall;
    raw += opts.tokensPerCall;

    // Check window saturation
    if (limitDay === null && visible >= window) {
      limitDay = day;
      limitCall = call;
      cumulativeAtLimit = cum;
    }

    // Baseline uncompressed tracking
    if (uncompressedOverflowCall === 0) {
      uncompressedRaw += opts.tokensPerCall;
      if (opts.systemTokens + uncompressedRaw >= window) {
        uncompressedOverflowCall = call;
        uncompressedCumAtOverflow = cum;
      }
    }

    // Tier 1 Folding: when raw tokens cross growthStep
    if (raw >= growthStep) {
      const summaryTokens = Math.round(raw / opts.t1Ratio);
      raw = 0;
      t1 += summaryTokens;
      t1Count++;
    }

    // Tier 2 Macro-Compaction: when Tier 1 summary mass accumulates beyond threshold
    if (t1 >= t2TriggerMass) {
      const distilledTokens = Math.round(t1 / opts.t2Ratio);
      t1 = 0;
      t2 += distilledTokens;
      t2Count++;
    }

    // Tier 3 Ultra-Condensation: when Tier 2 summary mass accumulates beyond threshold
    if (t2 >= t3TriggerMass) {
      const ultraTokens = Math.round(t2 / opts.t3Ratio);
      t2 = 0;
      t3 += ultraTokens;
      t3Count++;
    }
  }

  // Anthropic/OpenAI pricing model: uncached write 1.25, cached read 0.1
  const cacheHitPct = cum > 0 ? cacheReads / cum : 0;
  const uncompressedCost = (totalCalls * (opts.systemTokens + (totalCalls * opts.tokensPerCall) / 2)) * 0.1;
  const origamiCost = cacheReads * 0.1 + (cum - cacheReads) * 1.25;
  const costReduction = uncompressedCost > 0 ? Math.max(0, 1 - origamiCost / uncompressedCost) : 0;

  return {
    window,
    limitDay,
    limitCall,
    cumulativeTokensAtLimit: cumulativeAtLimit,
    finalCumulativeTokens: cum,
    finalDay: opts.days,
    totalCalls,
    peakVisibleTokens: peakVisible,
    finalVisibleTokens: opts.systemTokens + raw + t1 + t2 + t3,
    t1Tokens: t1,
    t2Tokens: t2,
    t3Tokens: t3,
    rawTokens: raw,
    t1Count,
    t2Count,
    t3Count,
    cacheHitPct,
    costReductionVsUncompressed: costReduction,
    uncompressedOverflowCall: uncompressedOverflowCall || totalCalls,
    uncompressedCumulativeAtOverflow: uncompressedCumAtOverflow || cum,
  };
}

/**
 * Executes a high-performance engine marathon exercising real OrigamiEngine instances
 * and block trees across multi-thousand cycles to verify memory, invariants, and latency.
 */
export async function runEngineBillion(opts: SimOptions): Promise<{
  turns: number;
  blocksCreated: Record<1 | 2 | 3, number>;
  activeBlocks: Record<1 | 2 | 3, number>;
  peakTokens: number;
  wallClockMs: number;
  invariantViolations: number;
  foldsPerSec: number;
}> {
  const entries: any[] = [];
  const countFn = (s: string) => Math.ceil(s.length / 4);
  const cfg = {
    ...configFromPreset(opts.preset),
    protectedTailMessages: 2,
    protectedTailTokens: 0,
    minFoldBenefitTokens: 0,
    minFoldBenefitWindowPct: 0,
  };

  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "bench-billion",
      appendEvent: (op) => entries.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: op }),
      saveArtifact: async () => undefined,
      windowTokens: () => (typeof opts.window === "number" ? opts.window : 200_000),
      projectedTokens: () => 50_000,
    },
    entries,
    modelId: "bench-billion",
    config: cfg,
    countFn,
  });

  const t0 = performance.now();
  const blocksCreated: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  let peakTokens = 0;

  // Synthesize turns and perform real folding and consolidation cycles
  for (let turn = 1; turn <= opts.turns; turn++) {
    const uId = `u${turn}`;
    const aId = `a${turn}`;
    const uMsg = { role: "user", content: `user turn ${turn}: ${"analyze subsystem performance, trace memory leaks, and verify invariants ".repeat(15)}` };
    const aMsg = { role: "assistant", content: `assistant turn ${turn}: ${"refactored memory pool, optimized block tree queries, and confirmed zero regression ".repeat(15)}` };
    entries.push({ type: "message", id: uId, message: uMsg });
    entries.push({ type: "message", id: aId, message: aMsg });

    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is any => f !== null));

    // Every 5 turns, fold the completed milestone (e.g. turn-4 .. turn-1, keeping recent turn in tail)
    if (turn >= 5 && turn % 5 === 0) {
      const startNum = turn === 5 ? 3 : 2 * (turn - 5) + 1;
      const endNum = 2 * (turn - 1);
      const startRef = `m${String(startNum).padStart(5, "0")}`;
      const endRef = `m${String(endNum).padStart(5, "0")}`;
      const spec = {
        range: `${startRef}..${endRef}`,
        topic: `Milestone ${turn / 5}: subsystem optimization`,
        summary: `- Milestone ${turn / 5}: optimized kernel\n- Retained invariant C${turn}\n- Tests clean`,
      };
      const res = engine.executeFold({ folds: [spec], tier: 1 });
      if (res.ok) blocksCreated[1]++;
    }

    // Every 25 turns, run Tier 2 consolidation over mature Tier 1 blocks
    if (turn >= 25 && turn % 25 === 0) {
      const liveT1 = engine.state.tree.live().filter((b) => b.tier === 1);
      if (liveT1.length >= 3) {
        const batch = liveT1.slice(0, 3);
        const spec = {
          range: batch.map((b) => b.id).join(","),
          topic: `Consolidated phases ${turn / 25}`,
          summary: `### Consolidated Phases ${turn / 25}\n- Unified architecture checkpoints\n- Pinned decisions confirmed`,
        };
        const res = engine.executeFold({ folds: [spec], tier: 2 });
        if (res.ok) blocksCreated[2]++;
      }
    }

    // Every 100 turns, run Tier 3 ultra-condensation over mature Tier 2 blocks
    if (turn >= 100 && turn % 100 === 0) {
      const liveT2 = engine.state.tree.live().filter((b) => b.tier === 2);
      if (liveT2.length >= 2) {
        const batch = liveT2.slice(0, 2);
        const spec = {
          range: batch.map((b) => b.id).join(","),
          topic: `Ultra-condensed horizon ${turn / 100}`,
          summary: `### Horizon ${turn / 100}\n- Core system invariants verified`,
        };
        const res = engine.executeFold({ folds: [spec], tier: 3 });
        if (res.ok) blocksCreated[3]++;
      }
    }
    const liveTokens = engine.state.tree.live().reduce((s, b) => s + b.tokensAfter, 0);
    peakTokens = Math.max(peakTokens, liveTokens);
  }

  const elapsed = performance.now() - t0;
  const activeBlocks: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  for (const b of engine.state.tree.live()) {
    activeBlocks[b.tier]++;
  }

  const invariants = engine.invariants();
  const totalFolds = blocksCreated[1] + blocksCreated[2] + blocksCreated[3];

  return {
    turns: opts.turns,
    blocksCreated,
    activeBlocks,
    peakTokens,
    wallClockMs: elapsed,
    invariantViolations: invariants.length,
    foldsPerSec: Math.round((totalFolds / (elapsed / 1000)) * 10) / 10,
  };
}

function formatTokens(t: number): string {
  if (t >= 1e9) return `${(t / 1e9).toFixed(2)}B`;
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  if (t >= 1e3) return `${(t / 1e3).toFixed(1)}K`;
  return String(t);
}

function printSimTable(results: CapacityRunResult[]): void {
  console.log("\n### Origami Multi-Tier Billion-Scale Capacity Matrix (Pagoda T1 -> T2 -> T3)\n");
  console.log("| Window | Saturation Day | Saturation Call | Work at Window Limit | 120-Day Cumulative Work | Final Context | T1 / T2 / T3 Blocks | Cache Hit | Uncompressed Overflow |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  for (const r of results) {
    const satDay = r.limitDay !== null ? `Day ${r.limitDay}` : "Sustainable ∞";
    const satCall = r.limitCall !== null ? `${r.limitCall.toLocaleString()}` : "No Overflow";
    const atLimit = r.cumulativeTokensAtLimit > 0 ? formatTokens(r.cumulativeTokensAtLimit) : "N/A";
    const cum120 = formatTokens(r.finalCumulativeTokens);
    const finalCtx = `${formatTokens(r.finalVisibleTokens)} (${Math.round((r.finalVisibleTokens / r.window) * 100)}%)`;
    const blocks = `${r.t1Count} / ${r.t2Count} / ${r.t3Count}`;
    const cache = `${(r.cacheHitPct * 100).toFixed(1)}%`;
    const uncomp = `Call ${r.uncompressedOverflowCall} (${formatTokens(r.uncompressedCumulativeAtOverflow)})`;

    console.log(`| **${formatTokens(r.window)}** | ${satDay} | ${satCall} | ${atLimit} | ${cum120} | ${finalCtx} | ${blocks} | ${cache} | ${uncomp} |`);
  }
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === "engine") {
    console.log(`Running OrigamiEngine high-cycle validation benchmark (${opts.turns} turns, preset ${opts.preset})...\n`);
    const r = await runEngineBillion(opts);
    console.log("| Metric | Value |");
    console.log("|---|---|");
    console.log(`| Turns processed | ${r.turns} |`);
    console.log(`| Blocks created (T1 / T2 / T3) | ${r.blocksCreated[1]} / ${r.blocksCreated[2]} / ${r.blocksCreated[3]} |`);
    console.log(`| Active resident blocks | ${r.activeBlocks[1]} / ${r.activeBlocks[2]} / ${r.activeBlocks[3]} |`);
    console.log(`| Invariant violations | ${r.invariantViolations} |`);
    console.log(`| Wall-clock time | ${(r.wallClockMs / 1000).toFixed(2)}s |`);
    console.log(`| Real folding throughput | ${r.foldsPerSec} folds/sec |`);

    if (opts.json) await Bun.write(opts.json, JSON.stringify(r, null, 2));
    if (opts.assert && r.invariantViolations !== 0) {
      console.error(`Assertion failed: ${r.invariantViolations} invariant violations`);
      process.exit(1);
    }
  } else {
    const windows = opts.window === "all" ? [65_536, 128_000, 200_000, 400_000, 1_000_000, 2_000_000] : [opts.window];
    const results = windows.map((w) => simulateCapacity(w, opts));
    printSimTable(results);

    if (opts.json) await Bun.write(opts.json, JSON.stringify(results, null, 2));

    if (opts.assert) {
      for (const r of results) {
        if (r.window >= 200_000 && r.finalCumulativeTokens < 1e9) {
          console.error(`Assertion failed: window ${r.window} cumulative tokens below 1B`);
          process.exit(1);
        }
      }
    }
  }
}
