/**
 * CLI Orchestrator and Live Web Dashboard for Agentic Compaction Benchmarks.
 *
 * Evaluates real-world compaction strategies:
 * - origami (Pagoda folding + Bounded Ledger + JIT Hydration)
 * - soft (Hierarchical model summarization / omp compact soft / Claude Code)
 * - handover (Structured task handoff document / omp handoff / Devin)
 * - shake (Observation elision / tool output pruning / SWE-Pruner)
 * - sliding-window (Baseline FIFO context truncation)
 *
 * Across 4 agentic modes:
 * - programming (Build a feature-rich Pac-Man game)
 * - research (Security audit with planted vulnerabilities)
 * - general (Long single session refactoring & docs)
 * - memory (Factual needle recall across long horizons)
 *
 * Usage:
 *   bun bench/agentic/runner.ts [--mode programming] [--scale low] [--strategy all] [--web]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pLimit from "p-limit";
import { z } from "zod";
import {
  AgentRunner,
  type AgenticRunResult,
  type TurnMetricRecord,
  type ChatTurnRecord
} from "./agent.ts";
import { GPT_5_6_SOL_PRICING } from "./pricing.ts";
import { generateReportHtml } from "./report-html.ts";
import { getDashboardHtml } from "./dashboard-html.ts";
import {
  SCENARIO_REGISTRY,
  SCALE_TURNS,
  type ScenarioMode,
  type ContextScale,
  type ScenarioDefinition
} from "./scenarios.ts";
import type { CompactionStrategyName } from "./strategy-runtime.ts";

export interface RunnerCliArgs {
  modes: ScenarioMode[];
  scales: ContextScale[];
  strategies: CompactionStrategyName[];
  model: string;
  pricingModel: string;
  mock: boolean;
  web: boolean;
  port: number;
  outDir: string;
  parallel: boolean;
  concurrency?: number;
  turns?: number;
  prefill?: number;
  maxTokens?: number;
  windowTokens?: number;
  compactEvery?: number;
}
export const ALL_STRATEGIES: CompactionStrategyName[] = [
  "origami",
  "soft",
  "handover",
  "shake",
  "sliding-window"
];

export const ALL_MODES: ScenarioMode[] = ["programming", "research", "general", "memory"];

export const RunnerCliArgsSchema = z.object({
  modes: z.array(z.enum(["programming", "research", "general", "memory"])).min(1),
  scales: z.array(z.enum(["low", "medium", "high", "insane", "marathon"])).min(1),
  strategies: z.array(z.enum(["origami", "soft", "handover", "shake", "sliding-window"])).min(1),
  model: z.string().min(1),
  pricingModel: z.literal(GPT_5_6_SOL_PRICING.id),
  mock: z.boolean(),
  web: z.boolean(),
  port: z.number().int().min(1).max(65535),
  outDir: z.string().min(1),
  parallel: z.boolean(),
  concurrency: z.number().int().positive().optional(),
  turns: z.number().int().positive().optional(),
  prefill: z.number().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  windowTokens: z.number().int().positive().optional(),
  compactEvery: z.number().int().positive().optional(),
});

export interface RubricDisplayResult {
  scoreStr: string;
  countStr: string;
  fullStr: string;
}

export function formatRubricDisplay(r: {
  rubricScore: number | null;
  rubricPassedCount: number;
  rubricTotalCount: number;
  rubricEvaluatedCount?: number;
  rubricUnavailableCount?: number;
  rubricErrorCount?: number;
}): RubricDisplayResult {
  const score = r.rubricScore;
  const scoreStr = score !== null && Number.isFinite(score) ? `${Math.round(score * 100)}%` : "N/A";
  const total = r.rubricTotalCount;
  const evaluated = r.rubricEvaluatedCount ?? (total - (r.rubricUnavailableCount ?? 0) - (r.rubricErrorCount ?? 0));
  const unavail = r.rubricUnavailableCount ?? 0;
  const error = r.rubricErrorCount ?? 0;

  let countStr = `${r.rubricPassedCount}/${total}`;
  if (r.rubricEvaluatedCount !== undefined && r.rubricEvaluatedCount !== total) {
    countStr = `${r.rubricPassedCount}/${evaluated} eval (${total} tot)`;
  }
  const statusParts: string[] = [];
  if (unavail > 0) statusParts.push(`${unavail} unavail`);
  if (error > 0) statusParts.push(`${error} err`);
  if (statusParts.length > 0) {
    countStr += ` [${statusParts.join(", ")}]`;
  }

  return {
    scoreStr,
    countStr,
    fullStr: `${scoreStr} (${countStr})`
  };
}

function getRubricCounts(r: unknown): {
  evaluated?: number;
  unavailable?: number;
  error?: number;
} {
  if (!r || typeof r !== "object") return {};
  const evaluated =
    "rubricEvaluatedCount" in r && typeof r.rubricEvaluatedCount === "number"
      ? r.rubricEvaluatedCount
      : undefined;
  const unavailable =
    "rubricUnavailableCount" in r && typeof r.rubricUnavailableCount === "number"
      ? r.rubricUnavailableCount
      : undefined;
  const error =
    "rubricErrorCount" in r && typeof r.rubricErrorCount === "number"
      ? r.rubricErrorCount
      : undefined;
  return { evaluated, unavailable, error };
}

function parsePositiveInt(val: string, flagName: string): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(
      `Invalid value for ${flagName}: "${val}". Must be a positive integer >= 1.`
    );
  }
  return n;
}

function parsePort(val: string): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError(
      `Invalid port: "${val}". Must be an integer between 1 and 65535.`
    );
  }
  return n;
}

function parsePrefill(val: string): number {
  const raw = String(val).trim().toLowerCase();
  if (!raw) {
    throw new InvalidArgumentError(
      `Invalid prefill: "${val}". Value cannot be empty.`
    );
  }
  let num: number;
  if (raw.endsWith("k")) {
    const parsed = Number(raw.slice(0, -1));
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new InvalidArgumentError(
        `Invalid prefill: "${val}". Must be a non-negative number (e.g. 50k, 1m, 10000).`
      );
    }
    num = parsed * 1000;
  } else if (raw.endsWith("m")) {
    const parsed = Number(raw.slice(0, -1));
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new InvalidArgumentError(
        `Invalid prefill: "${val}". Must be a non-negative number (e.g. 50k, 1m, 10000).`
      );
    }
    num = parsed * 1_000_000;
  } else {
    num = Number(raw);
  }
  if (!Number.isFinite(num) || num < 0) {
    throw new InvalidArgumentError(
      `Invalid prefill: "${val}". Must be a non-negative number (e.g. 50k, 1m, 10000).`
    );
  }
  return num;
}

export function createCliCommand(): Command {
  const program = new Command();
  program
    .name("bun bench/agentic/runner.ts")
    .description("Origami Agentic Context Benchmark Runner")
    .usage("[options]")
    .exitOverride()
    .allowUnknownOption(false)
    .option("-m, --mode <mode>", "Scenario mode: programming | research | general | memory | all")
    .option("-s, --scale <scale>", "Context intensity scale: low (20) | medium (60) | high (150) | insane (300) | marathon (1500)")
    .option("--strategy <strat>", "Compaction strategy: origami | soft | handover | shake | sliding-window | all")
    .option("-p, --parallel", "Execute benchmark runs concurrently in parallel", false)
    .option("-c, --concurrency <n>", "Max concurrent runs when running in parallel (default: all active runs)", (val) => parsePositiveInt(val, "--concurrency"))
    .option("-t, --turns <n>", "Override turn count for the benchmark run", (val) => parsePositiveInt(val, "--turns"))
    .option("--prefill <n>", "Initial repository codebase size: 50k | 100k | 150k | 200k (seeds Turn 1 context)", parsePrefill)
    .option("-M, --max-tokens <n>", "Max completion output tokens per request (default: unlimited for gemma4/lfm3, 4096 otherwise)", (val) => parsePositiveInt(val, "--max-tokens"))
    .option("--compact-every <n>", "Force strategy compaction every N turns (e.g. 10), in addition to the 80% threshold", (val) => parsePositiveInt(val, "--compact-every"))
    .option("--window <n>", "Effective context window in tokens (default: 131072 for gemma4, 220000 for lfm3, 1000000 otherwise)", (val) => parsePositiveInt(val, "--window"))
    .option("--model <model>", "Target model identifier or alias", "gemma4:latest")
    .option("--pricing-model <name>", "Modeled billing profile (default: gpt-5.6-sol)", GPT_5_6_SOL_PRICING.id)
    .option("--mock", "Run in mock model mode without actual LLM calls", false)
    .option("--web", "Launch live streaming dashboard (default port 4143)", false)
    .option("--port <number>", "Web dashboard port (default: 4143)", parsePort, 4143)
    .option("--out <dir>", "Directory to store benchmark JSON and Markdown reports (default: bench/results)", "bench/results");

  return program;
}

function isNodeProcessArgv(argv: string[]): boolean {
  if (argv === process.argv) return true;
  if (argv.length < 2) return false;
  const [exec, script] = argv;
  if (!exec || !script || exec.startsWith("-") || script.startsWith("-")) return false;
  const isRuntime = /(?:node|bun|tsx|ts-node)(?:\.exe)?$/i.test(exec) || exec === "bun" || exec === "node";
  const isScript = /(?:runner\.[cm]?[jt]s)$/i.test(script) || script.includes("runner");
  return isRuntime || isScript;
}

export function parseCliArgs(argv: string[]): RunnerCliArgs {
  const program = createCliCommand();
  const from = isNodeProcessArgv(argv) ? "node" : "user";
  program.parse(argv, { from });

  const opts = program.opts();

  // Mode parsing
  let modes: ScenarioMode[] = [];
  if (opts.mode !== undefined) {
    const rawModes = String(opts.mode).split(",").map((s) => s.trim().toLowerCase());
    for (const m of rawModes) {
      if (m === "all") {
        modes = [...ALL_MODES];
        break;
      }
      if (ALL_MODES.includes(m as ScenarioMode)) {
        modes.push(m as ScenarioMode);
      } else {
        throw new Error(`Unknown mode: ${m}. Available: ${ALL_MODES.join(", ")}, all`);
      }
    }
  }
  if (modes.length === 0) modes = ["programming"];

  // Scale parsing
  let scales: ContextScale[] = [];
  if (opts.scale !== undefined) {
    const parts = String(opts.scale).split(",").map((s) => s.trim().toLowerCase());
    for (const p of parts) {
      if (p in SCALE_TURNS) {
        scales.push(p as ContextScale);
      } else {
        throw new Error(`Unknown scale: ${p}. Available: low (20), medium (60), high (150), insane (300), marathon (1500)`);
      }
    }
  }
  if (scales.length === 0) scales = ["low"];

  // Strategy parsing
  let strategies: CompactionStrategyName[] = [];
  if (opts.strategy !== undefined) {
    const parts = String(opts.strategy).split(",").map((s) => s.trim().toLowerCase());
    for (const st of parts) {
      if (st === "all") {
        strategies = [...ALL_STRATEGIES];
        break;
      }
      if (ALL_STRATEGIES.includes(st as CompactionStrategyName)) {
        strategies.push(st as CompactionStrategyName);
      } else {
        throw new Error(`Unknown strategy: ${st}. Available: ${ALL_STRATEGIES.join(", ")}, all`);
      }
    }
  }
  if (strategies.length === 0) strategies = [...ALL_STRATEGIES];

  // Model aliases
  let model = String(opts.model);
  if (model === "lfm3" || model === "ollama/lfm3" || model === "lfm3:latest") {
    model = "lfm3:256k";
  }

  // Pricing model check
  const pricingModel = String(opts.pricingModel);
  if (pricingModel !== GPT_5_6_SOL_PRICING.id) {
    throw new Error(`Unsupported pricing model: ${pricingModel}. Available: ${GPT_5_6_SOL_PRICING.id}`);
  }

  // Concurrency implies parallel
  let parallel = Boolean(opts.parallel);
  let concurrency = opts.concurrency !== undefined ? Number(opts.concurrency) : undefined;
  if (concurrency !== undefined) {
    parallel = true;
  }

  const rawArgs = {
    modes,
    scales,
    strategies,
    model,
    pricingModel,
    mock: Boolean(opts.mock),
    web: Boolean(opts.web),
    port: Number(opts.port),
    outDir: String(opts.out),
    parallel,
    concurrency,
    turns: opts.turns !== undefined ? Number(opts.turns) : undefined,
    prefill: opts.prefill !== undefined ? Number(opts.prefill) : undefined,
    maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
    windowTokens: opts.window !== undefined ? Number(opts.window) : undefined,
    compactEvery: opts.compactEvery !== undefined ? Number(opts.compactEvery) : undefined,
  };

  return RunnerCliArgsSchema.parse(rawArgs);
}

export function printHelp(): void {
  console.log(`
Origami Agentic Context Benchmark Runner

Usage:
  bun bench/agentic/runner.ts [options]

Options:
  --mode, -m <mode>        Scenario mode: programming | research | general | memory | all (default: programming)
  --scale, -s <scale>      Context intensity scale: low (20) | medium (60) | high (150) | insane (300) | marathon (1500) (default: low)
  --strategy <strat>       Compaction strategy: origami | soft | handover | shake | sliding-window | all (default: all)
  --parallel, -p           Execute benchmark runs concurrently in parallel
  --concurrency, -c <n>    Max concurrent runs when running in parallel (default: all active runs)
  --turns, -t <n>          Override turn count for the benchmark run
  --prefill <n>            Initial repository codebase size: 50k | 100k | 150k | 200k (seeds Turn 1 context)
  --max-tokens, -M <n>     Max completion output tokens per request (default: unlimited for gemma4/lfm3, 4096 otherwise)
  --compact-every <n>      Force strategy compaction every N turns (e.g. 10), in addition to the 80% threshold
  --window <n>             Effective context window in tokens (default: 131072 for gemma4, 220000 for lfm3, 1000000 otherwise)
  --pricing-model <name>   Modeled billing profile (default: gpt-5.6-sol)
  --web                    Launch live streaming dashboard (default port 4143)
  --port <number>          Web dashboard port (default: 4143)
  --out <dir>              Directory to store benchmark JSON and Markdown reports (default: bench/results)
  --help, -h               Show this help message
`);
}

// ============================================================================
// Web Dashboard Server & SSE
// ============================================================================

interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export interface TrackState {
  runId: string;
  mode: string;
  strategy: string;
  scale: string;
  turn: number;
  totalTurns: number;
  contextTokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheHit: number;
  latencyMs: number;
  lastAction: string;
  currentPrompt: string;
  status: "initializing" | "thinking" | "tool" | "running" | "completed" | "error";
  startedAt: number;
  probesPassed: number;
  probesTotal: number;
  maintenanceCount: number;
}

export interface SeriesPoint {
  runId: string;
  turn: number;
  contextTokens: number;
  promptTokens: number;
  cacheHit: number;
  isProbe: boolean;
  probePassed?: boolean;
  maintenance?: string;
}

export interface FeedEvent {
  ts: number;
  kind: "info" | "probe-pass" | "probe-fail" | "maintenance" | "tool" | "start" | "complete" | "error";
  mode: string;
  strategy: string;
  text: string;
}

export class DashboardBroadcaster {
  private clients = new Map<string, SseClient>();
  private lastState: Record<string, unknown> = {
    status: "idle",
    runs: []
  };
  readonly tracks = new Map<string, TrackState>();
  readonly series: SeriesPoint[] = [];
  readonly feed: FeedEvent[] = [];
  readonly completedResults: AgenticRunResult[] = [];
  readonly chatTranscripts = new Map<string, ChatTurnRecord[]>();

  pushChatTurn(runId: string, mode: ScenarioMode, strategy: CompactionStrategyName, scale: ContextScale, turn: ChatTurnRecord): void {
    const trackKey = `${mode}:${strategy}`;
    if (!this.chatTranscripts.has(trackKey)) this.chatTranscripts.set(trackKey, []);
    const list1 = this.chatTranscripts.get(trackKey)!;
    list1.push(turn);
    if (list1.length > 500) list1.splice(0, list1.length - 500);


    this.broadcast("chat_turn", {
      runId,
      trackKey,
      mode,
      strategy,
      scale,
      turn
    });
  }

  getChatTranscript(key: string): ChatTurnRecord[] {
    const direct = this.chatTranscripts.get(key);
    if (direct) return direct;

    for (const track of this.tracks.values()) {
      if (track.runId === key) {
        return this.chatTranscripts.get(`${track.mode}:${track.strategy}`) || [];
      }
    }
    for (const result of this.completedResults) {
      if (`${result.mode}-${result.strategy}-${result.scale}` === key) {
        return this.chatTranscripts.get(`${result.mode}:${result.strategy}`) || [];
      }
    }
    return [];
  }

  getChatTracks(): Array<{ trackKey: string; runId: string; mode: string; strategy: string; scale: string; turnCount: number }> {
    const out: Array<{ trackKey: string; runId: string; mode: string; strategy: string; scale: string; turnCount: number }> = [];
    const seen = new Set<string>();
    for (const track of this.tracks.values()) {
      const trackKey = `${track.mode}:${track.strategy}`;
      seen.add(trackKey);
      const turns = this.chatTranscripts.get(trackKey) || [];
      out.push({
        trackKey,
        runId: track.runId,
        mode: track.mode,
        strategy: track.strategy,
        scale: track.scale,
        turnCount: turns.length
      });
    }
    for (const r of this.completedResults) {
      const trackKey = `${r.mode}:${r.strategy}`;
      if (!seen.has(trackKey)) {
        seen.add(trackKey);
        const turns = this.chatTranscripts.get(trackKey) || [];
        out.push({
          trackKey,
          runId: `${r.mode}-${r.strategy}-${r.scale}`,
          mode: r.mode,
          strategy: r.strategy,
          scale: r.scale,
          turnCount: turns.length
        });
      }
    }
    for (const [key, turns] of this.chatTranscripts.entries()) {
      if (!seen.has(key)) {
        seen.add(key);
        const parts = key.split(":");
        const mode = (parts[0] || "programming") as ScenarioMode;
        const strategy = (parts[1] || "origami") as CompactionStrategyName;
        out.push({
          trackKey: key,
          runId: key,
          mode,
          strategy,
          scale: "low",
          turnCount: turns.length
        });
      }
    }
    return out;
  }
  addClient(controller: ReadableStreamDefaultController<Uint8Array>): string {
    const id = Math.random().toString(36).slice(2);
    this.clients.set(id, { id, controller });
    // Hydrate a full snapshot so late-joining clients see complete history.
    this.send(id, "init", {
      ...this.lastState,
      tracks: Array.from(this.tracks.values()),
      series: this.series.slice(-4000),
      feed: this.feed.slice(-200),
      completed: this.completedResults.map((r) => {
        const counts = getRubricCounts(r);
        return {
          mode: r.mode,
          scale: r.scale,
          strategy: r.strategy,
          rubricScore: r.rubricScore,
          rubricPassedCount: r.rubricPassedCount,
          rubricTotalCount: r.rubricTotalCount,
          rubricEvaluatedCount: counts.evaluated,
          rubricUnavailableCount: counts.unavailable,
          rubricErrorCount: counts.error,
          probeScore: r.probeScore,
          probePassedCount: r.probePassedCount,
          probeTotalCount: r.probeTotalCount,
          tokens: r.tokens,
          wallClockMs: r.wallClockMs
        };
      }),
      chatTracks: this.getChatTracks()
    });
    return id;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(event: string, data: Record<string, unknown>): void {
    const enc = new TextEncoder();
    const payload = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const [id, client] of this.clients.entries()) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  pushFeed(ev: FeedEvent): void {
    this.feed.push(ev);
    if (this.feed.length > 500) this.feed.splice(0, this.feed.length - 500);
    this.broadcast("feed", { ...ev });
  }

  updateState(patch: Record<string, unknown>): void {
    this.lastState = { ...this.lastState, ...patch };
    this.broadcast("state_update", patch);
  }

  private send(id: string, event: string, data: Record<string, unknown>): void {
    const client = this.clients.get(id);
    if (!client) return;
    try {
      const enc = new TextEncoder();
      client.controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      this.clients.delete(id);
    }
  }
}

function startWebDashboard(port: number, broadcaster: DashboardBroadcaster): void {
  Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        let html: string;
        try {
          const mod = await import(`./dashboard-html.ts?t=${Date.now()}`);
          html = mod.getDashboardHtml(port);
        } catch {
          html = getDashboardHtml(port);
        }
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      if (url.pathname === "/api/events") {
        let clientId = "";
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            clientId = broadcaster.addClient(controller);
          },
          cancel() {
            if (clientId) broadcaster.removeClient(clientId);
          }
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        });
      }

      if (url.pathname === "/api/chat") {
        const track = url.searchParams.get("track") || url.searchParams.get("runId");
        const mode = url.searchParams.get("mode");
        const strategy = url.searchParams.get("strategy");
        const key = track || (mode && strategy ? `${mode}:${strategy}` : "");
        const turns = key ? broadcaster.getChatTranscript(key) : [];
        return new Response(JSON.stringify({ ok: true, track: key, count: turns.length, turns }), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      if (url.pathname === "/api/chat/tracks") {
        return new Response(JSON.stringify({ ok: true, tracks: broadcaster.getChatTracks() }), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });
    }
  });
  console.log(`\x1b[36m[Dashboard]\x1b[0m Live benchmark web server running at \x1b[1mhttp://localhost:${port}\x1b[0m`);
}

// ============================================================================
// Main Orchestration Loop
// ============================================================================
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limiter = pLimit(Math.max(1, Math.floor(limit)));
  return Promise.all(items.map((item, idx) => limiter(() => fn(item, idx))));
}

interface RunPlan {
  index: number;
  totalRuns: number;
  scale: ContextScale;
  mode: ScenarioMode;
  strategy: CompactionStrategyName;
  scenario: ScenarioDefinition;
  totalTurns: number;
  runId: string;
  banner: string;
}
export async function runBenchmark(cliArgs: RunnerCliArgs): Promise<AgenticRunResult[]> {
  const broadcaster = new DashboardBroadcaster();

  if (cliArgs.web) {
    startWebDashboard(cliArgs.port, broadcaster);
  }

  const results: AgenticRunResult[] = [];
  const totalRuns = cliArgs.scales.length * cliArgs.modes.length * cliArgs.strategies.length;
  let runIndex = 0;

  console.log(`\n\x1b[1m\x1b[35m=== Origami Agentic Context Benchmark ===\x1b[0m`);
  console.log(`Model:      \x1b[36m${cliArgs.model}\x1b[0m`);
  console.log(`Scales:     \x1b[33m${cliArgs.scales.map(s => `${s} (${SCALE_TURNS[s]}t)`).join(", ")}\x1b[0m`);
  console.log(`Modes:      ${cliArgs.modes.join(", ")}`);
  console.log(`Strategies: ${cliArgs.strategies.join(", ")}`);
  console.log(`Total Runs: ${totalRuns} run(s) ${cliArgs.mock ? "(\x1b[32mMock Mode\x1b[0m)" : ""}\n`);

  broadcaster.updateState({
    status: "running",
    model: cliArgs.model,
    scales: cliArgs.scales,
    totalRuns
  });

  const runPlans: RunPlan[] = [];
  let planIndex = 0;

  for (const scale of cliArgs.scales) {
    for (const mode of cliArgs.modes) {
      const scenario: ScenarioDefinition = SCENARIO_REGISTRY[mode];
      for (const strategy of cliArgs.strategies) {
        planIndex++;
        const totalTurns = cliArgs.turns ?? SCALE_TURNS[scale];
        const runId = `${mode}-${strategy}-${scale}`;
        const banner = `[${planIndex}/${totalRuns}] Scale: ${scale.toUpperCase()} (${totalTurns}t) · Mode: ${mode.toUpperCase()} · Strategy: ${strategy.toUpperCase()}`;
        runPlans.push({
          index: planIndex,
          totalRuns,
          scale,
          mode,
          strategy,
          scenario,
          totalTurns,
          runId,
          banner
        });
      }
    }
  }

  async function executePlan(plan: RunPlan): Promise<AgenticRunResult> {
    if (!cliArgs.parallel) {
      console.log(`\x1b[1m\x1b[34m------------------------------------------------------------\x1b[0m`);
      console.log(`\x1b[1m\x1b[34m${plan.banner}\x1b[0m`);
      console.log(`\x1b[1m\x1b[34m------------------------------------------------------------\x1b[0m`);
    }

    broadcaster.updateState({
      currentRun: {
        index: plan.index,
        scale: plan.scale,
        mode: plan.mode,
        strategy: plan.strategy,
        totalTurns: plan.totalTurns
      }
    });
    broadcaster.broadcast("run_start", {
      runId: plan.runId,
      scale: plan.scale,
      mode: plan.mode,
      strategy: plan.strategy,
      totalTurns: plan.totalTurns
    });

    const track: TrackState = {
      runId: plan.runId,
      mode: plan.mode,
      strategy: plan.strategy,
      scale: plan.scale,
      turn: 0,
      totalTurns: plan.totalTurns,
      contextTokens: 0,
      promptTokens: 0,
      cachedTokens: 0,
      cacheHit: 0,
      latencyMs: 0,
      lastAction: "Initializing sandbox environment...",
      currentPrompt: "",
      status: "initializing",
      startedAt: Date.now(),
      probesPassed: 0,
      probesTotal: 0,
      maintenanceCount: 0
    };
    broadcaster.tracks.set(plan.runId, track);
    broadcaster.pushFeed({
      ts: Date.now(),
      kind: "start",
      mode: plan.mode,
      strategy: plan.strategy,
      text: `Track initialized: ${plan.scale.toUpperCase()} (${plan.totalTurns} turns)`
    });

    const modelName = cliArgs.model.replace(/^ollama\//i, "");
    const isLfm3 = /^lfm3(?::|$)/i.test(modelName);
    const isGemma4 = /^gemma4(?::|$)/i.test(modelName);
    const defaultWindowTokens = isGemma4 ? 131_072 : isLfm3 ? 220_000 : 1_000_000;
    const defaultMaxOutputTokens = isGemma4 || isLfm3 ? 8_192 : 4_096;
    const runResult = await AgentRunner.run({
      scenario: plan.scenario,
      scale: plan.scale,
      strategy: plan.strategy,
      model: cliArgs.model,
      windowTokens: cliArgs.windowTokens ?? defaultWindowTokens,
      pricingModel: cliArgs.pricingModel,
      mock: cliArgs.mock,
      cleanupWorkspace: true,
      maxOutputTokens: cliArgs.maxTokens ?? defaultMaxOutputTokens,
      prefillTokens: cliArgs.prefill ?? 0,
      maxTurns: plan.totalTurns,
      compactEvery: cliArgs.compactEvery,
      onTurnStart: (turn, total) => {
        if (!cliArgs.parallel) {
          const probeTag = turn.isProbe ? " \x1b[35m[Probe Needle]\x1b[0m" : "";
          process.stdout.write(
            `\r  Turn \x1b[1m${turn.turnIndex}/${total}\x1b[0m${probeTag} ... `
          );
        }
        track.status = "thinking";
        track.turn = turn.turnIndex;
        track.currentPrompt = turn.userMessage.replace(/\s+/g, " ").slice(0, 220);
        track.lastAction = turn.isProbe ? "Needle probe: recalling fact..." : "Awaiting model response...";
        broadcaster.broadcast("turn_start", {
          runId: plan.runId,
          mode: plan.mode,
          strategy: plan.strategy,
          turn: turn.turnIndex,
          totalTurns: total,
          isProbe: turn.isProbe,
          promptSnippet: track.currentPrompt
        });
      },
      onToolCall: (turnIdx, call) => {
        track.status = "tool";
        track.lastAction = `Tool: ${call.name} · ${call.output.replace(/\s+/g, " ").slice(0, 90)}`;
        broadcaster.broadcast("tool_call", {
          runId: plan.runId,
          scale: plan.scale,
          strategy: plan.strategy,
          mode: plan.mode,
          turn: turnIdx,
          tool: call.name,
          outputSnippet: call.output.slice(0, 160)
        });
        broadcaster.pushFeed({
          ts: Date.now(),
          kind: "tool",
          mode: plan.mode,
          strategy: plan.strategy,
          text: `Turn ${turnIdx}: ${call.name} → ${call.output.replace(/\s+/g, " ").slice(0, 120)}`
        });
      },
      onTurnEnd: (metric: TurnMetricRecord) => {
        const cacheHit = Math.round(metric.cacheHitRate * 100);
        const probeStatus = metric.isProbe
          ? metric.probeOutcome?.passed
            ? " \x1b[32m[Probe: Pass ✓]\x1b[0m"
            : " \x1b[31m[Probe: Fail ✗]\x1b[0m"
          : "";
        const maint = metric.maintenanceNote ? ` \x1b[36m(${metric.maintenanceNote})\x1b[0m` : "";
        const promptTag = metric.turnIndex === 1
          ? `${metric.promptTokens.toLocaleString()}t`
          : `+${metric.promptTokens.toLocaleString()}t`;

        if (cliArgs.parallel) {
          console.log(
            `  \x1b[1m\x1b[36m[${plan.mode.toUpperCase()}:${plan.strategy.toUpperCase()}]\x1b[0m ` +
              `Turn \x1b[1m${metric.turnIndex}/${plan.totalTurns}\x1b[0m: ` +
              `ctx: \x1b[33m${metric.contextTokens.toLocaleString()}t\x1b[0m · ` +
              `prompt: ${promptTag} · ` +
              `cache: \x1b[32m${cacheHit}%\x1b[0m · ` +
              `tools: ${metric.toolCallsCount}` +
              probeStatus +
              maint
          );
        } else {
          console.log(
            `\r  Turn \x1b[1m${metric.turnIndex}\x1b[0m: ` +
              `ctx: \x1b[33m${metric.contextTokens.toLocaleString()}t\x1b[0m · ` +
              `prompt: ${promptTag} · ` +
              `cache: \x1b[32m${cacheHit}%\x1b[0m · ` +
              `tools: ${metric.toolCallsCount}` +
              probeStatus +
              maint
          );
        }

        track.status = "running";
        track.turn = metric.turnIndex;
        track.contextTokens = metric.contextTokens;
        track.promptTokens = metric.promptTokens;
        track.cachedTokens = metric.cachedTokens;
        track.cacheHit = cacheHit;
        track.latencyMs = metric.latencyMs;
        if (metric.isProbe) {
          track.probesTotal++;
          if (metric.probeOutcome?.passed) track.probesPassed++;
          track.lastAction = metric.probeOutcome?.passed ? "Needle probe: Pass ✓" : "Needle probe: Fail ✗";
        } else if (metric.maintenanceNote) {
          track.lastAction = metric.maintenanceNote;
        } else {
          track.lastAction = (metric.toolCallsCount && metric.toolCallsCount > 0) ? `${metric.toolCallsCount} tool calls executed` : "Completed turn response";
        }
        if (metric.maintenanceNote) track.maintenanceCount++;

        broadcaster.series.push({
          runId: plan.runId,
          turn: metric.turnIndex,
          contextTokens: metric.contextTokens,
          promptTokens: metric.promptTokens,
          cacheHit,
          isProbe: metric.isProbe,
          probePassed: metric.probeOutcome?.passed,
          maintenance: metric.maintenanceNote
        });
        if (broadcaster.series.length > 12000) {
          broadcaster.series.splice(0, broadcaster.series.length - 12000);
        }

        broadcaster.broadcast("turn_done", {
          runId: plan.runId,
          scale: plan.scale,
          strategy: plan.strategy,
          mode: plan.mode,
          totalTurns: plan.totalTurns,
          metric
        });
      },
      onChatTurn: (chatTurn: ChatTurnRecord) => {
        broadcaster.pushChatTurn(plan.runId, plan.mode, plan.strategy, plan.scale, chatTurn);
      },
      onMaintenance: (note: string) => {
        broadcaster.broadcast("maintenance", {
          runId: plan.runId,
          scale: plan.scale,
          strategy: plan.strategy,
          mode: plan.mode,
          note
        });
        broadcaster.pushFeed({
          ts: Date.now(),
          kind: "maintenance",
          mode: plan.mode,
          strategy: plan.strategy,
          text: `Compaction event: ${note}`
        });
      }
    });

    const rubric = formatRubricDisplay(runResult);
    const probePct = Math.round(runResult.probeScore * 100);
    const cacheHitPct = Math.round(runResult.tokens.cacheHitPct);
    const prefix = cliArgs.parallel ? `\x1b[1m\x1b[32m[FINISHED: ${plan.mode.toUpperCase()}:${plan.strategy.toUpperCase()}]\x1b[0m ` : "  \x1b[1mResult:\x1b[0m ";

    console.log(`\n${prefix}Task Rubric: \x1b[1m${rubric.scoreStr}\x1b[0m (${rubric.countStr}) · ` +
      `Probe Recall: \x1b[1m${probePct}%\x1b[0m (${runResult.probePassedCount}/${runResult.probeTotalCount}) · ` +
      `Billed: \x1b[33m${runResult.tokens.billedTokens.toLocaleString()}t\x1b[0m · ` +
      `Cache Hit: \x1b[32m${cacheHitPct}%\x1b[0m\n`);
    const trackKey = `${plan.mode}:${plan.strategy}`;
    if (runResult.chatTranscript?.length) {
      broadcaster.chatTranscripts.set(trackKey, runResult.chatTranscript);
    }

    broadcaster.completedResults.push(runResult);
    track.lastAction = `Finished — Rubric ${rubric.scoreStr} · Probe ${probePct}%`;
    broadcaster.pushFeed({
      ts: Date.now(),
      kind: "complete",
      mode: plan.mode,
      strategy: plan.strategy,
      text: `Completed scenario! Rubric: ${rubric.fullStr} · Probe: ${probePct}% · Billed: ${runResult.tokens.billedTokens.toLocaleString()}t`
    });
    broadcaster.broadcast("run_complete", {
      runId: plan.runId,
      runResult
    });

    return runResult;
  }

  if (cliArgs.parallel) {
    const concurrency = cliArgs.concurrency ?? runPlans.length;
    console.log(`\x1b[36m[Parallel Orchestrator]\x1b[0m Launching ${runPlans.length} benchmark run(s) concurrently in parallel (concurrency: ${concurrency})...\n`);
    const runResults = await mapConcurrent(runPlans, concurrency, (plan) => executePlan(plan));
    results.push(...runResults);
  } else {
    for (const plan of runPlans) {
      const res = await executePlan(plan);
      results.push(res);
    }
  }

  broadcaster.updateState({
    status: "completed",
    results
  });

  // Display summary table
  printComparisonTable(results);

  // Save report files
  saveBenchmarkArtifacts(results, cliArgs);

  return results;
}

// ============================================================================
// Reporting & Formatting
// ============================================================================

function printComparisonTable(results: AgenticRunResult[]): void {
  console.log(`\n\x1b[1m\x1b[36m========================================================================================\x1b[0m`);
  console.log(`\x1b[1m\x1b[36mAGENTIC COMPACTION BENCHMARK SUMMARY\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m========================================================================================\x1b[0m\n`);

  console.log(`Modeled billing profile: ${results[0]?.pricingModel ?? GPT_5_6_SOL_PRICING.id} (not an Ollama invoice)`);
  console.log(
    `| Strategy       | Mode        | Scale   | Task (Rubric)                   | Probe Recall | Billed Tokens | Peak Ctx  | Cache Hit % | Cache Write | Cost    |`
  );
  console.log(
    `|----------------|-------------|---------|---------------------------------|--------------|---------------|-----------|-------------|-------------|---------|`
  );
  for (const r of results) {
    const strat = r.strategy.padEnd(14);
    const mode = r.mode.padEnd(11);
    const scale = r.scale.padEnd(7);
    const rubric = formatRubricDisplay(r).fullStr.padEnd(31);
    const probe = `${Math.round(r.probeScore * 100)}% (${r.probePassedCount}/${r.probeTotalCount})`.padEnd(12);
    const billed = r.tokens.billedTokens.toLocaleString().padEnd(13);
    const peak = r.tokens.peakContextTokens.toLocaleString().padEnd(9);
    const hit = `${Math.round(r.tokens.cacheHitPct)}%`.padEnd(11);
    const cacheWrite = r.tokens.totalCacheWrite.toLocaleString().padEnd(11);
    const cost = `$${r.cost.toFixed(4)}`.padEnd(7);

    console.log(`| ${strat} | ${mode} | ${scale} | ${rubric} | ${probe} | ${billed} | ${peak} | ${hit} | ${cacheWrite} | ${cost} |`);
  }
  console.log();
}

function saveBenchmarkArtifacts(results: AgenticRunResult[], cliArgs: RunnerCliArgs): void {
  mkdirSync(cliArgs.outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scaleTag = cliArgs.scales.join("-");
  const jsonPath = join(cliArgs.outDir, `agentic-${scaleTag}-${timestamp}.json`);
  const mdPath = join(cliArgs.outDir, `agentic-${scaleTag}-${timestamp}.md`);
  const htmlPath = join(cliArgs.outDir, `agentic-${scaleTag}-${timestamp}.html`);

  // Write JSON
  writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");

  // Write Markdown
  const mdLines: string[] = [
    `# Agentic Compaction Benchmark Report`,
    ``,
    `- **Model:** \`${cliArgs.model}\``,
    `- **Pricing model:** \`${cliArgs.pricingModel}\` (modeled GPT-5.6 Sol rates; not an Ollama invoice)`,
    `- **Scales:** ${cliArgs.scales.map((s) => `\`${s}\` (${SCALE_TURNS[s]}t)`).join(", ")}`,
    `- **Timestamp:** \`${new Date().toISOString()}\``,
    `- **Execution Mode:** ${cliArgs.mock ? "Mock Simulation" : "Live LLM Execution"}`,
    ``,
    `## Summary Comparison Matrix`,
    ``,
    `| Strategy | Mode | Scale | Task Rubric | Probe Recall | Billed Tokens | Peak Context | Final Context | Cache Hit Rate | Cache Write Tokens | Compactions | Modeled Cost | Time (s) |`,
    `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`
  ];

  for (const r of results) {
    const rubricDisplay = formatRubricDisplay(r).fullStr;
    const probePct = `${Math.round(r.probeScore * 100)}% (${r.probePassedCount}/${r.probeTotalCount})`;
    const billed = r.tokens.billedTokens.toLocaleString();
    const peak = r.tokens.peakContextTokens.toLocaleString();
    const finalCtx = r.tokens.finalContextTokens.toLocaleString();
    const hitRate = `${Math.round(r.tokens.cacheHitPct)}%`;
    const cacheWrite = r.tokens.totalCacheWrite.toLocaleString();
    const compactions = (r.strategyTelemetry?.compactionEvents ?? 0).toLocaleString();
    const modeledCost = `$${r.cost.toFixed(4)}`;
    const sec = (r.wallClockMs / 1000).toFixed(1);

    mdLines.push(
      `| **${r.strategy}** | \`${r.mode}\` | \`${r.scale}\` | ${rubricDisplay} | ${probePct} | ${billed} | ${peak} | ${finalCtx} | ${hitRate} | ${cacheWrite} | ${compactions} | ${modeledCost} | ${sec}s |`
    );
  }

  mdLines.push(``, `## Measured Strategy Observations`, ``);
  for (const r of results) {
    const compactions = r.strategyTelemetry?.compactionEvents ?? 0;
    const reclaimed = r.strategyTelemetry?.tokensReclaimed;
    const reclaimedStr = typeof reclaimed === "number" ? `${reclaimed.toLocaleString()}t reclaimed` : "n/a";
    const details = r.strategyTelemetry?.details ?? {};
    const hydrations = typeof details.hydrationCount === "number"
      ? details.hydrationCount
      : (details.hydrationInjected ? 1 : 0);
    const blocks = r.strategyTelemetry?.activeBlocks;
    const blockNote = blocks ? ` · active blocks T1:${blocks.t1}/T2:${blocks.t2}/T3:${blocks.t3}` : "";
    const hydrationNote = r.strategy === "origami"
      ? (hydrations > 0 ? ` · ${hydrations} JIT hydration notice(s)` : ` · recall served via pinned ledger / archive without tail hydration`)
      : "";
    mdLines.push(
      `- **${r.strategy}** (\`${r.mode}\` / \`${r.scale}\`): Probe recall **${Math.round(r.probeScore * 100)}%** (${r.probePassedCount}/${r.probeTotalCount}), ` +
        `compactions: **${compactions}** (${reclaimedStr}${blockNote}${hydrationNote}), ` +
        `cache hit: **${Math.round(r.tokens.cacheHitPct)}%** (${r.tokens.totalCacheWrite.toLocaleString()}t cache write), ` +
        `final rendered context: **${r.tokens.finalContextTokens.toLocaleString()}t** (peak ${r.tokens.peakContextTokens.toLocaleString()}t), ` +
        `modeled cost: **$${r.cost.toFixed(4)}**.`
    );
  }

  writeFileSync(mdPath, mdLines.join("\n"), "utf8");

  // Write self-contained HTML report
  const totalWallClockMs = results.reduce((acc, r) => acc + r.wallClockMs, 0);
  const htmlReport = generateReportHtml(results, cliArgs, {
    generatedAt: new Date().toISOString(),
    totalWallClockMs,
    model: cliArgs.model,
    scales: cliArgs.scales
  });
  writeFileSync(htmlPath, htmlReport, "utf8");

  console.log(`\x1b[32m[Saved Artifacts]\x1b[0m`);
  console.log(`  JSON:     ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);
  console.log(`  HTML:     ${htmlPath}\n`);
}

// ============================================================================
// Direct Execution
// ============================================================================

if (import.meta.main) {
  try {
    const cliArgs = parseCliArgs(process.argv);
    runBenchmark(cliArgs)
      .then(() => {
        if (!cliArgs.web) process.exit(0);
      })
      .catch((err) => {
        console.error(`\x1b[31mBenchmark failed:\x1b[0m`, err);
        process.exit(1);
      });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "commander.helpDisplayed") {
      process.exit(0);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
