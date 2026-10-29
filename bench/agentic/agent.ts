/**
 * Autonomous Agent Runner for Agentic Compaction Benchmarks.
 *
 * Runs an LLM agent through a multi-turn scenario inside an isolated,
 * egress-guarded sandbox using a selected compaction strategy.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "./sandbox.ts";
import {
  type LlmMessage,
  type LlmToolCall,
  type LlmToolSpec,
  type LlmCompletion,
  callLlm
} from "./llm.ts";
import { BASE_TOOL_SPECS, executeBaseTool, type ToolContext } from "./tools.ts";
import {
  createCompactionRuntime,
  type CompactionStrategyName,
  type CompactionRuntime,
  type StrategyTelemetry
} from "./strategy-runtime.ts";
import {
  type ScenarioDefinition,
  type ScenarioTurn,
  type ScenarioMode,
  type ContextScale
} from "./scenarios.ts";
import { countTokens } from "../replay-lib.ts";
import type { Preset } from "../../src/config.ts";

export interface ProbeOutcome {
  probeId: string;
  turnIndex: number;
  passed: boolean;
  expectedKeywords: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  responseSnippet: string;
}

export interface RubricOutcome {
  id: string;
  name: string;
  weight: number;
  passed: boolean;
}

export interface TurnMetricRecord {
  turnIndex: number;
  userMessage: string;
  assistantSnippet: string;
  isProbe: boolean;
  probeOutcome?: ProbeOutcome;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  contextTokens: number;
  cacheHitRate: number;
  toolCallsCount: number;
  latencyMs: number;
  cost: number;
  maintenanceNote?: string;
}

export interface AgenticRunResult {
  mode: ScenarioMode;
  scale: ContextScale;
  strategy: CompactionStrategyName;
  model: string;
  totalTurns: number;
  completedTurns: number;
  rubricScore: number;
  rubricPassedCount: number;
  rubricTotalCount: number;
  rubricDetails: RubricOutcome[];
  probeScore: number;
  probePassedCount: number;
  probeTotalCount: number;
  probeDetails: ProbeOutcome[];
  tokens: {
    totalPrompt: number;
    totalCompletion: number;
    totalCached: number;
    cacheHitPct: number;
    billedTokens: number;
    peakContextTokens: number;
    finalContextTokens: number;
  };
  cost: number;
  wallClockMs: number;
  trajectory: TurnMetricRecord[];
  strategyTelemetry: StrategyTelemetry;
  verificationSummary: string;
  workspaceDir: string;
}

export interface AgentRunOptions {
  scenario: ScenarioDefinition;
  scale: ContextScale;
  strategy: CompactionStrategyName;
  model: string;
  windowTokens?: number;
  maxToolStepsPerTurn?: number;
  workspaceDir?: string;
  cleanupWorkspace?: boolean;
  preset?: Preset;
  temperature?: number;
  timeoutMs?: number;
  mock?: boolean;
  onTurnStart?: (turn: ScenarioTurn, totalTurns: number) => void;
  onToolCall?: (turnIndex: number, call: { name: string; args: Record<string, unknown>; output: string }) => void;
  onTurnEnd?: (stats: TurnMetricRecord) => void;
  onMaintenance?: (note: string) => void;
  signal?: AbortSignal;
}

export class AgentRunner {
  static async run(opts: AgentRunOptions): Promise<AgenticRunResult> {
    const tStart = performance.now();
    const windowTokens = opts.windowTokens ?? 1_000_000;
    const maxToolSteps = opts.maxToolStepsPerTurn ?? 8;
    const isMock = opts.mock ?? false;

    // 1. Create sandbox workspace
    const workspace = opts.workspaceDir ?? mkdtempSync(join(tmpdir(), "origami-agentic-bench-"));
    const sandbox = new Sandbox(workspace);

    // 2. Seed scenario workspace files
    opts.scenario.seedWorkspace(sandbox);

    // 3. Initialize strategy runtime
    const runtime: CompactionRuntime = createCompactionRuntime(opts.strategy, {
      preset: opts.preset ?? "balanced",
      windowTokens
    });

    // 4. Assemble tools & system instructions
    const tools: LlmToolSpec[] = [...BASE_TOOL_SPECS, ...runtime.toolSpecs()];
    const toolCtx: ToolContext = {
      sandbox,
      verify: () => opts.scenario.verifyWorkspace(sandbox)
    };

    const systemPrompt = [
      "You are an autonomous AI software engineer working in a sandboxed development environment.",
      opts.scenario.systemTaskBrief,
      runtime.systemInstructions(),
      "Use workspace tools (read_file, write_file, edit_file, list_files, grep, check_work) to inspect, write, and verify your implementation.",
      "Work systematically, respond clearly, and keep file implementations complete and modular."
    ].filter(Boolean).join("\n\n");

    const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

    // 5. Generate turns
    const turns = opts.scenario.generateTurns(opts.scale);
    const trajectory: TurnMetricRecord[] = [];
    const probeOutcomes: ProbeOutcome[] = [];

    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    let totalCost = 0;
    let peakContextTokens = 0;

    // 6. Turn Execution Loop
    for (let i = 0; i < turns.length; i++) {
      if (opts.signal?.aborted) break;

      const turn = turns[i]!;
      opts.onTurnStart?.(turn, turns.length);

      messages.push({ role: "user", content: turn.userMessage });

      let turnPrompt = 0;
      let turnCompletion = 0;
      let turnCached = 0;
      let turnCost = 0;
      let turnLatency = 0;
      let toolCallsCount = 0;
      let finalAssistantSnippet = "";
      let step = 0;

      while (step < maxToolSteps) {
        if (opts.signal?.aborted) break;

        const outbound = runtime.prepareOutbound(messages, windowTokens);
        const t0 = performance.now();

        let completion: LlmCompletion;
        if (isMock) {
          completion = generateMockCompletion(turn, messages, sandbox, runtime);
        } else {
          completion = await callLlm(opts.model, outbound, {
            tools,
            temperature: opts.temperature ?? 0.2,
            timeoutMs: opts.timeoutMs ?? 60_000,
            maxTokens: 1024
          });
        }

        const callLatency = Math.round(performance.now() - t0);
        turnLatency += callLatency;
        turnPrompt += completion.promptTokens;
        turnCompletion += completion.completionTokens;
        turnCached += completion.cachedTokens;
        turnCost += completion.cost;

        if (completion.stopReason === "error") {
          finalAssistantSnippet = `[Error: ${completion.error}]`;
          break;
        }

        if (completion.toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: completion.content || "",
            tool_calls: completion.toolCalls
          });

          for (const tc of completion.toolCalls) {
            toolCallsCount++;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }

            let output: string;
            const isBase = BASE_TOOL_SPECS.some((b) => b.function.name === tc.function.name);
            if (isBase) {
              const res = executeBaseTool(tc.function.name, args, toolCtx);
              output = res.output;
            } else {
              output = runtime.handleTool(tc.function.name, args, messages);
            }

            opts.onToolCall?.(turn.turnIndex, { name: tc.function.name, args, output });

            messages.push({
              role: "tool",
              name: tc.function.name,
              tool_call_id: tc.id,
              content: output
            });
          }

          step++;
        } else {
          // Assistant completed response
          finalAssistantSnippet = completion.content.trim().slice(0, 300);
          messages.push({
            role: "assistant",
            content: completion.content
          });
          break;
        }
      }

      // Check Probes
      let probeOutcome: ProbeOutcome | undefined;
      if (turn.isProbe && turn.expectedKeywords && turn.expectedKeywords.length > 0) {
        const lastAssistant = messages
          .filter((m) => m.role === "assistant")
          .at(-1)?.content ?? "";
        const lower = lastAssistant.toLowerCase();

        const matched = turn.expectedKeywords.filter((k) => lower.includes(k.toLowerCase()));
        const missing = turn.expectedKeywords.filter((k) => !lower.includes(k.toLowerCase()));
        const passed = missing.length === 0;

        probeOutcome = {
          probeId: turn.probeId ?? `probe-t${turn.turnIndex}`,
          turnIndex: turn.turnIndex,
          passed,
          expectedKeywords: turn.expectedKeywords,
          matchedKeywords: matched,
          missingKeywords: missing,
          responseSnippet: lastAssistant.slice(0, 240)
        };
        probeOutcomes.push(probeOutcome);
      }

      // Maintenance Hook (Auto-fold / soft-compact / handoff / shake)
      const maint = runtime.autoMaintain(messages, windowTokens);
      if (maint.acted && maint.note) {
        opts.onMaintenance?.(maint.note);
      }

      // Compute context tokens across active messages
      const currentContextTokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
      if (currentContextTokens > peakContextTokens) {
        peakContextTokens = currentContextTokens;
      }

      totalPrompt += turnPrompt;
      totalCompletion += turnCompletion;
      totalCached += turnCached;
      totalCost += turnCost;

      const turnMetric: TurnMetricRecord = {
        turnIndex: turn.turnIndex,
        userMessage: turn.userMessage,
        assistantSnippet: finalAssistantSnippet,
        isProbe: Boolean(turn.isProbe),
        probeOutcome,
        promptTokens: turnPrompt,
        completionTokens: turnCompletion,
        cachedTokens: turnCached,
        contextTokens: currentContextTokens,
        cacheHitRate: turnPrompt > 0 ? turnCached / turnPrompt : 0,
        toolCallsCount,
        latencyMs: turnLatency,
        cost: turnCost,
        maintenanceNote: maint.acted ? maint.note : undefined
      };

      trajectory.push(turnMetric);
      opts.onTurnEnd?.(turnMetric);
    }

    // 7. Post-scenario rubric evaluation
    const rubricDetails: RubricOutcome[] = opts.scenario.rubric.map((item) => {
      let passed = false;
      try {
        passed = item.check(sandbox);
      } catch {
        passed = false;
      }
      return {
        id: item.id,
        name: item.name,
        weight: item.weight,
        passed
      };
    });

    const rubricPassedWeight = rubricDetails.reduce((s, r) => s + (r.passed ? r.weight : 0), 0);
    const rubricTotalWeight = rubricDetails.reduce((s, r) => s + r.weight, 0);
    const rubricScore = rubricTotalWeight > 0 ? rubricPassedWeight / rubricTotalWeight : 0;
    const rubricPassedCount = rubricDetails.filter((r) => r.passed).length;

    const probePassedCount = probeOutcomes.filter((p) => p.passed).length;
    const probeTotalCount = probeOutcomes.length;
    const probeScore = probeTotalCount > 0 ? probePassedCount / probeTotalCount : 1.0;

    const finalContextTokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
    const cacheHitPct = totalPrompt > 0 ? (totalCached / totalPrompt) * 100 : 0;
    const billedTokens = Math.max(0, totalPrompt - totalCached) + totalCompletion;

    const wallClockMs = Math.round(performance.now() - tStart);

    const result: AgenticRunResult = {
      mode: opts.scenario.mode,
      scale: opts.scale,
      strategy: opts.strategy,
      model: opts.model,
      totalTurns: turns.length,
      completedTurns: trajectory.length,
      rubricScore,
      rubricPassedCount,
      rubricTotalCount: rubricDetails.length,
      rubricDetails,
      probeScore,
      probePassedCount,
      probeTotalCount,
      probeDetails: probeOutcomes,
      tokens: {
        totalPrompt,
        totalCompletion,
        totalCached,
        cacheHitPct,
        billedTokens,
        peakContextTokens,
        finalContextTokens
      },
      cost: totalCost,
      wallClockMs,
      trajectory,
      strategyTelemetry: runtime.telemetry(),
      verificationSummary: opts.scenario.verifyWorkspace(sandbox),
      workspaceDir: workspace
    };

    if (opts.cleanupWorkspace && !opts.workspaceDir) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* ignore cleanup error on Windows */
      }
    }

    return result;
  }
}

