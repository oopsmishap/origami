/**
 * Autonomous agent runner for the agentic compaction benchmark.
 *
 * The Vercel AI SDK owns model serialization, native reasoning, tool-call
 * validation/execution, retries, and the multi-step tool loop. This runner
 * keeps only benchmark orchestration, strategy context preparation, scoring,
 * and telemetry.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs } from "ai";
import { createNativeOllamaModel, isTimeoutError, type NativeOllamaLanguageModel } from "./ollama-model.ts";
import { Sandbox } from "./sandbox.ts";
import {
  cacheAccounting,
  createLlmCacheState,
  fromModelMessages,
  toModelMessages,
  type LlmMessage
} from "./llm.ts";
import {
  getBenchmarkTokenizer,
  type BenchmarkTokenizer,
  type TokenizerTelemetry
} from "./tokenizer.ts";
import {
  evaluateScenario,
  type RubricOutcome,
  type RubricItemStatus,
  type ScenarioEvaluationResult
} from "./evaluation.ts";
import { createAgentTools, createToolCallMemo } from "./ai-tools.ts";
import {
  AUTO_COMPACTION_FILL,
  type CompactionStrategyName,
  createCompactionRuntime,
  type CompactionRuntime,
  type StrategyTelemetry,
  type SummaryFn,
  type SummaryRequest,
  type SummaryUsage
} from "./strategy-runtime.ts";
import {
  type ContextScale,
  type ScenarioDefinition,
  type ScenarioMode,
  type ScenarioTurn
} from "./scenarios.ts";
import type { Preset } from "../../src/config.ts";
import { generateCodebaseCorpus } from "./codebase-corpus.ts";
import { estimateLlmCost, GPT_5_6_SOL_PRICING } from "./pricing.ts";

export interface ProbeOutcome {
  probeId: string;
  turnIndex: number;
  passed: boolean;
  expectedKeywords: string[];
  staleKeywords?: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  staleMatchedKeywords?: string[];
  responseSnippet: string;
}

export type { RubricOutcome, RubricItemStatus, ScenarioEvaluationResult };

export interface TurnMetricRecord {
  turnIndex: number;
  userMessage: string;
  assistantSnippet: string;
  isProbe: boolean;
  probeOutcome?: ProbeOutcome;
  promptTokens: number;
  completionTokens?: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  rawHistoryTokens?: number;
  cacheHitRate: number;
  latencyMs: number;
  cost: number;
  maintenanceNote?: string;
  toolCallsCount?: number;
}

export interface ChatToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
}

export interface ChatMessageRecord {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: ChatToolCallRecord[];
  toolCallId?: string;
  name?: string;
  timestamp: string;
}

export interface ChatTurnRecord {
  turnIndex: number;
  userMessage: string;
  isProbe: boolean;
  probeOutcome?: ProbeOutcome;
  messages: ChatMessageRecord[];
  maintenanceNote?: string;
  metrics: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number;
    contextTokens: number;
    latencyMs: number;
  };
}

export interface AgenticRunResult {
  mode: ScenarioMode;
  scale: ContextScale;
  strategy: CompactionStrategyName;
  model: string;
  pricingModel: string;
  totalTurns: number;
  completedTurns: number;
  rubricScore: number | null;
  rubricPassedCount: number;
  rubricFailedCount?: number;
  rubricTotalCount: number;
  rubricDetails: RubricOutcome[];
  rubricEvaluatedCount: number;
  rubricUnavailableCount: number;
  rubricErrorCount: number;
  evaluationPrerequisites?: ScenarioEvaluationResult["prerequisites"];
  probeScore: number;
  probePassedCount: number;
  probeTotalCount: number;
  probeDetails: ProbeOutcome[];
  tokens: {
    totalPrompt: number;
    totalCompletion: number;
    totalCached: number;
    totalCacheWrite: number;
    cacheHitPct: number;
    billedTokens: number;
    peakContextTokens: number;
    finalContextTokens: number;
    rawHistoryTokens?: number;
  };
  cost: number;
  wallClockMs: number;
  trajectory: TurnMetricRecord[];
  chatTranscript: ChatTurnRecord[];
  strategyTelemetry: StrategyTelemetry;
  tokenizerTelemetry?: TokenizerTelemetry;
  verificationSummary: string;
  workspaceDir: string;
}

export interface AgentRunOptions {
  runId?: string;
  scenario: ScenarioDefinition;
  scale: ContextScale;
  strategy: CompactionStrategyName;
  model: string;
  windowTokens?: number;
  maxToolStepsPerTurn?: number;
  workspaceDir?: string;
  cleanupWorkspace?: boolean;
  preset?: Preset;
  pricingModel?: string;
  mock?: boolean;
  temperature?: number;
  timeoutMs?: number;
  onTurnStart?: (turn: ScenarioTurn, totalTurns: number) => void;
  onToolCall?: (turnIndex: number, call: { name: string; args: Record<string, unknown>; output: string }) => void;
  onTurnEnd?: (stats: TurnMetricRecord) => void;
  onChatTurn?: (turn: ChatTurnRecord) => void;
  onMaintenance?: (note: string) => void;
  onFeed?: (event: { type: string; turn?: number; title?: string; details: string }) => void;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  prefillTokens?: number;
  maxTurns?: number;
  compactEvery?: number;
}

function countFreshMessageTokens(message: ChatMessageRecord, includeReasoning: boolean, tokenizer: BenchmarkTokenizer): number {
  const parts = [message.content, includeReasoning ? message.reasoning ?? "" : ""];
  if (message.role === "user" || message.role === "tool") {
    parts.push(message.name ?? "", message.toolCallId ?? "");
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    parts.push(message.toolCalls.map((call) => `${call.name}\n${JSON.stringify(call.args)}`).join("\n"));
  }
  return tokenizer.countText(parts.filter(Boolean).join("\n"));
}

function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434")
    .replace(/\/v1\/?$/, "")
    .replace(/\/api\/?$/, "")
    .replace(/\/+$/, "");
}

function modelId(model: string): string {
  return model.replace(/^ollama\//, "");
}

function chatRecordsFor(messages: LlmMessage[], turnIndex: number): ChatMessageRecord[] {
  const records: ChatMessageRecord[] = [];
  const calls = new Map<string, ChatToolCallRecord>();
  let sequence = 0;
  for (const message of messages) {
    const timestamp = new Date().toISOString();
    if (message.role === "assistant") {
      const toolCalls = (message.tool_calls ?? []).map((call) => {
        const record: ChatToolCallRecord = {
          id: call.id || `call-${turnIndex}-${sequence}`,
          name: call.function.name,
          args: parseArguments(call.function.arguments)
        };
        calls.set(record.id, record);
        return record;
      });
      records.push({
        id: `msg-a-${turnIndex}-${sequence++}`,
        role: "assistant",
        content: message.content,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        timestamp
      });
    } else if (message.role === "tool") {
      const toolCallId = message.tool_call_id ?? `tool-${turnIndex}-${sequence}`;
      const call = calls.get(toolCallId);
      if (call) call.output = message.content;
      records.push({
        id: `msg-t-${turnIndex}-${sequence++}-${toolCallId}`,
        role: "tool",
        content: message.content,
        toolCallId,
        name: message.name,
        timestamp
      });
    } else {
      records.push({
        id: `msg-${message.role === "user" ? "u" : "s"}-${turnIndex}-${sequence++}`,
        role: message.role,
        content: message.content,
        timestamp
      });
    }
  }
  return records;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function lastAssistant(messages: readonly LlmMessage[]): LlmMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

interface MockCompletion {
  content: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  latencyMs: number;
}

const PROBE_NEGATION_RE = /\b(?:are not available|is not available|not documented|no records?|cannot find|could not find|do not have|don't have|unable to find|not present in|not specified in)\b/i;
const OVERRIDE_HISTORY_RE = /\b(?:supersed\w*|overrid\w*|overrode|updat\w*|chang\w*|replac\w*|revis\w*|reduc\w*|lower\w*|shorten\w*|tighten\w*|revok\w*|cap(?:ped)?\s+at|instead\s+of|from\s+\S+\s+to|previously|formerly|originally|initial(?:ly)?|earlier|was\b)\b/i;
const AMBIGUOUS_HEDGE_RE = /\b(?:either\b|\bor\b|unsure|not\s+sure|one\s+of)\b/i;

export function buildTurnTimeout(stepTimeoutMs = 600_000): { stepMs: number; totalMs: number } {
  const stepMs = Math.max(1_000, stepTimeoutMs);
  return {
    stepMs,
    totalMs: stepMs * 6
  };
}

/**
 * A model-backed compaction summary author, matching omp's "soft"/"handoff"
 * (both write their summary with the active model rather than scraping text).
 * Returns `undefined` on mock runs so hermetic tests fall back to deterministic
 * extraction; live runs always call the model and its tokens/cost are counted
 * against the run (the real overhead of model-driven compaction).
 */
