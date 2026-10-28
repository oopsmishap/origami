#!/usr/bin/env bun
/**
 * Deterministic long-session benchmark for origami.
 *
 * A seeded generator produces a marathon session (requests, tool reads, planted
 * constraints and facts, later questions about those facts). A scripted model obeys
 * origami's nudges with a mechanical, doctrine-shaped summarizer. Every request is
 * rendered through the real engine and scored against an uncompressed baseline.
 *
 *   bun run bench [--turns 400] [--seed 7] [--window 200000] [--preset balanced]
 *                 [--fact-keep 0.85] [--promotion mass|growth] [--assert] [--json out.json]
 *
 * `--promotion growth` replaces the preset's merge-mass floors with triggers tied
 * to the growth step (tier 2 at 1.5x, tier 3 at 2.25x), the billion-context rule.
 */
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset, type Preset } from "../src/config.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { expandRefRange } from "../src/kernel/render.ts";

interface Options {
  turns: number;
  seed: number;
  window: number;
  preset: Preset;
  factKeep: number;
  promotion: "mass" | "growth";
  json: string | null;
  assert: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { turns: 400, seed: 7, window: 200_000, preset: "balanced", factKeep: 0.85, promotion: "mass", json: null, assert: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--assert") {
      opts.assert = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    i++;
    if (key === "--turns") opts.turns = Number.parseInt(value, 10);
    else if (key === "--seed") opts.seed = Number.parseInt(value, 10);
    else if (key === "--window") opts.window = Number.parseInt(value, 10);
    else if (key === "--preset") opts.preset = value as Preset;
    else if (key === "--fact-keep") opts.factKeep = Number.parseFloat(value);
    else if (key === "--promotion") {
      if (value !== "mass" && value !== "growth") throw new Error(`--promotion must be mass or growth, got ${value}`);
      opts.promotion = value;
    }
    else if (key === "--json") opts.json = value;
    else throw new Error(`unknown option ${key}`);
  }
  return opts;
}

