/**
 * Real-world benchmark against long-running coding agent context using OpenRouter.
 *
 * Evaluates Origami's hierarchical context folding and JIT reactive hydration
 * against an uncompressed/sliding-window baseline on a real multi-turn session
 * using openai/gpt-oss-120b on OpenRouter.
 *
 * Usage:
 *   bun bench/real-world.ts [options]
 *
 * Options:
 *   --session <path>      Path to session journal (.jsonl)
 *   --model <slug>        Model slug [default: openai/gpt-oss-120b:free -> fallback to openai/gpt-oss-120b]
 *   --apiKey <key>        OpenRouter API key [default: from ~/.omp/agent/agent.db]
 *   --milestones <list>   Comma-separated request indexes [default: 40,90,160,240,320]
 *   --preset <preset>     Origami preset: balanced | lean | relaxed [default: balanced]
 *   --window <tokens>     Model context window ceiling [default: 131072]
 *   --json <file>         Path to write JSON benchmark report
 *   --markdown <file>     Path to write Markdown benchmark report
 *   -h, --help            Show help
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { configFromPreset, type Preset } from "../src/config.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { entryMessage } from "../src/kernel/registry.ts";
import { kernelMessagesFromEntries } from "../src/runtime.ts";
import type { SessionEntryLike } from "../src/kernel/state.ts";
import { parseJournal, linearBranch, countTokens, type JournalEntry } from "./replay-lib.ts";
import { decideReplayPolicy, createReplayPolicyState } from "./replay-policy.ts";

interface BenchmarkOptions {
  sessionPath: string;
  model: string;
  apiKey: string;
  milestones: number[];
  preset: Preset;
  windowTokens: number;
  jsonPath: string | null;
  markdownPath: string | null;
}

interface ProbeDefinition {
  id: string;
  name: string;
  question: string;
  rubric: {
    part1: { desc: string; keywords: string[] };
    part2: { desc: string; keywords: string[] };
  };
}

const PROBES: ProbeDefinition[] = [
  {
    id: "repo-and-tools",
    name: "Repo Target & Tools Exclusion",
    question: "What specific GitHub repository and organization was Origami instructed to be pushed to, and what was the strict rule specified regarding shipping the tools/ directory?",
    rubric: {
      part1: { desc: "Repository: oopsmishap/origami", keywords: ["oopsmishap", "origami"] },
      part2: { desc: "Tools constraint: do not ship tools/", keywords: ["tools", "not", "ship", "exclude"] }
    }
  },
  {
    id: "telemetry-bug",
    name: "Telemetry Percentage Bug Fix",
    question: "What issue was reported with the Web UI displaying 900% or 1100% context occupancy, and how was the occupancy percentage calculation corrected?",
    rubric: {
      part1: { desc: "Root cause: 100x over-scaling or percentage bug", keywords: ["100", "percent", "scale", "over-scaling", "900", "1100", "multiplied"] },
      part2: { desc: "Fix: aligned live vs projected tokens", keywords: ["align", "projected", "live", "calculation", "formula", "fix", "ratio"] }
    }
  },
  {
    id: "trajectory-port",
    name: "Trajectory Visualization Port",
    question: "What visualization was ported from billion-context into Origami's TUI and WebUI, and how were trajectory bars bounded and scaled?",
    rubric: {
      part1: { desc: "Feature: 1:1 bar trajectory chart from billion-context", keywords: ["billion-context", "trajectory", "bar", "chart"] },
      part2: { desc: "Bounds & scaling: 50 visible turns and visible peak scaling", keywords: ["50", "visible", "peak", "bound", "ceiling"] }
    }
  },
  {
    id: "agent-neutrality",
    name: "Agent Generality & Branding",
    question: "What explicit instructions did the user give regarding whether Origami branding, logos, and socials should mention omp or tern specifically?",
    rubric: {
      part1: { desc: "Constraint: do not mention omp or tern specifically", keywords: ["not mention", "tern", "omp", "avoid", "omit", "agnostic"] },
      part2: { desc: "Rationale: support other agents in the future", keywords: ["other agent", "future", "support", "generic", "general"] }
    }
  }
];

function scoreResponse(text: string, probe: ProbeDefinition): { score: number; p1: boolean; p2: boolean } {
  const lower = text.toLowerCase();
  const p1 = probe.rubric.part1.keywords.some((k) => lower.includes(k));
  const p2 = probe.rubric.part2.keywords.some((k) => lower.includes(k));
  const score = (p1 ? 0.5 : 0) + (p2 ? 0.5 : 0);
  return { score, p1, p2 };
}

function resolveApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const db = new Database("C:/Users/mishap/.omp/agent/agent.db");
    const row = db.query("SELECT data FROM auth_credentials WHERE provider = 'openrouter' AND disabled_cause IS NULL").get() as any;
    if (row?.data) return JSON.parse(row.data).key;
  } catch {}
  throw new Error("OpenRouter API key not found in environment or agent.db");
}

function defaultSessionPath(): string {
  const candidate = "C:/Users/mishap/.omp/agent/sessions/--H--projects-_mishap_-origami--/2026-10-28T18-40-20-551Z_01a183d0-2c47-752f-8671-8ee42d97abc3.jsonl";
  if (existsSync(candidate)) return candidate;
  return "tests/fixtures/replay-session.jsonl";
}

function parseArgs(argv: readonly string[]): BenchmarkOptions {
  const o: BenchmarkOptions = {
    sessionPath: defaultSessionPath(),
    model: "recursive/flint-v1.0:free",
    apiKey: "",
    milestones: [40, 90, 160, 240, 320],
    preset: "balanced",
    windowTokens: 262144,
    jsonPath: "bench/results/real-world-flint-free.json",
    markdownPath: "bench/results/real-world-flint-free.md"
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      console.log(`Usage: bun bench/real-world.ts [options]
      
  --session <file>     Session journal (.jsonl) [default: authentic 436K token session]
  --model <slug>       OpenRouter model slug [default: recursive/flint-v1.0:free]
  --apiKey <key>       OpenRouter API key (auto-resolved from agent.db if omitted)
  --milestones <list>  Comma-separated request numbers [default: 40,90,160,240,320]
  --preset <preset>    Origami preset: balanced | lean | relaxed [default: balanced]
  --window <tokens>    Model context ceiling [default: 262144]
  --json <file>        Output JSON report path
  --markdown <file>    Output Markdown report path
`);
      process.exit(0);
    }
    if (a === "--session") o.sessionPath = argv[++i]!;
    else if (a === "--model") o.model = argv[++i]!.replace(/^openrouter\//, "");
    else if (a === "--apiKey") o.apiKey = argv[++i]!;
    else if (a === "--milestones") o.milestones = argv[++i]!.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    else if (a === "--preset") o.preset = argv[++i]! as Preset;
    else if (a === "--window") o.windowTokens = parseInt(argv[++i]!, 10);
    else if (a === "--json") o.jsonPath = argv[++i]!;
    else if (a === "--markdown") o.markdownPath = argv[++i]!;
  }

  if (!o.apiKey) o.apiKey = resolveApiKey();
  return o;
}

interface OpenRouterResponse {
  content: string;
  reasoning?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  latencyMs: number;
  resolvedModel: string;
}

async function queryOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 800
): Promise<OpenRouterResponse> {
  let targetModel = model;
  const t0 = performance.now();

  let json: any;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/oopsmishap/origami",
        "X-Title": "Origami Real-World Context Benchmark"
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(20000)
    });

    json = await resp.json();

    if (!resp.ok) {
      throw new Error(`OpenRouter API error (${resp.status}): ${JSON.stringify(json?.error || json)}`);
    }
  } catch (err: any) {
    throw new Error(err.message || String(err));
  }
  const t1 = performance.now();
  const choice = json.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? "";
  const reasoning = message?.reasoning ?? (message?.reasoning_details?.[0]?.text ?? "");

  const usage = json.usage ?? {};
  return {
    content: content || reasoning,
    reasoning,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cost: usage.cost ?? 0,
    latencyMs: Math.round(t1 - t0),
    resolvedModel: json.model ?? targetModel
  };
}

interface ProbeResult {
  probeId: string;
  probeName: string;
  baseline: {
    score: number;
    tokens: number;
    cachedTokens: number;
    latencyMs: number;
    cost: number;
    responsePreview: string;
  };
  origami: {
    score: number;
    tokens: number;
    cachedTokens: number;
    latencyMs: number;
    cost: number;
    responsePreview: string;
  };
}

interface MilestoneResult {
  requestIndex: number;
  rawCumulativeTokens: number;
  baselineContextTokens: number;
  origamiContextTokens: number;
  compressionRatio: number;
  activeFolds: { t1: number; t2: number; t3: number };
  probes: ProbeResult[];
}

export interface BenchmarkSummary {
  resolvedModel: string;
  totalMilestones: number;
  meanBaselineAcc: number;
  meanOrigamiAcc: number;
  baselineTotalCost: number;
  origamiTotalCost: number;
  costSavingsPct: number;
  meanBaselineTokens: number;
  meanOrigamiTokens: number;
  tokenReductionPct: number;
  meanOrigamiCacheHitPct: number;
}

export interface BenchmarkResult {
  options: BenchmarkOptions;
  milestones: MilestoneResult[];
  summary: BenchmarkSummary;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  console.log(`\n========================================================================`);
  console.log(`  ORIGAMI REAL-WORLD BENCHMARK · LONG-RUNNING CONTEXT`);
  console.log(`========================================================================`);
  console.log(`Session: ${opts.sessionPath}`);
  console.log(`Model: ${opts.model}`);
  console.log(`Preset: ${opts.preset} · Window ceiling: ${opts.windowTokens.toLocaleString()} tokens`);
  console.log(`Milestones: [${opts.milestones.join(", ")}]\n`);

  const journalText = readFileSync(opts.sessionPath, "utf8");
  const { entries } = parseJournal(journalText);
  const branch = linearBranch(entries);

  console.log(`Parsed branch: ${branch.length} entries across session.`);

  const working: JournalEntry[] = [];
  let appended = 0;
  let now = 0;
  let prevNow: number | null = null;
  let renderedTokens = 0;

  const config = configFromPreset(opts.preset);
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "bench-real-world",
      appendEvent: (op) => {
        working.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, id: `bench-${++appended}`, data: op });
      },
      saveArtifact: async () => undefined,
      windowTokens: () => opts.windowTokens,
      projectedTokens: () => renderedTokens
    },
    entries: [],
    modelId: opts.model,
    config,
    countFn: countTokens,
    now: () => now
  });

  const policyState = createReplayPolicyState();

  const foldAll = (specs: { range: string; topic: string; summary: string }[], tier: 1 | 2 | 3): number => {
    let pending = specs.filter((s) => s.summary.length > 0);
    while (pending.length > 0) {
      const res = engine.executeFold({ folds: pending, tier });
      if (res.ok) {
        return res.outcome.blocks.reduce((s, b) => s + b.tokensAfter, 0);
      }
      pending = pending.filter((_, i) => i !== res.foldIndex);
    }
    return 0;
  };

  const simulateFold = (): number => {
    const decision = decideReplayPolicy("current", engine, policyState);
    if (decision.kind === "promotion" && decision.promotion) {
      const fromTier = decision.promotion.fromTier;
      const blocks = engine.state.tree.live().filter((b) => b.tier === fromTier);
      if (blocks.length < 2) return 0;
      const range = blocks.map((b) => b.id).join(",");
      const spec = {
        range,
        tier: (fromTier + 1) as 2 | 3,
        topic: `Consolidated ${blocks[0]!.id}..${blocks.at(-1)!.id}`,
        summary: `- ${blocks.map((b) => b.topic).join("\n- ")}`
      };
      return foldAll([spec], (fromTier + 1) as 2 | 3);
    }
    if (decision.kind === "efficiency" || decision.kind === "emergency") {
      const specs = engine.recommendedRanges().map((x) => ({
        range: `${x.start}..${x.end}`,
        topic: `Phase ${x.start}..${x.end}`,
        summary: engine.archiveDigest([{ start: x.start, end: x.end }])
      }));
      return foldAll(specs, 1);
    }
    return 0;
  };

  let assistantCount = 0;
  let rawCumulativeTokens = 0;
  let lastMessageRole: string | undefined;
  const milestoneResults: MilestoneResult[] = [];
  const milestonesSet = new Set(opts.milestones);
  let resolvedModelName = opts.model;

  for (let entryIdx = 0; entryIdx < branch.length; entryIdx++) {
    const entry = branch[entryIdx]!;
    const msg = entry.type === "message" ? (entry.message || entry.content) : undefined;
    const role = (msg as any)?.role;
    const content = (msg as any)?.content;
    const textContent = typeof content === "string" ? content : JSON.stringify(content ?? "");
    rawCumulativeTokens += countTokens(textContent);

    if (role !== "assistant") {
      working.push(entry);
      if (entryMessage(entry as SessionEntryLike) !== undefined) {
        lastMessageRole = (entryMessage(entry as SessionEntryLike) as any)?.role;
      }
      continue;
    }

    assistantCount++;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    now = Number.isFinite(ts) ? ts : (prevNow ?? 0) + 1000;
    prevNow = now;

    engine.refresh(working as SessionEntryLike[]);
    engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
    if (lastMessageRole === "user") engine.onTurnStart();

    // Execute Origami engine folds
    const foldSigma = simulateFold();
    if (foldSigma > 0) {
      engine.refresh(working as SessionEntryLike[]);
      engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
    }

    // Check if this assistant turn is one of our target milestones
    if (milestonesSet.has(assistantCount)) {
      console.log(`\n>>> Evaluating Milestone: Request #${assistantCount} (${rawCumulativeTokens.toLocaleString()} raw tokens)`);

      const rawMessages = working.map((e) => entryMessage(e as SessionEntryLike)).filter(Boolean) as any[];

      // 1. Construct Origami Context
      const makeFoldMessage = (text: string, blockId: string, refTag?: string) => ({
        role: "user",
        content: refTag ? `${refTag} ${text}` : text
      });

      const renderedRaw = engine.render(rawMessages, makeFoldMessage as any);
      const origamiMessages: Array<{ role: string; content: string }> = [];

      // Add system prompt with Origami compression context
      origamiMessages.push({
        role: "system",
        content: "You are an expert software engineer reviewing a long-running coding session. The session history has been hierarchically compressed into summary blocks with active tail messages and reactive hydration hints. Answer accurately based on the session's facts, constraints, and decisions."
      });

      for (const m of renderedRaw) {
        const r = (m as any)?.role === "assistant" ? "assistant" : "user";
        const c = typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
        origamiMessages.push({ role: r, content: c });
      }

      // Add JIT reactive hydration notice
      const hydration = engine.hydrationText();
      if (hydration) {
        origamiMessages.push({ role: "user", content: hydration });
      }

      const origamiTokens = origamiMessages.reduce((s, m) => s + countTokens(m.content), 0);

      // 2. Construct Baseline Context (Sliding window truncated to fit 120,000 tokens if necessary)
      const baselineMessages: Array<{ role: string; content: string }> = [];
      baselineMessages.push({
        role: "system",
        content: "You are an expert software engineer reviewing a long-running coding session transcript. Answer accurately based on the session's facts, constraints, and decisions."
      });

      let currentBaseTokens = countTokens(baselineMessages[0]!.content);
      const reversedRaw: Array<{ role: string; content: string }> = [];

      for (let i = rawMessages.length - 1; i >= 0; i--) {
        const m = rawMessages[i];
        const r = m.role === "assistant" ? "assistant" : "user";
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const tok = countTokens(c);
        const maxBaseTokens = Math.max(10000, opts.windowTokens - 10000);
        if (currentBaseTokens + tok > maxBaseTokens) break; // Window cap to prevent context length error
        currentBaseTokens += tok;
        reversedRaw.push({ role: r, content: c });
      }
      reversedRaw.reverse();
      baselineMessages.push(...reversedRaw);

      const baselineTokens = baselineMessages.reduce((s, m) => s + countTokens(m.content), 0);
      const liveBlocks = engine.state.tree.live();
      const foldsT1 = liveBlocks.filter((b) => b.tier === 1).length;
      const foldsT2 = liveBlocks.filter((b) => b.tier === 2).length;
      const foldsT3 = liveBlocks.filter((b) => b.tier === 3).length;

      console.log(`    Context Tokens: Baseline = ${baselineTokens.toLocaleString()} | Origami = ${origamiTokens.toLocaleString()} (${(baselineTokens / origamiTokens).toFixed(1)}x compression)`);
      console.log(`    Active Blocks: T1: ${foldsT1}, T2: ${foldsT2}, T3: ${foldsT3}`);

      const probeResults: ProbeResult[] = [];

      for (const probe of PROBES) {
        console.log(`    - Probing [${probe.id}]: "${probe.name}"...`);

        // Baseline Query
        const baseQuery = [...baselineMessages, { role: "user", content: probe.question }];
        let baseRes: OpenRouterResponse;
        try {
          baseRes = await queryOpenRouter(opts.apiKey, opts.model, baseQuery);
        } catch (e: any) {
          console.log(`      Baseline query error: ${e.message}`);
          baseRes = { content: `Error: ${e.message}`, promptTokens: baselineTokens, completionTokens: 0, cachedTokens: 0, cost: 0, latencyMs: 0, resolvedModel: opts.model };
        }

        // Origami Query
        const origQuery = [...origamiMessages, { role: "user", content: probe.question }];
        let origRes: OpenRouterResponse;
        try {
          origRes = await queryOpenRouter(opts.apiKey, opts.model, origQuery);
          resolvedModelName = origRes.resolvedModel;
        } catch (e: any) {
          console.log(`      Origami query error: ${e.message}`);
          origRes = { content: `Error: ${e.message}`, promptTokens: origamiTokens, completionTokens: 0, cachedTokens: 0, cost: 0, latencyMs: 0, resolvedModel: opts.model };
        }

        const baseScore = scoreResponse(baseRes.content, probe);
        const origScore = scoreResponse(origRes.content, probe);

        console.log(`      Baseline -> Score: ${(baseScore.score * 100).toFixed(0)}% | Latency: ${baseRes.latencyMs}ms | Cost: $${baseRes.cost.toFixed(6)}`);
        console.log(`      Origami  -> Score: ${(origScore.score * 100).toFixed(0)}% | Latency: ${origRes.latencyMs}ms | Cost: $${origRes.cost.toFixed(6)} (Cached: ${origRes.cachedTokens})`);

        probeResults.push({
          probeId: probe.id,
          probeName: probe.name,
          baseline: {
            score: baseScore.score,
            tokens: baseRes.promptTokens,
            cachedTokens: baseRes.cachedTokens,
            latencyMs: baseRes.latencyMs,
            cost: baseRes.cost,
            responsePreview: baseRes.content.slice(0, 150).replace(/\n/g, " ")
          },
          origami: {
            score: origScore.score,
            tokens: origRes.promptTokens,
            cachedTokens: origRes.cachedTokens,
            latencyMs: origRes.latencyMs,
            cost: origRes.cost,
            responsePreview: origRes.content.slice(0, 150).replace(/\n/g, " ")
          }
        });
      }

      milestoneResults.push({
        requestIndex: assistantCount,
        rawCumulativeTokens,
        baselineContextTokens: baselineTokens,
        origamiContextTokens: origamiTokens,
        compressionRatio: baselineTokens / origamiTokens,
        activeFolds: { t1: foldsT1, t2: foldsT2, t3: foldsT3 },
        probes: probeResults
      });
    }

    working.push(entry);
    lastMessageRole = "assistant";
  }

  // Summary calculations
  let totalProbes = 0;
  let sumBaseAcc = 0;
  let sumOrigAcc = 0;
  let sumBaseCost = 0;
  let sumOrigCost = 0;
  let sumBaseTokens = 0;
  let sumOrigTokens = 0;
  let sumOrigCacheHit = 0;

  for (const m of milestoneResults) {
    for (const p of m.probes) {
      totalProbes++;
      sumBaseAcc += p.baseline.score;
      sumOrigAcc += p.origami.score;
      sumBaseCost += p.baseline.cost;
      sumOrigCost += p.origami.cost;
      sumBaseTokens += p.baseline.tokens;
      sumOrigTokens += p.origami.tokens;
      if (p.origami.tokens > 0) {
        sumOrigCacheHit += (p.origami.cachedTokens / p.origami.tokens);
      }
    }
  }

  const meanBaseAcc = totalProbes > 0 ? (sumBaseAcc / totalProbes) * 100 : 0;
  const meanOrigAcc = totalProbes > 0 ? (sumOrigAcc / totalProbes) * 100 : 0;
  const costSavings = sumBaseCost > 0 ? ((sumBaseCost - sumOrigCost) / sumBaseCost) * 100 : 0;
  const tokenReduction = sumBaseTokens > 0 ? ((sumBaseTokens - sumOrigTokens) / sumBaseTokens) * 100 : 0;
  const meanCacheHit = totalProbes > 0 ? (sumOrigCacheHit / totalProbes) * 100 : 0;

  const result = {
    options: { ...opts, apiKey: "[REDACTED]" },
    milestones: milestoneResults,
    summary: {
      resolvedModel: resolvedModelName,
      totalMilestones: milestoneResults.length,
      meanBaselineAcc: Math.round(meanBaseAcc * 10) / 10,
      meanOrigamiAcc: Math.round(meanOrigAcc * 10) / 10,
      baselineTotalCost: sumBaseCost,
      origamiTotalCost: sumOrigCost,
      costSavingsPct: Math.round(costSavings * 10) / 10,
      meanBaselineTokens: Math.round(sumBaseTokens / Math.max(1, totalProbes)),
      meanOrigamiTokens: Math.round(sumOrigTokens / Math.max(1, totalProbes)),
      tokenReductionPct: Math.round(tokenReduction * 10) / 10,
      meanOrigamiCacheHitPct: Math.round(meanCacheHit * 10) / 10
    }
  };

  renderBenchmarkReport(result);

  if (opts.jsonPath) {
    mkdirSync(dirname(opts.jsonPath), { recursive: true });
    writeFileSync(opts.jsonPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`\nSaved JSON benchmark report to: ${opts.jsonPath}`);
  }

  if (opts.markdownPath) {
    mkdirSync(dirname(opts.markdownPath), { recursive: true });
    writeFileSync(opts.markdownPath, formatMarkdownReport(result), "utf8");
    console.log(`Saved Markdown benchmark report to: ${opts.markdownPath}`);
  }

  return result;
}

function renderBenchmarkReport(result: BenchmarkResult): void {
  const { summary, milestones, options } = result;

  console.log(`\n========================================================================`);
  console.log(`  REAL-WORLD BENCHMARK RESULTS · ${summary.resolvedModel}`);
  console.log(`========================================================================\n`);

  console.log(`| Milestone | Raw Tokens | Base Tokens | Origami Tokens | Ratio | Base Acc | Origami Acc | Base Cost | Origami Cost | Net Saved |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|`);

  for (const m of milestones) {
    const baseAcc = (m.probes.reduce((s, p) => s + p.baseline.score, 0) / m.probes.length) * 100;
    const origAcc = (m.probes.reduce((s, p) => s + p.origami.score, 0) / m.probes.length) * 100;
    const baseCost = m.probes.reduce((s, p) => s + p.baseline.cost, 0);
    const origCost = m.probes.reduce((s, p) => s + p.origami.cost, 0);
    const saved = baseCost > 0 ? ((baseCost - origCost) / baseCost) * 100 : 0;

    console.log(
      `| Req #${m.requestIndex} | ${m.rawCumulativeTokens.toLocaleString()} | ${m.baselineContextTokens.toLocaleString()} | ${m.origamiContextTokens.toLocaleString()} | ${m.compressionRatio.toFixed(1)}x | ${baseAcc.toFixed(0)}% | ${origAcc.toFixed(0)}% | $${baseCost.toFixed(5)} | $${origCost.toFixed(5)} | ${saved.toFixed(1)}% |`
    );
  }

  console.log(`\n------------------------------------------------------------------------`);
  console.log(`OVERALL EXECUTIVE SUMMARY:`);
  console.log(`- Model: ${summary.resolvedModel}`);
  console.log(`- Accuracy / Fact Retention: Baseline ${summary.meanBaselineAcc}% vs. Origami ${summary.meanOrigamiAcc}% (+${(summary.meanOrigamiAcc - summary.meanBaselineAcc).toFixed(1)}% delta)`);
  console.log(`- Mean Prompt Tokens: Baseline ${summary.meanBaselineTokens.toLocaleString()} vs. Origami ${summary.meanOrigamiTokens.toLocaleString()} (${summary.tokenReductionPct}% token reduction)`);
  console.log(`- Total Billed Cost: Baseline $${summary.baselineTotalCost.toFixed(4)} vs. Origami $${summary.origamiTotalCost.toFixed(4)} (${summary.costSavingsPct}% dollar savings)`);
  console.log(`- Origami Prompt Cache Hit Rate: ${summary.meanOrigamiCacheHitPct}%`);
  console.log(`------------------------------------------------------------------------\n`);
}

function formatMarkdownReport(result: BenchmarkResult): string {
  const { summary, milestones, options } = result;

  let md = `# Origami Real-World Context Benchmark Report

**Model**: \`${summary.resolvedModel}\`  
**Session Journal**: \`${options.sessionPath}\`  
**Preset**: \`${options.preset}\`  
**Context Window Ceiling**: \`${options.windowTokens.toLocaleString()}\` tokens  

---

## Executive Summary

| Metric | Baseline (Sliding Window) | Origami (Hierarchical Compaction) | Delta / Improvement |
|---|---|---|---|
| **Fact Retention / Needle Recall** | ${summary.meanBaselineAcc}% | **${summary.meanOrigamiAcc}%** | **+${(summary.meanOrigamiAcc - summary.meanBaselineAcc).toFixed(1)}%** |
| **Mean Prompt Context Size** | ${summary.meanBaselineTokens.toLocaleString()} tokens | **${summary.meanOrigamiTokens.toLocaleString()} tokens** | **${summary.tokenReductionPct}% reduction** |
| **Total Inference Cost** | $${summary.baselineTotalCost.toFixed(4)} | **$${summary.origamiTotalCost.toFixed(4)}** | **${summary.costSavingsPct}% cost saved** |
| **Prompt Cache Hit Rate** | N/A | **${summary.meanOrigamiCacheHitPct}%** | Consistent prefix reuse |

---

## Milestone Progression

| Request Index | Raw Session Tokens | Baseline Tokens | Origami Tokens | Compression Ratio | Baseline Acc | Origami Acc | Baseline Cost ($) | Origami Cost ($) | Cost Saved (%) |
|---|---|---|---|---|---|---|---|---|---|
`;

  for (const m of milestones) {
    const baseAcc = (m.probes.reduce((s, p) => s + p.baseline.score, 0) / m.probes.length) * 100;
    const origAcc = (m.probes.reduce((s, p) => s + p.origami.score, 0) / m.probes.length) * 100;
    const baseCost = m.probes.reduce((s, p) => s + p.baseline.cost, 0);
    const origCost = m.probes.reduce((s, p) => s + p.origami.cost, 0);
    const saved = baseCost > 0 ? ((baseCost - origCost) / baseCost) * 100 : 0;

    md += `| Req #${m.requestIndex} | ${m.rawCumulativeTokens.toLocaleString()} | ${m.baselineContextTokens.toLocaleString()} | ${m.origamiContextTokens.toLocaleString()} | ${m.compressionRatio.toFixed(1)}x | ${baseAcc.toFixed(0)}% | **${origAcc.toFixed(0)}%** | $${baseCost.toFixed(5)} | **$${origCost.toFixed(5)}** | **${saved.toFixed(1)}%** |\n`;
  }

  md += `\n---

## Detailed Probe Breakdowns

`;

  for (const m of milestones) {
    md += `### Milestone Request #${m.requestIndex} (${m.rawCumulativeTokens.toLocaleString()} raw tokens)\n\n`;
    for (const p of m.probes) {
      md += `#### Probe: ${p.probeName} (\`${p.probeId}\`)\n\n`;
      md += `- **Baseline Score**: ${(p.baseline.score * 100).toFixed(0)}% | Latency: ${p.baseline.latencyMs}ms | Cost: $${p.baseline.cost.toFixed(6)}\n`;
      md += `- **Origami Score**: **${(p.origami.score * 100).toFixed(0)}%** | Latency: ${p.origami.latencyMs}ms | Cost: **$${p.origami.cost.toFixed(6)}**\n`;
      md += `- **Baseline Response**: "${p.baseline.responsePreview}..."\n`;
      md += `- **Origami Response**: "${p.origami.responsePreview}..."\n\n`;
    }
  }

  return md;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  runBenchmark(opts).catch((err) => {
    console.error("Fatal benchmark error:", err);
    process.exit(1);
  });
}