function createSummarizer(opts: {
  model: NativeOllamaLanguageModel | undefined;
  tokenizer: BenchmarkTokenizer;
  usage: SummaryUsage;
}): SummaryFn | undefined {
  const { model, tokenizer } = opts;
  if (!model) return undefined;
  return async (request: SummaryRequest): Promise<{ text: string; usage: SummaryUsage }> => {
    const result = await generateText({
      model,
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens ?? 4_096,
      temperature: 0.2,
      maxRetries: 3
    });
    const inputTokens = tokenizer.countText(request.system + "\n" + request.prompt);
    const outputTokens = Math.max(1, tokenizer.countText(result.text));
    opts.usage.inputTokens += inputTokens;
    opts.usage.outputTokens += outputTokens;
    return { text: result.text, usage: { inputTokens, outputTokens } };
  };
}

/**
 * Threshold-triggered maintenance over the persistent message array.
 *
 * Multi-step tool turns used to compact a throwaway copy of the history on every
 * tool step, which re-ran the same compaction once per step and inflated
 * `compactionEvents`/`tokensReclaimed` (Soft logged 6 identical notes on one turn).
 * Maintaining the persistent array is idempotent — a second pass finds nothing left
 * to reclaim — and identical notes are emitted at most once per turn.
 *
 * Async because omp-style compaction writes its summary with the model
 * (`summaryFn`), so a maintenance pass may await a summarizer call.
 */