function benchConfig(options: Options) {
  const config = configFromPreset(options.preset);
  if (options.promotion === "mass") return config;
  return { ...config, tier2MassTokens: Math.round(config.growthStep * 1.5), tier3MassTokens: Math.round(config.growthStep * 2.25) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "parser lexer cache index shard replica token buffer socket queue worker lease schema route handler codec frame window ledger journal".split(" ");
const countTokens = (text: string) => Math.ceil(text.length / 4);

type Msg = { role: string; content: unknown; toolCallId?: string };
/** Session entries as the host stores them: messages plus origami journal events. */
type Entry = { type: "message"; id: string; message: Msg } | { type: "custom"; customType: string; data: unknown };

interface Planted {
  id: string;
  line: string;
  value: string;
  ref: string;
}

export interface MarathonResult {
  options: Options;
  requests: number;
  peakContextTokens: number;
  meanContextTokens: number;
  baselinePeakTokens: number;
  baselineOverflowRequests: number;
  constraintSurvival: number;
  minConstraintSurvival: number;
  factQueries: number;
  factInContext: number;
  factRestored: number;
  factLost: number;
  cacheHitPct: number;
  costVsBaseline: number;
  blocksCreated: Record<1 | 2 | 3, number>;
  activeBlocks: Record<1 | 2 | 3, number>;
  nudges: Record<"efficiency" | "emergency" | "promotion", number>;
  rejectedFolds: number;
  maxInvariantViolations: number;
}

export function runMarathon(options: Options): MarathonResult {
  const rand = mulberry32(options.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const entries: Entry[] = [];
  const constraints: Planted[] = [];
  const facts: Planted[] = [];
  const messages: Msg[] = [];
  const push = (message: Msg) => {
    entries.push({ type: "message", id: `e${entries.length + 1}`, message });
    messages.push(message);
    return `m${String(messages.length).padStart(5, "0")}`;
  };

  let rendered: unknown[] = [];
  let renderedTokens = 0;
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => `marathon-${options.seed}`,
      appendEvent: (op) => entries.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: op }),
      saveArtifact: async () => undefined,
      windowTokens: () => options.window,
      projectedTokens: () => renderedTokens,
    },
    entries,
    modelId: "bench",
    config: benchConfig(options),
    countFn: countTokens,
  });

  const textOf = (m: unknown): string => {
    const r = m as { content?: unknown };
    return typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? "");
  };
  const sync = () => {
    engine.refresh(entries);
    engine.ingest(messages.map((m) => messageFacts(m)).filter((f): f is KernelMessage => f !== null));
  };
  const render = (): string[] => {
    rendered = engine.render(
      messages,
      (text) => ({ role: "custom", content: text }),
    );
    const strings = rendered.map((m) => `${(m as { role?: string }).role}:${textOf(m)}`);
    renderedTokens = strings.reduce((s, x) => s + countTokens(x), 0);
    return strings;
  };

  // Mechanical doctrine: constraints verbatim always, facts verbatim with probability factKeep, gists otherwise.
  const keepLines = (texts: readonly string[], tier: 1 | 2 | 3): string[] => {
    const out: string[] = [];
    for (const t of texts) {
      for (const c of t.match(/CONSTRAINT C\d+: [^.]*\./g) ?? []) out.push(c);
      if (tier < 3) for (const f of t.match(/FACT F\d+: [^.]*\./g) ?? []) if (rand() < options.factKeep) out.push(f);
    }
    return [...new Set(out)];
  };
  const summarizeRefs = (refs: readonly string[]): string => {
    const texts = engine.recall(refs).map((h) => h.text ?? "");
    const gists = texts.filter((t) => t.startsWith("Turn ")).map((t) => `- ${t.slice(0, 48)}`);
    return [...keepLines(texts, 1), ...gists].join("\n");
  };

  const result: MarathonResult = {
    options,
    requests: 0,
    peakContextTokens: 0,
    meanContextTokens: 0,
    baselinePeakTokens: 0,
    baselineOverflowRequests: 0,
    constraintSurvival: 0,
    minConstraintSurvival: 1,
    factQueries: 0,
    factInContext: 0,
    factRestored: 0,
    factLost: 0,
    cacheHitPct: 0,
    costVsBaseline: 0,
    blocksCreated: { 1: 0, 2: 0, 3: 0 },
    activeBlocks: { 1: 0, 2: 0, 3: 0 },
    nudges: { efficiency: 0, emergency: 0, promotion: 0 },
    rejectedFolds: 0,
    maxInvariantViolations: 0,
  };

  let prevOrigami: string[] = [];
  let prevBaseline: string[] = [];
  let totalContext = 0;
  let cacheRead = 0;
  let cacheTotal = 0;
  let origamiCost = 0;
  let baselineCost = 0;
  // Anthropic-style relative prices: uncached write 1.25, cached read 0.1.
  const requestCost = (prev: readonly string[], cur: readonly string[]) => {
    let i = 0;
    while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
    const read = cur.slice(0, i).reduce((s, x) => s + countTokens(x), 0);
    const total = cur.reduce((s, x) => s + countTokens(x), 0);
    return { read, total, cost: read * 0.1 + (total - read) * 1.25 };
  };
  const request = (nudge: string | null) => {
    const ctx = render();
    if (nudge) ctx.push(`developer:${nudge}`);
    const o = requestCost(prevOrigami, ctx);
    prevOrigami = ctx;
    const base = messages.map((m) => `${m.role}:${textOf(m)}`);
    const b = requestCost(prevBaseline, base);
    prevBaseline = base;
    result.requests++;
    totalContext += o.total;
    cacheRead += o.read;
    cacheTotal += o.total;
    origamiCost += o.cost;
    baselineCost += b.cost;
    result.peakContextTokens = Math.max(result.peakContextTokens, o.total);
    result.baselinePeakTokens = Math.max(result.baselinePeakTokens, b.total);
    if (b.total > options.window) result.baselineOverflowRequests++;
    result.maxInvariantViolations = Math.max(result.maxInvariantViolations, engine.invariants().length);
    return ctx.join("\n");
  };

  const foldAll = (specs: { range: string; topic: string; summary: string }[], tier: 1 | 2 | 3) => {
    let pending = specs.filter((s) => s.summary.length > 0);
    while (pending.length > 0) {
      const res = engine.executeFold({ folds: pending, tier });
      if (res.ok) {
        result.blocksCreated[tier] += res.outcome.foldCount;
        return;
      }
      result.rejectedFolds++;
      pending = pending.filter((_, i) => i !== res.foldIndex);
    }
  };

  const respondToNudge = () => {
    const decision = engine.decideNudge();
    if (!decision.kind) return null;
    result.nudges[decision.kind]++;
    if (decision.kind === "promotion" && decision.promotion) {
      const fromTier = decision.promotion.fromTier;
      const blocks = engine.state.tree.live().filter((b) => b.tier === fromTier);
      const lines = keepLines(blocks.map((b) => b.summary), (fromTier + 1) as 2 | 3);
      foldAll([{ range: blocks.map((b) => b.id).join(","), topic: `merged ${blocks[0]!.id}..${blocks.at(-1)!.id}`, summary: lines.join("\n") || "- routine work" }], (fromTier + 1) as 2 | 3);
    } else {
      const specs = engine.recommendedRanges().map((r) => ({
        range: `${r.start}..${r.end}`,
        topic: `turns ${r.start}..${r.end}`,
        summary: summarizeRefs(expandRefRange(r.start, r.end)),
      }));
      foldAll(specs, 1);
    }
    return decision.text;
  };

  for (let turn = 1; turn <= options.turns; turn++) {
    const subject = `${pick(WORDS)}-${pick(WORDS)}`;
    let userText = `Turn ${turn}: work on the ${subject} module and report back.`;
    let query: Planted | null = null;
    if (turn > 20 && facts.length > 0 && rand() < 0.25) {
      query = pick(facts);
      userText += ` Also, remind me: what was ${query.id}?`;
    }
    if (turn % 7 === 3) {
      const c = { id: `C${constraints.length + 1}`, value: `${pick(WORDS)}-${Math.floor(rand() * 9000 + 1000)}`, line: "", ref: "" };
      c.line = `CONSTRAINT ${c.id}: ${subject} must use ${c.value}.`;
      userText += ` ${c.line}`;
      constraints.push(c);
    }
    const userRef = push({ role: "user", content: userText });
    for (const c of constraints) if (!c.ref) c.ref = userRef;

    engine.onTurnStart();
    sync();
    const nudge = respondToNudge();
    const context = request(nudge);
    if (nudge) {
      sync();
      request(null);
    }

    if (query) {
      result.factQueries++;
      if (context.includes(query.line)) result.factInContext++;
      else if ((engine.recall([query.ref])[0]?.text ?? "").includes(query.line)) result.factRestored++;
      else result.factLost++;
    }

    if (rand() < 0.6) {
      const id = `call-${turn}`;
      const path = `src/${subject}/${pick(WORDS)}.ts`;
      push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] });
      const lines = Array.from({ length: 40 + Math.floor(rand() * 80) }, (_, i) => `${i + 1}: const ${pick(WORDS)}_${i} = ${pick(WORDS)}(${Math.floor(rand() * 1000)});`);
      push({ role: "toolResult", toolCallId: id, content: lines.join("\n") });
    }
    let reply = `Done with ${subject}: updated the handler and verified the tests.`;
    if (turn % 5 === 1) {
      const f = { id: `F${facts.length + 1}`, value: String(Math.floor(rand() * 90000 + 10000)), line: "", ref: "" };
      f.line = `FACT ${f.id}: ${subject} limit is ${f.value}.`;
      reply += ` ${f.line}`;
      f.ref = push({ role: "assistant", content: reply });
      facts.push(f);
    } else {
      push({ role: "assistant", content: reply });
    }

    if (turn % 25 === 0 || turn === options.turns) {
      const ctx = prevOrigami.join("\n");
      const alive = constraints.filter((c) => ctx.includes(c.line)).length;
      const pct = constraints.length > 0 ? alive / constraints.length : 1;
      result.minConstraintSurvival = Math.min(result.minConstraintSurvival, pct);
      if (turn === options.turns) result.constraintSurvival = pct;
    }
  }

  result.meanContextTokens = Math.round(totalContext / Math.max(1, result.requests));
  result.cacheHitPct = cacheTotal > 0 ? cacheRead / cacheTotal : 0;
  result.costVsBaseline = baselineCost > 0 ? origamiCost / baselineCost : 0;
  for (const b of engine.state.tree.live()) result.activeBlocks[b.tier]++;
  return result;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function benchmarkFailures(result: MarathonResult): string[] {
  const failures: string[] = [];
  if (result.maxInvariantViolations !== 0) failures.push(`invariant violations: ${result.maxInvariantViolations}`);
  if (result.factLost !== 0) failures.push(`lost facts: ${result.factLost}`);
  if (result.blocksCreated[1] === 0) failures.push("no tier-1 folds were created");
  if (result.costVsBaseline > 0.7) failures.push(`input cost ${(result.costVsBaseline * 100).toFixed(1)}% exceeds 70% of baseline`);
  return failures;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const r = runMarathon(options);
  const rows: [string, string][] = [
    ["turns / requests", `${options.turns} / ${r.requests}`],
    ["peak context (origami / baseline)", `${r.peakContextTokens} / ${r.baselinePeakTokens}`],
    ["mean context", String(r.meanContextTokens)],
    ["baseline requests over window", String(r.baselineOverflowRequests)],
    ["constraint survival (final / min)", `${pct(r.constraintSurvival)} / ${pct(r.minConstraintSurvival)}`],
    ["fact queries: in context / restored / lost", `${r.factInContext} / ${r.factRestored} / ${r.factLost} of ${r.factQueries}`],
    ["cache hit", pct(r.cacheHitPct)],
    ["input cost vs uncompressed", pct(r.costVsBaseline)],
    ["blocks created t1/t2/t3", `${r.blocksCreated[1]}/${r.blocksCreated[2]}/${r.blocksCreated[3]}`],
    ["active blocks t1/t2/t3", `${r.activeBlocks[1]}/${r.activeBlocks[2]}/${r.activeBlocks[3]}`],
    ["nudges efficiency/emergency/promotion", `${r.nudges.efficiency}/${r.nudges.emergency}/${r.nudges.promotion}`],
    ["rejected folds", String(r.rejectedFolds)],
    ["max invariant violations", String(r.maxInvariantViolations)],
  ];
  console.log(`origami marathon · seed ${options.seed} · preset ${options.preset} · promotion ${options.promotion} · window ${options.window}\n`);
  console.log("| metric | value |\n|---|---|");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  if (options.json) await Bun.write(options.json, JSON.stringify(r, null, 2));
  if (options.assert) {
    const failures = benchmarkFailures(r);
    if (failures.length > 0) {
      console.error(`benchmark assertions failed: ${failures.join("; ")}`);
      process.exitCode = 1;
    }
  }
}
