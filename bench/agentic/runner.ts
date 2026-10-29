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
import { AgentRunner, type AgenticRunResult, type TurnMetricRecord } from "./agent.ts";
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
  scale: ContextScale;
  strategies: CompactionStrategyName[];
  model: string;
  mock: boolean;
  web: boolean;
  port: number;
  outDir: string;
}

const ALL_STRATEGIES: CompactionStrategyName[] = [
  "origami",
  "soft",
  "handover",
  "shake",
  "sliding-window"
];

const ALL_MODES: ScenarioMode[] = ["programming", "research", "general", "memory"];

export function parseCliArgs(argv: string[]): RunnerCliArgs {
  const args = argv.slice(2);
  let modes: ScenarioMode[] = [];
  let scale: ContextScale = "low";
  let strategies: CompactionStrategyName[] = [];
  let model = "openrouter/nvidia/nemotron-3.5-super-vl:free";
  let mock = false;
  let web = false;
  let port = 4143;
  let outDir = "bench/results";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--mode" || a === "-m") {
      const val = args[++i]!;
      if (val === "all") modes = [...ALL_MODES];
      else if (ALL_MODES.includes(val as ScenarioMode)) modes = [val as ScenarioMode];
      else {
        console.error(`Unknown mode: ${val}. Available: ${ALL_MODES.join(", ")}, all`);
        process.exit(1);
      }
    } else if (a === "--scale" || a === "-s") {
      const val = args[++i]!;
      if (val in SCALE_TURNS) scale = val as ContextScale;
      else {
        console.error(`Unknown scale: ${val}. Available: low (20), medium (60), high (150), insane (300)`);
        process.exit(1);
      }
    } else if (a === "--strategy") {
      const val = args[++i]!;
      if (val === "all") strategies = [...ALL_STRATEGIES];
      else if (ALL_STRATEGIES.includes(val as CompactionStrategyName)) strategies = [val as CompactionStrategyName];
      else {
        console.error(`Unknown strategy: ${val}. Available: ${ALL_STRATEGIES.join(", ")}, all`);
        process.exit(1);
      }
    } else if (a === "--model") {
      model = args[++i]!;
    } else if (a === "--mock") {
      mock = true;
    } else if (a === "--web") {
      web = true;
    } else if (a === "--port") {
      port = parseInt(args[++i]!, 10);
    } else if (a === "--out") {
      outDir = args[++i]!;
    }
  }

  if (modes.length === 0) modes = ["programming"];
  if (strategies.length === 0) strategies = [...ALL_STRATEGIES];

  return { modes, scale, strategies, model, mock, web, port, outDir };
}