export function createTurnMaintainer(opts: {
  runtime: CompactionRuntime;
  messages: LlmMessage[];
  windowTokens: number;
  count: (messages: readonly LlmMessage[]) => number;
  onNote: (note: string) => void;
}): (observedPromptTokens?: number) => Promise<void> {
  const emittedNotes = new Set<string>();
  return async (observedPromptTokens = 0): Promise<void> => {
    const outbound = opts.runtime.prepareOutbound(opts.messages, opts.windowTokens + 8_000);
    const tokens = opts.count(outbound);
    if (Math.max(tokens, observedPromptTokens) < Math.ceil(opts.windowTokens * AUTO_COMPACTION_FILL)) return;
    const maintenance = await opts.runtime.autoMaintain(opts.messages, opts.windowTokens, true);
    if (maintenance.acted && maintenance.note && !emittedNotes.has(maintenance.note)) {
      emittedNotes.add(maintenance.note);
      opts.onNote(maintenance.note);
    }
  };
}

/**
 * Evaluates a probe response against expected keywords while:
 * 1. Rejecting false-positive matches where the model disclaims knowing the requested fact.
 * 2. Detecting temporal override failures where a superseded `staleKeywords` value is reported
 *    instead of (or hedged ambiguously alongside) the active setting.
 */
export function evaluateProbeAnswer(
  answer: string,
  expectedKeywords: readonly string[],
  staleKeywords?: readonly string[]
): { passed: boolean; matched: string[]; missing: string[]; staleMatched: string[] } {
  const lower = answer.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];

  const hasGlobalDisclaimer = PROBE_NEGATION_RE.test(answer);
  const paragraphs = answer.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  for (const keyword of expectedKeywords) {
    const kwLower = keyword.toLowerCase();
    if (!lower.includes(kwLower)) {
      missing.push(keyword);
      continue;
    }
    if (hasGlobalDisclaimer) {
      const containing = paragraphs.filter((p) => p.toLowerCase().includes(kwLower));
      const allDisclaimed = containing.length > 0 && containing.every(
        (p) => PROBE_NEGATION_RE.test(p) || /\bif you (?:are referring|mean)\b/i.test(p)
      );
      if (allDisclaimed) {
        missing.push(keyword);
        continue;
      }
    }
    matched.push(keyword);
  }

  const staleMatched = (staleKeywords ?? []).filter((st) => lower.includes(st.toLowerCase()));
  if (staleMatched.length > 0 && missing.length === 0) {
    const explainsTransition = OVERRIDE_HISTORY_RE.test(answer);
    const hedges = AMBIGUOUS_HEDGE_RE.test(answer) && !explainsTransition;
    if (!explainsTransition || hedges) {
      for (const st of staleMatched) {
        missing.push(`!stale:${st}`);
      }
    }
  }

  return { passed: missing.length === 0, matched, missing, staleMatched };
}