/**
 * Synthetic mock completion generator for local unit testing and offline CI smoke tests.
 */
function generateMockCompletion(
  turn: ScenarioTurn,
  messages: LlmMessage[],
  sandbox: Sandbox,
  runtime: CompactionRuntime
): LlmCompletion {
  const lastUser = messages.at(-1)?.content ?? "";

  // 1. Probe response
  if (turn.isProbe && turn.expectedKeywords) {
    return {
      content: `Recall Answer: The requested information contains ${turn.expectedKeywords.join(", ")}.`,
      toolCalls: [],
      promptTokens: 1200,
      completionTokens: 80,
      cachedTokens: 900,
      cost: 0,
      latencyMs: 15,
      resolvedModel: "mock-model",
      stopReason: "stop"
    };
  }

  // 2. Feature writing mock
  if (/pac-man|game\.js|maze|pellet|ghost/i.test(lastUser)) {
    try {
      const existing = sandbox.exists("game.js") ? sandbox.read("game.js") : "";
      sandbox.write(
        "game.js",
        `${existing}\n// Features implemented\n` +
          `const canvas = document.createElement('canvas'); requestAnimationFrame(() => {});\n` +
          `const maze = { grid: [], walls: [], map: [] };\n` +
          `const pacman = { x: 0, y: 0, direction: 'right', speed: 2, move() {} };\n` +
          `const pellets = []; const powerPellets = []; let score = 0;\n` +
          `const ghosts = [\n` +
          `  { name: 'blinky', color: 'red', mode: 'chase', target() {} },\n` +
          `  { name: 'pinky', color: 'pink', mode: 'ambush', ahead() {} },\n` +
          `  { name: 'inky', color: 'cyan', mode: 'flank', vector() {} },\n` +
          `  { name: 'clyde', color: 'orange', mode: 'scatter', distance() {} }\n` +
          `];\n` +
          `let lives = 3; function respawn() {} function reset() {}\n` +
          `let level = 1; function nextLevel() {} function clear() {}\n` +
          `localStorage.setItem('highScore', score);\n` +
          `const audioCtx = window.AudioContext ? new AudioContext() : null; function playSound() {}\n` +
          `window.addEventListener('keydown', (e) => { if (e.code === 'ArrowUp' || e.code === 'KeyW') pacman.direction = 'up'; });\n` +
          `function checkGameOver() { if (lives <= 0) return 'game over'; if (pellets.length === 0) return 'victory'; }\n`
      );
    } catch {}

    return {
      content: "Implemented core Pac-Man engine features in game.js.",
      toolCalls: [],
      promptTokens: 1500,
      completionTokens: 120,
      cachedTokens: 1100,
      cost: 0,
      latencyMs: 20,
      resolvedModel: "mock-model",
      stopReason: "stop"
    };
  }

  // 3. Security audit report mock
  if (/audit|vuln|src\//i.test(lastUser)) {
    try {
      sandbox.write(
        "AUDIT_REPORT.md",
        `# Security Audit Report\n` +
          `- SQL Injection in src/db/users.js (raw query concatenation)\n` +
          `- Path Traversal in src/api/files.js (arbitrary file read)\n` +
          `- Command Injection in src/utils/media.js (exec spawn)\n` +
          `- Hardcoded Secret in src/config/auth.js (JWT key super-secret-production-signing-key-998811)\n` +
          `- Stored XSS in src/api/comments.js (unescaped script tag)\n` +
          `- BOLA / IDOR in src/api/orders.js (missing authorization ownership check)\n`
      );
    } catch {}

    return {
      content: "Compiled vulnerability findings into AUDIT_REPORT.md.",
      toolCalls: [],
      promptTokens: 1400,
      completionTokens: 90,
      cachedTokens: 1050,
      cost: 0,
      latencyMs: 18,
      resolvedModel: "mock-model",
      stopReason: "stop"
    };
  }
  // 4. General mode mock
  if (/matrix|architecture|validate/i.test(lastUser)) {
    try {
      sandbox.write("src/matrix.ts", "export function matrixAdd() {}\nexport function matrixMultiply() {}\n");
      sandbox.write("tests/matrix.test.ts", "import { test, expect } from 'bun:test';\ntest('matrix', () => expect(true).toBe(true));\n");
      const existingArch = sandbox.exists("docs/ARCHITECTURE.md") ? sandbox.read("docs/ARCHITECTURE.md") : "# Architecture\n";
      sandbox.write("docs/ARCHITECTURE.md", `${existingArch}\n\n## Matrix Operations\nComprehensive matrix math module documentation and usage examples.\n`);
    } catch {}

    return {
      content: "Implemented matrix modules and updated architecture documentation.",
      toolCalls: [],
      promptTokens: 1300,
      completionTokens: 85,
      cachedTokens: 980,
      cost: 0,
      latencyMs: 16,
      resolvedModel: "mock-model",
      stopReason: "stop"
    };
  }


  // 4. General / Memory fallback
  return {
    content: "Task completed successfully and verified.",
    toolCalls: [],
    promptTokens: 1000,
    completionTokens: 50,
    cachedTokens: 800,
    cost: 0,
    latencyMs: 10,
    resolvedModel: "mock-model",
    stopReason: "stop"
  };
}