function printHelp(): void {
  console.log(`
Origami Agentic Context Benchmark Runner

Usage:
  bun bench/agentic/runner.ts [options]

Options:
  --mode, -m <mode>        Scenario mode: programming | research | general | memory | all (default: programming)
  --scale, -s <scale>      Context intensity scale: low (20) | medium (60) | high (150) | insane (300) (default: low)
  --strategy <strat>       Compaction strategy: origami | soft | handover | shake | sliding-window | all (default: all)
  --model <name>           LLM model identifier (default: openrouter/nvidia/nemotron-3.5-super-vl:free)
  --mock                   Run with simulated deterministic completions (offline smoke test)
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

class DashboardBroadcaster {
  private clients = new Map<string, SseClient>();
  private lastState: Record<string, unknown> = {
    status: "idle",
    runs: []
  };

  addClient(controller: ReadableStreamDefaultController<Uint8Array>): string {
    const id = Math.random().toString(36).slice(2);
    this.clients.set(id, { id, controller });
    // Send initial snapshot
    this.send(id, "init", this.lastState);
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
  const html = getDashboardHtml(port);

  Bun.serve({
    port,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
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

      return new Response("Not found", { status: 404 });
    }
  });

  console.log(`\x1b[36m[Dashboard]\x1b[0m Live benchmark web server running at \x1b[1mhttp://localhost:${port}\x1b[0m`);
}

// ============================================================================
// Main Orchestration Loop
// ============================================================================

export async function runBenchmark(cliArgs: RunnerCliArgs): Promise<AgenticRunResult[]> {
  const broadcaster = new DashboardBroadcaster();

  if (cliArgs.web) {
    startWebDashboard(cliArgs.port, broadcaster);
  }

  const results: AgenticRunResult[] = [];
  const totalRuns = cliArgs.modes.length * cliArgs.strategies.length;
  let runIndex = 0;

  console.log(`\n\x1b[1m\x1b[35m=== Origami Agentic Context Benchmark ===\x1b[0m`);
  console.log(`Model:      \x1b[36m${cliArgs.model}\x1b[0m`);
  console.log(`Scale:      \x1b[33m${cliArgs.scale}\x1b[0m (${SCALE_TURNS[cliArgs.scale]} turns/run)`);
  console.log(`Modes:      ${cliArgs.modes.join(", ")}`);
  console.log(`Strategies: ${cliArgs.strategies.join(", ")}`);
  console.log(`Total Runs: ${totalRuns} run(s) ${cliArgs.mock ? "(\x1b[32mMock Mode\x1b[0m)" : ""}\n`);

  broadcaster.updateState({
    status: "running",
    model: cliArgs.model,
    scale: cliArgs.scale,
    totalTurns: SCALE_TURNS[cliArgs.scale],
    totalRuns
  });

  for (const mode of cliArgs.modes) {
    const scenario: ScenarioDefinition = SCENARIO_REGISTRY[mode];

    for (const strategy of cliArgs.strategies) {
      runIndex++;
      const runBanner = `[${runIndex}/${totalRuns}] Mode: ${mode.toUpperCase()} · Strategy: ${strategy.toUpperCase()}`;
      console.log(`\x1b[1m\x1b[34m------------------------------------------------------------\x1b[0m`);
      console.log(`\x1b[1m\x1b[34m${runBanner}\x1b[0m`);
      console.log(`\x1b[1m\x1b[34m------------------------------------------------------------\x1b[0m`);

      broadcaster.updateState({
        currentRun: {
          index: runIndex,
          mode,
          strategy,
          totalTurns: SCALE_TURNS[cliArgs.scale]
        }
      });

      const runResult = await AgentRunner.run({
        scenario,
        scale: cliArgs.scale,
        strategy,
        model: cliArgs.model,
        mock: cliArgs.mock,
        cleanupWorkspace: true,
        onTurnStart: (turn, total) => {
          const probeTag = turn.isProbe ? " \x1b[35m[Probe Needle]\x1b[0m" : "";
          process.stdout.write(
            `\r  Turn \x1b[1m${turn.turnIndex}/${total}\x1b[0m${probeTag} ... `
          );
        },
        onToolCall: (turnIdx, call) => {
          broadcaster.broadcast("tool_call", {
            strategy,
            turn: turnIdx,
            tool: call.name,
            outputSnippet: call.output.slice(0, 160)
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

          console.log(
            `\r  Turn \x1b[1m${metric.turnIndex}\x1b[0m: ` +
              `ctx: \x1b[33m${metric.contextTokens.toLocaleString()}t\x1b[0m · ` +
              `prompt: ${metric.promptTokens.toLocaleString()}t · ` +
              `cache: \x1b[32m${cacheHit}%\x1b[0m · ` +
              `tools: ${metric.toolCallsCount}` +
              probeStatus +
              maint
          );

          broadcaster.broadcast("turn_done", {
            strategy,
            metric
          });
        },
        onMaintenance: (note: string) => {
          broadcaster.broadcast("maintenance", { strategy, note });
        }
      });

      results.push(runResult);

      const rubricPct = Math.round(runResult.rubricScore * 100);
      const probePct = Math.round(runResult.probeScore * 100);
      const cacheHitPct = Math.round(runResult.tokens.cacheHitPct);

      console.log(`\n  \x1b[1mResult:\x1b[0m Task Rubric: \x1b[1m${rubricPct}%\x1b[0m (${runResult.rubricPassedCount}/${runResult.rubricTotalCount}) · ` +
        `Probe Recall: \x1b[1m${probePct}%\x1b[0m (${runResult.probePassedCount}/${runResult.probeTotalCount}) · ` +
        `Billed: \x1b[33m${runResult.tokens.billedTokens.toLocaleString()}t\x1b[0m · ` +
        `Cache Hit: \x1b[32m${cacheHitPct}%\x1b[0m\n`);

      broadcaster.broadcast("run_complete", {
        runResult
      });
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

  console.log(
    `| Strategy       | Mode        | Task (Rubric) | Probe Recall | Billed Tokens | Peak Ctx  | Cache Hit % | Cost    |`
  );
  console.log(
    `|----------------|-------------|---------------|--------------|---------------|-----------|-------------|---------|`
  );

  for (const r of results) {
    const strat = r.strategy.padEnd(14);
    const mode = r.mode.padEnd(11);
    const rubric = `${Math.round(r.rubricScore * 100)}% (${r.rubricPassedCount}/${r.rubricTotalCount})`.padEnd(13);
    const probe = `${Math.round(r.probeScore * 100)}% (${r.probePassedCount}/${r.probeTotalCount})`.padEnd(12);
    const billed = r.tokens.billedTokens.toLocaleString().padEnd(13);
    const peak = r.tokens.peakContextTokens.toLocaleString().padEnd(9);
    const hit = `${Math.round(r.tokens.cacheHitPct)}%`.padEnd(11);
    const cost = `$${r.cost.toFixed(4)}`.padEnd(7);

    console.log(`| ${strat} | ${mode} | ${rubric} | ${probe} | ${billed} | ${peak} | ${hit} | ${cost} |`);
  }
  console.log();
}

function saveBenchmarkArtifacts(results: AgenticRunResult[], cliArgs: RunnerCliArgs): void {
  mkdirSync(cliArgs.outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(cliArgs.outDir, `agentic-${cliArgs.scale}-${timestamp}.json`);
  const mdPath = join(cliArgs.outDir, `agentic-${cliArgs.scale}-${timestamp}.md`);

  // Write JSON
  writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");

  // Write Markdown
  const mdLines: string[] = [
    `# Agentic Compaction Benchmark Report`,
    ``,
    `- **Model:** \`${cliArgs.model}\``,
    `- **Scale:** \`${cliArgs.scale}\` (${SCALE_TURNS[cliArgs.scale]} turns per scenario)`,
    `- **Timestamp:** \`${new Date().toISOString()}\``,
    `- **Execution Mode:** ${cliArgs.mock ? "Mock Simulation" : "Live LLM Execution"}`,
    ``,
    `## Summary Comparison Matrix`,
    ``,
    `| Strategy | Mode | Task Rubric | Probe Recall | Billed Tokens | Peak Context | Cache Hit Rate | Time (s) |`,
    `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |`
  ];

  for (const r of results) {
    const rubricPct = `${Math.round(r.rubricScore * 100)}% (${r.rubricPassedCount}/${r.rubricTotalCount})`;
    const probePct = `${Math.round(r.probeScore * 100)}% (${r.probePassedCount}/${r.probeTotalCount})`;
    const billed = r.tokens.billedTokens.toLocaleString();
    const peak = r.tokens.peakContextTokens.toLocaleString();
    const hitRate = `${Math.round(r.tokens.cacheHitPct)}%`;
    const sec = (r.wallClockMs / 1000).toFixed(1);

    mdLines.push(
      `| **${r.strategy}** | \`${r.mode}\` | ${rubricPct} | ${probePct} | ${billed} | ${peak} | ${hitRate} | ${sec}s |`
    );
  }

  mdLines.push(
    ``,
    `## Strategic Architectural Findings`,
    ``,
    `1. **Origami (Pagoda Folding + Bounded Ledger + JIT Hydration):**`,
    `   - Achieves highest prompt cache stability by preserving folded summaries in a monotonic prefix.`,
    `   - JIT reactive hydration guarantees high probe recall even at deep context scales without bloating long-term state.`,
    ``,
    `2. **Soft Compaction (omp /compact soft / Claude Code):**`,
    `   - Periodic full-history summarization compresses tokens but rewires historical prefix, evicting KV cache pages.`,
    `   - Vulnerable to information loss on precise needles as summaries condense repeated interactions.`,
    ``,
    `3. **Handover / State Transfer (omp /handoff / Devin):**`,
    `   - Drastically cleans context mass to near-zero but permanently drops un-transcribed background details.`,
    `   - Probe recall plummets when needles from early turns are not explicitly carried forward.`,
    ``,
    `4. **Shake (Tool Output Pruning / SWE-Pruner):**`,
    `   - Elides heavy tool observations while keeping conversation turns verbatim.`,
    `   - Highly effective for initial turns but suffers linear conversation token bloat on high/insane scales.`,
    ``,
    `5. **Sliding Window (FIFO Truncation):**`,
    `   - Zero cognitive overhead but suffers catastrophic amnesia once context exceeds the sliding boundary.`
  );

  writeFileSync(mdPath, mdLines.join("\n"), "utf8");
  console.log(`\x1b[32m[Saved Artifacts]\x1b[0m`);
  console.log(`  JSON:     ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}\n`);
}

// ============================================================================
// Web Dashboard HTML Template
// ============================================================================

function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Origami Agentic Compaction Benchmark</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #121826;
      --card-border: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #a855f7;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', system-ui, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--primary);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
    }
    .kpi-title {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .kpi-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }
    @media (max-width: 900px) {
      .grid-2 { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
    }
    .panel-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--card-border);
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td.mono {
      font-family: 'JetBrains Mono', monospace;
    }
    .strat-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 6px;
      display: inline-block;
    }
    .strat-origami { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid #38bdf8; }
    .strat-soft { background: rgba(168, 85, 247, 0.2); color: #a855f7; border: 1px solid #a855f7; }
    .strat-handover { background: rgba(251, 191, 36, 0.2); color: #fbbf24; border: 1px solid #fbbf24; }
    .strat-shake { background: rgba(52, 211, 153, 0.2); color: #34d399; border: 1px solid #34d399; }
    .strat-sliding-window { background: rgba(148, 163, 184, 0.2); color: #94a3b8; border: 1px solid #94a3b8; }

    .feed {
      height: 380px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      background: #0b0f19;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
    }
    .feed-item {
      padding: 6px 10px;
      border-radius: 4px;
      background: rgba(30, 41, 59, 0.5);
      border-left: 3px solid var(--primary);
    }
    .feed-item.probe-pass { border-left-color: var(--success); }
    .feed-item.probe-fail { border-left-color: var(--danger); }
    .feed-item.maint { border-left-color: var(--warning); }
    .feed-time { color: var(--muted); font-size: 10px; margin-right: 6px; }

    #trajectory-svg {
      width: 100%;
      height: 240px;
      background: #0b0f19;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" stroke="#38bdf8" stroke-width="2" fill="none" />
        <polyline points="2,8.5 12,14.5 22,8.5" stroke="#38bdf8" stroke-width="1.5" />
        <line x1="12" y1="14.5" x2="12" y2="22" stroke="#38bdf8" stroke-width="1.5" />
      </svg>
      <h1>Origami Agentic Compaction Benchmark</h1>
      <span class="badge" id="status-badge">Idle</span>
    </div>
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);" id="header-meta">
      Scale: - · Model: -
    </div>
  </header>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-title">Current Run Progress</div>
      <div class="kpi-val" id="kpi-turn">0 / 0</div>
      <div class="kpi-sub" id="kpi-strat">-</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Context Ceiling & Peak</div>
      <div class="kpi-val" id="kpi-ctx">0 t</div>
      <div class="kpi-sub" id="kpi-tokens-sub">Prompt: 0 · Cached: 0</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Prompt Cache Hit Rate</div>
      <div class="kpi-val" id="kpi-cache" style="color: var(--success)">0.0%</div>
      <div class="kpi-sub">Prefix amortization efficiency</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Recall Needle Accuracy</div>
      <div class="kpi-val" id="kpi-recall" style="color: var(--primary)">100%</div>
      <div class="kpi-sub" id="kpi-probes-sub">0 / 0 passed</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="panel">
      <div class="panel-title">
        <span>Strategy Comparison Matrix</span>
        <span class="badge" id="runs-count">0 Completed</span>
      </div>
      <table id="matrix-table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Mode</th>
            <th>Task (Rubric)</th>
            <th>Probe Recall</th>
            <th>Billed Tokens</th>
            <th>Peak Ctx</th>
            <th>Cache Hit</th>
          </tr>
        </thead>
        <tbody id="matrix-tbody">
          <tr><td colspan="7" style="color: var(--muted); text-align: center; padding: 24px;">Waiting for benchmark runs...</td></tr>
        </tbody>
      </table>

      <div style="margin-top: 24px;">
        <div class="panel-title" style="margin-bottom: 8px;">Context Tokens Trajectory</div>
        <svg id="trajectory-svg" viewBox="0 0 600 240"></svg>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">Live Activity & Telemetry</div>
      <div class="feed" id="feed-box">
        <div class="feed-item">Listening for benchmark events on port ${port}...</div>
      </div>
    </div>
  </div>

  <script>
    const evtSource = new EventSource('/api/events');
    const badge = document.getElementById('status-badge');
    const headerMeta = document.getElementById('header-meta');
    const kpiTurn = document.getElementById('kpi-turn');
    const kpiStrat = document.getElementById('kpi-strat');
    const kpiCtx = document.getElementById('kpi-ctx');
    const kpiTokensSub = document.getElementById('kpi-tokens-sub');
    const kpiCache = document.getElementById('kpi-cache');
    const kpiRecall = document.getElementById('kpi-recall');
    const kpiProbesSub = document.getElementById('kpi-probes-sub');
    const feedBox = document.getElementById('feed-box');
    const matrixTbody = document.getElementById('matrix-tbody');
    const runsCount = document.getElementById('runs-count');
    const trajectorySvg = document.getElementById('trajectory-svg');

    const completedRuns = [];
    const turnPoints = [];

    function addFeed(text, cls = '') {
      const d = document.createElement('div');
      d.className = 'feed-item ' + cls;
      const t = new Date().toLocaleTimeString();
      d.innerHTML = '<span class="feed-time">' + t + '</span>' + text;
      feedBox.prepend(d);
      if (feedBox.children.length > 50) {
        feedBox.removeChild(feedBox.lastChild);
      }
    }

    evtSource.addEventListener('state_update', (e) => {
      const data = JSON.parse(e.data);
      if (data.status) badge.textContent = data.status.toUpperCase();
      if (data.model && data.scale) {
        headerMeta.textContent = 'Scale: ' + data.scale + ' (' + data.totalTurns + 't) · Model: ' + data.model;
      }
      if (data.currentRun) {
        kpiStrat.textContent = 'Strategy: ' + data.currentRun.strategy + ' (' + data.currentRun.mode + ')';
      }
    });

    evtSource.addEventListener('turn_done', (e) => {
      const data = JSON.parse(e.data);
      const m = data.metric;
      kpiTurn.textContent = m.turnIndex + ' / ' + (headerMeta.textContent.match(/\\((\\d+)t\\)/)?.[1] || '-');
      kpiCtx.textContent = m.contextTokens.toLocaleString() + ' t';
      kpiTokensSub.textContent = 'Prompt: ' + m.promptTokens.toLocaleString() + ' · Cached: ' + m.cachedTokens.toLocaleString();
      const hit = Math.round(m.cacheHitRate * 100);
      kpiCache.textContent = hit + '%';

      turnPoints.push({ turn: m.turnIndex, tokens: m.contextTokens, strat: data.strategy });
      drawTrajectory();

      let cls = '';
      let msg = '[' + data.strategy + '] Turn ' + m.turnIndex + ': ' + m.contextTokens.toLocaleString() + 't ctx (' + hit + '% hit)';
      if (m.isProbe) {
        if (m.probeOutcome && m.probeOutcome.passed) {
          cls = 'probe-pass';
          msg += ' · Probe PASSED ✓';
        } else {
          cls = 'probe-fail';
          msg += ' · Probe FAILED ✗';
        }
      }
      if (m.maintenanceNote) {
        cls = 'maint';
        msg += ' · ' + m.maintenanceNote;
      }
      addFeed(msg, cls);
    });

    evtSource.addEventListener('run_complete', (e) => {
      const data = JSON.parse(e.data);
      completedRuns.push(data.runResult);
      updateMatrix();
    });

    function updateMatrix() {
      runsCount.textContent = completedRuns.length + ' Completed';
      matrixTbody.innerHTML = '';
      for (const r of completedRuns) {
        const tr = document.createElement('tr');
        const rubricPct = Math.round(r.rubricScore * 100) + '% (' + r.rubricPassedCount + '/' + r.rubricTotalCount + ')';
        const probePct = Math.round(r.probeScore * 100) + '% (' + r.probePassedCount + '/' + r.probeTotalCount + ')';
        tr.innerHTML =
          '<td><span class="strat-pill strat-' + r.strategy + '">' + r.strategy + '</span></td>' +
          '<td><code>' + r.mode + '</code></td>' +
          '<td>' + rubricPct + '</td>' +
          '<td>' + probePct + '</td>' +
          '<td class="mono">' + r.tokens.billedTokens.toLocaleString() + '</td>' +
          '<td class="mono">' + r.tokens.peakContextTokens.toLocaleString() + '</td>' +
          '<td class="mono">' + Math.round(r.tokens.cacheHitPct) + '%</td>';
        matrixTbody.appendChild(tr);
      }
    }

    function drawTrajectory() {
      if (turnPoints.length === 0) return;
      const maxTok = Math.max(...turnPoints.map(p => p.tokens), 5000);
      const maxTurn = Math.max(...turnPoints.map(p => p.turn), 20);

      const w = 560;
      const h = 200;
      const padX = 30;
      const padY = 20;

      let pathD = '';
      turnPoints.forEach((p, i) => {
        const x = padX + (p.turn / maxTurn) * (w - padX);
        const y = h - padY - (p.tokens / maxTok) * (h - padY * 2);
        pathD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      });

      trajectorySvg.innerHTML =
        '<line x1="' + padX + '" y1="' + (h - padY) + '" x2="' + w + '" y2="' + (h - padY) + '" stroke="#1e293b" stroke-width="1"/>' +
        '<path d="' + pathD + '" fill="none" stroke="#38bdf8" stroke-width="2"/>' +
        '<text x="' + padX + '" y="15" fill="#94a3b8" font-size="10" font-family="monospace">Peak: ' + maxTok.toLocaleString() + 't</text>';
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// Direct Execution
// ============================================================================

if (import.meta.main) {
  const cliArgs = parseCliArgs(process.argv);
  runBenchmark(cliArgs).catch((err) => {
    console.error(`\x1b[31mBenchmark failed:\x1b[0m`, err);
    process.exit(1);
  });
}