export class AgentRunner {
  static async run(opts: AgentRunOptions): Promise<AgenticRunResult> {
    const tStart = performance.now();
    const runId = opts.runId ?? `${opts.scenario.mode}-${opts.strategy}-${opts.scale}`;
    const windowTokens = opts.windowTokens ?? 1_000_000;
    const maxToolSteps = opts.maxToolStepsPerTurn ?? 8;
    const isMock = opts.mock ?? false;

    const workspace = opts.workspaceDir ?? mkdtempSync(join(tmpdir(), "origami-agentic-bench-"));
    const sandbox = new Sandbox(workspace);
    opts.scenario.seedWorkspace(sandbox);

    const tokenizer: BenchmarkTokenizer = await getBenchmarkTokenizer(opts.model, { mock: isMock });

    const id = modelId(opts.model);
    const isGemma4 = /^gemma4(?::|$)/i.test(id);
    const isLfm3 = /^lfm3(?::|$)/i.test(id);
    const effectiveMaxOutputTokens = opts.maxOutputTokens ?? (isGemma4 || isLfm3 ? 8_192 : 4_096);
    const turnTimeout = buildTurnTimeout(opts.timeoutMs ?? 600_000);
    const model = isMock ? undefined : createNativeOllamaModel(id, ollamaBaseUrl(), true, isGemma4 ? windowTokens : undefined);

    // omp's soft/handoff write their compaction summary with the active model.
    // Mock runs omit it and fall back to deterministic extraction; live runs count
    // the summarizer's tokens/cost like any other model call (folded into totals
    // after the loop).
    const summaryUsage: SummaryUsage = { inputTokens: 0, outputTokens: 0 };
    const summaryFn = createSummarizer({ model, tokenizer, usage: summaryUsage });

    const runtime: CompactionRuntime = createCompactionRuntime(opts.strategy, {
      preset: opts.preset ?? "balanced",
      windowTokens,
      forceThresholds: Boolean(opts.compactEvery && opts.compactEvery > 0),
      tokenizer,
      summaryFn
    });
    const toolContext = {
      sandbox,
      verify: () => opts.scenario.verifyWorkspace(sandbox)
    };

    const systemPrompt = [
      "You are an autonomous AI software engineer working in a sandboxed development environment.",
      opts.scenario.systemTaskBrief,
      runtime.systemInstructions(),
      "CRITICAL: You MUST invoke workspace tools (read_file, write_file, edit_file, list_files, grep, check_work) to inspect, write, and verify your implementation. Keep internal reasoning concise and invoke tools directly rather than drafting full file contents in thought blocks or chat.",
      "Work systematically, respond clearly, and keep file implementations complete and modular."
    ].filter(Boolean).join("\n\n");

    const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];
    if (opts.prefillTokens && opts.prefillTokens > 0) {
      const corpus = generateCodebaseCorpus(opts.prefillTokens);
      messages.push({
        role: "user",
        content: `Authoritative Monorepo Repository Baseline (${opts.prefillTokens.toLocaleString()} tokens):\n\n${corpus}\n\nPlease inspect the repository baseline above and confirm readiness for engineering operations.`
      });
      messages.push({
        role: "assistant",
        content: "I have reviewed the repository architecture, module specifications, and architectural decision records. All system parameters and database topology invariants are cataloged. Ready to proceed with implementation."
      });
    }

    const turns = opts.scenario.generateTurns(opts.scale).slice(0, opts.maxTurns ?? Number.POSITIVE_INFINITY);
    const initialContextTokens = tokenizer.countMessages(messages);
    const trajectory: TurnMetricRecord[] = [];
    const chatTranscript: ChatTurnRecord[] = [];
    const probeOutcomes: ProbeOutcome[] = [];
    const cacheState = createLlmCacheState();
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;
    let peakContextTokens = 0;
    let activeTurnIndex = 0;
    let toolCallsForTurn = 0;

    const toolMemo = createToolCallMemo();
    const tools = createAgentTools(toolContext, runtime, () => messages, {
      memo: toolMemo,
      onToolCall: (call) => {
        toolCallsForTurn++;
        opts.onToolCall?.(activeTurnIndex, call);
      }
    });

    for (let i = 0; i < turns.length; i++) {
      if (opts.signal?.aborted) break;
      const turn = turns[i]!;
      activeTurnIndex = turn.turnIndex;
      toolCallsForTurn = 0;
      toolMemo.reset();
      opts.onTurnStart?.(turn, turns.length);

      const promptContent = turn.isProbe
        ? turn.userMessage
        : `${turn.userMessage}\n\n(Remember: Invoke workspace tools to create and modify files. Do not output raw file code in chat.)`;
      messages.push({ role: "user", content: promptContent });
      const maintenanceNotes: string[] = [];
      const maintainAtLimit = createTurnMaintainer({
        runtime,
        messages,
        windowTokens,
        count: (m) => tokenizer.countMessages(m),
        onNote: (note) => {
          maintenanceNotes.push(note);
          opts.onMaintenance?.(note);
        }
      });
      await maintainAtLimit();
      const turnMessages: ChatMessageRecord[] = [{
        id: `msg-u-${turn.turnIndex}`,
        role: "user",
        content: promptContent,
        timestamp: new Date().toISOString()
      }];
      let turnPrompt = 0;
      let turnCompletion = 0;
      let turnCached = 0;
      let turnCacheWrite = 0;
      let turnCost = 0;
      let turnLatency = 0;
      let turnContextTokens = 0;
      let lastProviderPromptTokens = 0;
      let responseMessages: LlmMessage[] = [];

      if (isMock) {
        const mockOutbound = runtime.prepareOutbound(messages, windowTokens);
        const mock = generateMockCompletion(turn, messages, sandbox);
        responseMessages = [{ role: "assistant", content: mock.content }];
        turnPrompt = mock.promptTokens;
        turnCompletion = mock.completionTokens;
        turnCached = mock.cachedTokens;
        turnLatency = mock.latencyMs;
        turnContextTokens = tokenizer.countMessages(mockOutbound);
      } else {
        // Compaction runs once per turn (turn start + turn end) on the persistent
        // `messages` array rather than on a throwaway copy rebuilt per tool step. The old
        // per-step `maintainAtLimit(stepHistory)` mutated only its copy, so the base never
        // shrank and Soft re-compacted the identical span once per tool step (Soft
        // logged 6 duplicate notes on one turn). createTurnMaintainer's per-turn note dedup
        // then guarantees at most one note per distinct compaction. Mid-turn growth stays
        // bounded by prepareOutbound, so no request can overflow the window.
        const stripReasoning = (m: LlmMessage): LlmMessage => {
          if (!isGemma4 || !m.reasoning) return m;
          const { reasoning: _, ...rest } = m;
          return rest;
        };
        const initialOutbound = runtime.prepareOutbound(messages, windowTokens);
        const initialOutboundLength = initialOutbound.length;
        const startedAt = performance.now();
        try {
          const result = await generateText({
            model: model!,
            messages: toModelMessages(initialOutbound),
            allowSystemInMessages: true,
            tools,
            stopWhen: stepCountIs(maxToolSteps),
            temperature: opts.temperature ?? (isGemma4 ? 1.0 : 0.2),
            ...(isGemma4 ? { topP: 0.95, topK: 64 } : {}),
            maxOutputTokens: effectiveMaxOutputTokens,
            maxRetries: 5,
            timeout: turnTimeout,
            abortSignal: opts.signal,
            include: { requestMessages: true },
            prepareStep: ({ messages: stepMessages }) => {
              // Per-step request = persistent history + this turn's messages so far,
              // bounded by prepareOutbound so a long tool loop can never overflow the
              // window. No compaction runs here: maintenance happens on the persistent
              // `messages` at turn boundaries (see createTurnMaintainer), once per
              // compaction instead of once per tool step.
              const delta = fromModelMessages(stepMessages).slice(initialOutboundLength).map(stripReasoning);
              return { messages: toModelMessages(runtime.prepareOutbound([...messages, ...delta], windowTokens)) };
            }
          });
          responseMessages = fromModelMessages(result.responseMessages as never).map(stripReasoning);
          const allSteps = [...result.steps];

          // If maxToolSteps terminated right after a tool result before the model could emit a text reply,
          // run one tool-free synthesis pass so the turn always produces a final answer.
          if (responseMessages.at(-1)?.role === "tool" && !opts.signal?.aborted) {
            const synthView = [...messages, ...responseMessages];
            const synthOutbound = runtime.prepareOutbound(synthView, windowTokens);
            const synthResult = await generateText({
              model: model!,
              messages: toModelMessages(synthOutbound),
              allowSystemInMessages: true,
              temperature: opts.temperature ?? (isGemma4 ? 1.0 : 0.2),
              ...(isGemma4 ? { topP: 0.95, topK: 64 } : {}),
              maxOutputTokens: effectiveMaxOutputTokens,
              maxRetries: 3,
              timeout: turnTimeout,
              abortSignal: opts.signal,
              include: { requestMessages: true }
            });
            responseMessages.push(...fromModelMessages(synthResult.responseMessages as never).map(stripReasoning));
            allSteps.push(...synthResult.steps);
          }
          turnLatency = Math.round(performance.now() - startedAt);

          for (const step of allSteps) {
            const requestMessages = step.request.messages
              ? fromModelMessages(step.request.messages)
              : initialOutbound;
            const logicalTokens = tokenizer.countMessages(requestMessages);
            const rawUsage = (step.usage.raw as Record<string, unknown> | undefined) ?? {};
            const ollamaMeta = (step.providerMetadata?.ollama as Record<string, unknown> | undefined) ?? {};
            const contextPromptTokens = (typeof ollamaMeta.maxPromptEvalCount === "number" ? ollamaMeta.maxPromptEvalCount : undefined)
              ?? (typeof rawUsage.max_prompt_eval_count === "number" ? rawUsage.max_prompt_eval_count : undefined)
              ?? step.usage.inputTokens
              ?? logicalTokens;
            const billedPromptTokens = step.usage.inputTokens ?? logicalTokens;
            lastProviderPromptTokens = contextPromptTokens;
            const completionTokens = step.usage.outputTokens ?? 0;
            const cache = cacheAccounting(requestMessages, contextPromptTokens, cacheState, tokenizer);
            const cost = estimateLlmCost(
              GPT_5_6_SOL_PRICING,
              billedPromptTokens,
              cache.cachedTokens,
              cache.cacheWriteTokens,
              completionTokens
            );
            turnPrompt += billedPromptTokens;
            turnCompletion += completionTokens;
            turnCached += cache.cachedTokens;
            turnCacheWrite += cache.cacheWriteTokens;
            turnCost += cost.totalCost;
            turnContextTokens = Math.max(turnContextTokens, logicalTokens, contextPromptTokens);
          }
        } catch (err) {
          if (opts.signal?.aborted || !isTimeoutError(err)) {
            throw err;
          }
          turnLatency = Math.round(performance.now() - startedAt);
          turnContextTokens = tokenizer.countMessages(initialOutbound);
          const recoveryNote = `Turn ${turn.turnIndex} timed out after retries; recovered to preserve benchmark run`;
          maintenanceNotes.push(recoveryNote);
          opts.onMaintenance?.(recoveryNote);
          responseMessages = [
            {
              role: "assistant",
              content: "[Turn timed out waiting for model response; continuing session.]"
            }
          ];
        }
      }

      turnMessages.push(...chatRecordsFor(responseMessages, turn.turnIndex));
      messages.push(...responseMessages.map((message) => {
        if (!isGemma4 || !message.reasoning) return message;
        const { reasoning: _, ...withoutReasoning } = message;
        return withoutReasoning;
      }));
      if (lastProviderPromptTokens >= Math.ceil(windowTokens * AUTO_COMPACTION_FILL)) {
        await maintainAtLimit(lastProviderPromptTokens);
      }

      let probeOutcome: ProbeOutcome | undefined;
      const assistant = lastAssistant(responseMessages) ?? lastAssistant(messages);
      if (turn.isProbe && turn.expectedKeywords && turn.expectedKeywords.length > 0) {
        const answer = assistant?.content ?? "";
        const evalProbe = evaluateProbeAnswer(answer, turn.expectedKeywords, turn.staleKeywords);
        probeOutcome = {
          probeId: turn.probeId ?? `probe-t${turn.turnIndex}`,
          turnIndex: turn.turnIndex,
          passed: evalProbe.passed,
          expectedKeywords: turn.expectedKeywords,
          ...(turn.staleKeywords ? { staleKeywords: turn.staleKeywords } : {}),
          matchedKeywords: evalProbe.matched,
          missingKeywords: evalProbe.missing,
          ...(evalProbe.staleMatched.length > 0 ? { staleMatchedKeywords: evalProbe.staleMatched } : {}),
          responseSnippet: answer.slice(0, 240)
        };
        probeOutcomes.push(probeOutcome);
      }

      const shouldForce = opts.compactEvery != null && opts.compactEvery > 0
        ? turn.turnIndex % opts.compactEvery === 0
        : false;
      const maint = await runtime.autoMaintain(messages, windowTokens, shouldForce);
      if (maint.acted && maint.note) {
        maintenanceNotes.push(maint.note);
        opts.onMaintenance?.(maint.note);
      }

      const turnAddedTokens = turnMessages.reduce((sum, message) => sum + countFreshMessageTokens(message, !isGemma4, tokenizer), 0);
      const turnInputAdded = (i === 0 ? initialContextTokens : 0) + turnAddedTokens;
      const actualContextTokens = turnContextTokens > 0 ? turnContextTokens : turnInputAdded;
      const rawCumulativeTokens = tokenizer.countMessages(messages);
      peakContextTokens = Math.max(peakContextTokens, actualContextTokens);
      totalPrompt += turnPrompt > 0 ? turnPrompt : actualContextTokens;
      totalCompletion += turnCompletion;
      totalCached += turnCached;
      totalCacheWrite += turnCacheWrite;
      totalCost += turnCost;

      const assistantSnippet = (assistant?.content ?? "").trim().slice(0, 300);
      const turnMetric: TurnMetricRecord = {
        turnIndex: turn.turnIndex,
        userMessage: turn.userMessage,
        assistantSnippet,
        isProbe: Boolean(turn.isProbe),
        probeOutcome,
        promptTokens: turnInputAdded,
        completionTokens: turnCompletion,
        cachedTokens: turnCached,
        cacheWriteTokens: turnCacheWrite,
        contextTokens: actualContextTokens,
        rawHistoryTokens: rawCumulativeTokens,
        cacheHitRate: turnPrompt > 0 ? Math.min(1, turnCached / turnPrompt) : 0,
        latencyMs: turnLatency,
        cost: turnCost,
        maintenanceNote: maintenanceNotes.length ? maintenanceNotes.join("; ") : undefined,
        toolCallsCount: toolCallsForTurn
      };
      trajectory.push(turnMetric);
      opts.onTurnEnd?.(turnMetric);

      const chatTurn: ChatTurnRecord = {
        turnIndex: turn.turnIndex,
        userMessage: turn.userMessage,
        isProbe: Boolean(turn.isProbe),
        probeOutcome,
        messages: turnMessages,
        maintenanceNote: maintenanceNotes.length ? maintenanceNotes.join("; ") : undefined,
        metrics: {
          promptTokens: turnInputAdded,
          completionTokens: turnCompletion,
          cachedTokens: turnCached,
          cacheWriteTokens: turnCacheWrite,
          cacheHitRate: turnPrompt > 0 ? Math.min(1, turnCached / turnPrompt) : 0,
          contextTokens: actualContextTokens,
          latencyMs: turnLatency
        }
      };
      chatTranscript.push(chatTurn);
      opts.onChatTurn?.(chatTurn);
    }

    // Bill the compaction summarizer like any other model call (omp's soft/handoff
    // pay this every cycle). Each summarizer call re-sends the transcript under a
    // fresh system prompt, so its input is uncached fresh input, not a cache
    // continuation of the task loop's prefix.
    if (summaryUsage.inputTokens > 0 || summaryUsage.outputTokens > 0) {
      const summaryCost = estimateLlmCost(
        GPT_5_6_SOL_PRICING,
        summaryUsage.inputTokens,
        0,
        0,
        summaryUsage.outputTokens
      );
      totalPrompt += summaryUsage.inputTokens;
      totalCompletion += summaryUsage.outputTokens;
      totalCost += summaryCost.totalCost;
    }

    const evalResult = await evaluateScenario({
      scenario: opts.scenario,
      scale: opts.scale,
      sandbox,
      // Mock simulations must never spin up real Docker/Playwright infrastructure:
      // container criteria report "unavailable" instead of launching a container.
      skipContainer: Boolean(opts.mock)
    });

    const probePassedCount = probeOutcomes.filter((probe) => probe.passed).length;
    const probeTotalCount = probeOutcomes.length;
    const probeScore = probeTotalCount > 0 ? probePassedCount / probeTotalCount : 1;
    const rawHistoryTokens = tokenizer.countMessages(messages);
    const finalContextTokens = trajectory.at(-1)?.contextTokens
      ?? tokenizer.countMessages(runtime.prepareOutbound(messages, windowTokens));
    const cacheHitPct = totalPrompt > 0 ? Math.min(1, totalCached / totalPrompt) * 100 : 0;
    const billedTokens = Math.max(0, totalPrompt - totalCached) + totalCompletion;
    const wallClockMs = Math.round(performance.now() - tStart);

    const result: AgenticRunResult = {
      mode: opts.scenario.mode,
      scale: opts.scale,
      strategy: opts.strategy,
      model: opts.model,
      pricingModel: opts.pricingModel ?? GPT_5_6_SOL_PRICING.id,
      totalTurns: turns.length,
      completedTurns: trajectory.length,
      rubricScore: evalResult.rubricScore,
      rubricPassedCount: evalResult.rubricPassedCount,
      rubricFailedCount: evalResult.rubricFailedCount,
      rubricTotalCount: evalResult.rubricTotalCount,
      rubricEvaluatedCount: evalResult.evaluableCount,
      rubricUnavailableCount: evalResult.unavailableCount,
      rubricErrorCount: evalResult.errorCount,
      evaluationPrerequisites: evalResult.prerequisites,
      rubricDetails: evalResult.rubricDetails,
      probeScore,
      probePassedCount,
      probeTotalCount,
      probeDetails: probeOutcomes,
      tokens: {
        totalPrompt,
        totalCompletion,
        totalCached,
        totalCacheWrite,
        cacheHitPct,
        billedTokens,
        peakContextTokens,
        finalContextTokens,
        rawHistoryTokens
      },
      cost: totalCost,
      wallClockMs,
      trajectory,
      chatTranscript,
      strategyTelemetry: runtime.telemetry(),
      tokenizerTelemetry: tokenizer.telemetry(),
      verificationSummary: opts.scenario.verifyWorkspace(sandbox),
      workspaceDir: workspace
    };

    if (!opts.cleanupWorkspace || opts.workspaceDir) {
      sandbox.exportToDisk(workspace, { onlyChanged: true });
    }

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

function generateMockCompletion(turn: ScenarioTurn, messages: LlmMessage[], sandbox: Sandbox): MockCompletion {
  const lastUser = messages.at(-1)?.content ?? "";
  if (turn.isProbe && turn.expectedKeywords) {
    return {
      content: `Recall Answer: The requested information contains ${turn.expectedKeywords.join(", ")}.`,
      promptTokens: 1200,
      completionTokens: 80,
      cachedTokens: 900,
      latencyMs: 15
    };
  }
  if (/pac-man|game\.js|maze|pellet|ghost/i.test(lastUser)) {
    try {
      const existing = sandbox.exists("game.js") ? sandbox.read("game.js") : "";
      sandbox.write("game.js", `${existing}\n// Features implemented\nconst canvas = document.createElement('canvas'); requestAnimationFrame(() => {});\nconst maze = { grid: [], walls: [], map: [] };\nconst pacman = { x: 0, y: 0, direction: 'right', speed: 2, move() {} };\nconst pellets = []; const powerPellets = []; let score = 0;\nconst ghosts = [{ name: 'blinky', color: 'red', mode: 'chase', target() {} }, { name: 'pinky', color: 'pink', mode: 'ambush', ahead() {} }, { name: 'inky', color: 'cyan', mode: 'flank', vector() {} }, { name: 'clyde', color: 'orange', mode: 'scatter', distance() {} }];\nlet lives = 3; function respawn() {} function reset() {}\nlet level = 1; function nextLevel() {} function clear() {}\nlocalStorage.setItem('highScore', score);\nconst audioCtx = window.AudioContext ? new AudioContext() : null; function playSound() {}\nwindow.addEventListener('keydown', (e) => { if (e.code === 'ArrowUp' || e.code === 'KeyW') pacman.direction = 'up'; });\nfunction checkGameOver() { if (lives <= 0) return 'game over'; if (pellets.length === 0) return 'victory'; }\n`);
    } catch {
      // Mock mode is intentionally best effort.
    }
    return { content: "Implemented core Pac-Man engine features in game.js.", promptTokens: 1500, completionTokens: 120, cachedTokens: 1100, latencyMs: 20 };
  }
  if (/audit|vuln|src\//i.test(lastUser)) {
    try {
      sandbox.write("AUDIT_REPORT.md", "# Security Audit Report\n- SQL Injection in src/db/users.js\n- Path Traversal in src/api/files.js\n- Command Injection in src/utils/media.js\n- Hardcoded Secret in src/config/auth.js\n- Stored XSS in src/api/comments.js\n- BOLA / IDOR in src/api/orders.js\n");
    } catch {
      // Mock mode is intentionally best effort.
    }
    return { content: "Compiled vulnerability findings into AUDIT_REPORT.md.", promptTokens: 1400, completionTokens: 90, cachedTokens: 1050, latencyMs: 18 };
  }
  if (/matrix|architecture|validate/i.test(lastUser)) {
    try {
      sandbox.write("src/matrix.ts", "export function matrixAdd() {}\nexport function matrixMultiply() {}\n");
      sandbox.write("tests/matrix.test.ts", "import { test, expect } from 'bun:test';\ntest('matrix', () => expect(true).toBe(true));\n");
      const existing = sandbox.exists("docs/ARCHITECTURE.md") ? sandbox.read("docs/ARCHITECTURE.md") : "# Architecture\n";
      sandbox.write("docs/ARCHITECTURE.md", `${existing}\n\n## Matrix Operations\nComprehensive matrix math module documentation and usage examples.\n`);
    } catch {
      // Mock mode is intentionally best effort.
    }
    return { content: "Implemented matrix modules and updated architecture documentation.", promptTokens: 1300, completionTokens: 85, cachedTokens: 980, latencyMs: 16 };
  }
  return { content: "Task completed successfully and verified.", promptTokens: 1000, completionTokens: 50, cachedTokens: 800, latencyMs: 10 };
}
