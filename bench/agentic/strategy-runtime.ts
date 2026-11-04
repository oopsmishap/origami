/**
 * Strategy-specific compaction runtimes for the agentic benchmark.
 *
 * Each strategy provides:
 * 1. Compaction tools exposed to the agent (fold, compact, handoff, shake).
 * 2. System prompt instructions explaining how the agent should manage its context.
 * 3. `autoMaintain`: automatic threshold-triggered maintenance between turns.
 * 4. `prepareOutbound`: outbound message filtering / truncation before calling the model.
 * 5. Telemetry & metrics tracking.
 */

import { countLlmMessageTokens, type LlmMessage, type LlmToolSpec } from "./llm.ts";
import { type BenchmarkTokenizer, getDefaultTokenizer } from "./tokenizer.ts";
import { OrigamiEngine } from "../../src/engine.ts";
import { parseRangeList } from "../../src/engine-ranges.ts";
import { configFromPreset, type Preset } from "../../src/config.ts";
import { openDb, type OrigamiDb } from "../../src/persist/db.ts";
import { JOURNAL_ENTRY_TYPE } from "../../src/persist/journal.ts";
import { expandRefRange } from "../../src/kernel/render.ts";
import { entryMessage } from "../../src/kernel/registry.ts";
import type { KernelMessage } from "../../src/kernel/types.ts";
import { kernelMessagesFromEntries } from "../../src/runtime.ts";
import type { SessionEntryLike } from "../../src/kernel/state.ts";
import { type JournalEntry } from "../replay-lib.ts";
import { createReplayPolicyState, decideReplayPolicy } from "../replay-policy.ts";

export type CompactionStrategyName = "origami" | "soft" | "handover" | "shake" | "sliding-window";
export const AUTO_COMPACTION_FILL = 0.80;

export interface StrategyTelemetry {
  strategy: CompactionStrategyName;
  compactionEvents: number;
  toolInvocations: number;
  tokensReclaimed: number;
  activeBlocks?: { t1: number; t2: number; t3: number };
  details: Record<string, unknown>;
}

export interface CompactionRuntime {
  readonly strategy: CompactionStrategyName;
  /** Extra tools this strategy adds to the agent's palette. */
  toolSpecs(): LlmToolSpec[];
  /** Extra system instructions explaining this strategy's context tools. */
  systemInstructions(): string;
  /** Execute an agent compaction tool call. Returns output string. */
  handleTool(name: string, args: Record<string, unknown>, messages: LlmMessage[]): string;
  /** Automatic maintenance hook called after an agent turn ends. */
  autoMaintain(messages: LlmMessage[], windowTokens: number, force?: boolean): { acted: boolean; note?: string };
  /** Prepares outbound messages for the LLM call (e.g. host-side sliding window). */
  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[];
  /** Metrics snapshot. */
  telemetry(): StrategyTelemetry;
}

function boundedOutbound(messages: LlmMessage[], windowTokens: number, tokenizer?: BenchmarkTokenizer): LlmMessage[] {
  if (messages.length === 0) return [];
  const maxTokens = Math.max(10_000, windowTokens - 8_000);
  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const body = system ? messages.slice(1) : messages;
  let tokens = system ? countLlmMessageTokens(system, tokenizer) : 0;
  const kept: LlmMessage[] = [];

  for (let i = body.length - 1; i >= 0; i--) {
    const message = body[i]!;
    const messageTokens = countLlmMessageTokens(message, tokenizer);
    if (kept.length > 0 && tokens + messageTokens > maxTokens) break;
    kept.push(message);
    tokens += messageTokens;
  }
  kept.reverse();
  while (kept.length > 0 && kept[0]?.role !== "user") kept.shift();

  const selectedCallIds = new Set<string>();
  for (const message of kept) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) selectedCallIds.add(call.id);
    }
  }

  const result: LlmMessage[] = [];
  for (const message of kept) {
    if (message.role === "tool") {
      if (message.tool_call_id && selectedCallIds.has(message.tool_call_id)) result.push(message);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolCalls = message.tool_calls.filter((call) => kept.some(
        (candidate) => candidate.role === "tool" && candidate.tool_call_id === call.id,
      ));
      result.push(toolCalls.length === message.tool_calls.length ? message : {
        ...message,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : { tool_calls: undefined })
      });
      continue;
    }
    result.push(message);
  }

  return system ? [system, ...result] : result;
}

// ============================================================================
// 1. Sliding Window Strategy (Baseline)
// ============================================================================

export class SlidingWindowRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "sliding-window";
  private droppedTurns = 0;
  private readonly tokenizer: BenchmarkTokenizer;

  constructor(opts: { tokenizer?: BenchmarkTokenizer } = {}) {
    this.tokenizer = opts.tokenizer ?? getDefaultTokenizer();
  }

  toolSpecs(): LlmToolSpec[] {
    return [];
  }

  systemInstructions(): string {
    return "Context management: Older conversation history is truncated automatically when approaching the context ceiling.";
  }

  handleTool(): string {
    return "sliding-window has no compaction tools; truncation is host-side.";
  }

  autoMaintain(messages: LlmMessage[], windowTokens: number, force = false): { acted: boolean; note?: string } {
    const before = messages.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    if (!force && before < Math.ceil(windowTokens * AUTO_COMPACTION_FILL)) return { acted: false };
    const kept = boundedOutbound(messages, Math.floor(windowTokens * 0.7) + 8_000, this.tokenizer);
    const after = kept.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    if (after >= before) return { acted: false };
    messages.splice(0, messages.length, ...kept);
    this.droppedTurns++;
    return { acted: true, note: `Sliding-window dropped ${before - after} estimated tokens` };
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    return boundedOutbound(messages, windowTokens, this.tokenizer);
  }

  telemetry(): StrategyTelemetry {
    return {
      strategy: this.strategy,
      compactionEvents: this.droppedTurns,
      toolInvocations: 0,
      tokensReclaimed: 0,
      details: { droppedTurns: this.droppedTurns }
    };
  }
}

// ============================================================================
// 2. Soft Compaction Strategy (omp /compact soft, Claude Code)
// ============================================================================

export class SoftCompactionRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "soft";
  private compactions = 0;
  private toolCalls = 0;
  private tokensReclaimed = 0;
  private readonly thresholdTokens: number;
  private readonly keepRecentTokens: number;
  private readonly tokenizer: BenchmarkTokenizer;

  constructor(opts: { thresholdTokens?: number; keepRecentTokens?: number; tokenizer?: BenchmarkTokenizer } = {}) {
    this.thresholdTokens = opts.thresholdTokens ?? 40_000;
    this.keepRecentTokens = opts.keepRecentTokens ?? 16_000;
    this.tokenizer = opts.tokenizer ?? getDefaultTokenizer();
  }

  toolSpecs(): LlmToolSpec[] {
    return [
      {
        type: "function",
        function: {
          name: "compact",
          description: "Compact older conversation turns into a structured summary to reclaim context window headroom.",
          parameters: {
            type: "object",
            properties: {
              focus: { type: "string", description: "Optional specific decisions, files, or tasks to emphasize in the summary" }
            }
          }
        }
      }
    ];
  }

  systemInstructions(): string {
    return [
      "Context management: Use the `compact` tool when the conversation becomes long to summarize older turns.",
      "A structured summary will replace older history while keeping your recent turns verbatim."
    ].join(" ");
  }

  handleTool(name: string, args: Record<string, unknown>, messages: LlmMessage[]): string {
    if (name !== "compact") return `unknown tool: ${name}`;
    this.toolCalls++;
    const res = this.performCompaction(messages, args.focus ? String(args.focus) : undefined);
    return res.summary;
  }

  autoMaintain(messages: LlmMessage[], windowTokens: number, force = false): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    const trigger = Math.round(windowTokens * AUTO_COMPACTION_FILL);
    if (force || totalTokens >= trigger) {
      const res = this.performCompaction(messages);
      if (res.reclaimed > 0) {
        return { acted: true, note: `Soft-compacted older turns (${res.reclaimed.toLocaleString()} tokens reclaimed)` };
      }
    }
    return { acted: false };
  }

  private performCompaction(messages: LlmMessage[], focus?: string): { reclaimed: number; summary: string } {
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    let keptTokens = 0;
    let cut = body.length;
    for (let i = body.length - 1; i >= 0; i--) {
      const tok = countLlmMessageTokens(body[i]!, this.tokenizer);
      if (keptTokens + tok > this.keepRecentTokens) {
        cut = i + 1;
        break;
      }
      keptTokens += tok;
    }

    if (cut <= 2) return { reclaimed: 0, summary: "Context is already compact; no turns to summarize." };

    const toSummarize = body.slice(0, cut);
    const beforeTokens = toSummarize.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);

    // Extract facts
    const decisions: string[] = [];
    const files: string[] = [];
    const tasks: string[] = [];

    for (const m of toSummarize) {
      for (const line of m.content.split("\n")) {
        const trimmed = line.trim();
        if (/decision/i.test(trimmed)) decisions.push(trimmed.slice(0, 200));
        if (/src\/|tests\/|docs\/|game|vuln/i.test(trimmed)) files.push(trimmed.slice(0, 150));
        if (/task|objective|goal|step/i.test(trimmed)) tasks.push(trimmed.slice(0, 200));
      }
    }

    const summaryText = [
      `[Soft Compaction Summary #${++this.compactions}]`,
      focus ? `Focused on: ${focus}` : null,
      `## Progress & Done`,
      tasks.length > 0 ? Array.from(new Set(tasks)).slice(0, 6).map((t) => `- ${t}`).join("\n") : "- Continued task execution.",
      `## Key Decisions & Constraints`,
      decisions.length > 0 ? Array.from(new Set(decisions)).slice(0, 8).map((d) => `- ${d}`).join("\n") : "- Followed architectural requirements.",
      `## Active Files`,
      files.length > 0 ? Array.from(new Set(files)).slice(0, 8).map((f) => `- ${f}`).join("\n") : "- Workspace files updated."
    ].filter(Boolean).join("\n\n");

    const afterTokens = this.tokenizer.countText(summaryText);
    const reclaimed = Math.max(0, beforeTokens - afterTokens);
    this.tokensReclaimed += reclaimed;

    const summaryMessage: LlmMessage = {
      role: "user",
      content: `Earlier conversation was compacted:\n\n${summaryText}`
    };

    // Splice in place
    const kept = body.slice(cut);
    messages.length = 0;
    if (system) messages.push(system);
    messages.push(summaryMessage, ...kept);

    return { reclaimed, summary: `Compacted ${toSummarize.length} turns into structured summary. Reclaimed ~${reclaimed} tokens.` };
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    return boundedOutbound(messages, windowTokens, this.tokenizer);
  }

  telemetry(): StrategyTelemetry {
    return {
      strategy: this.strategy,
      compactionEvents: this.compactions,
      toolInvocations: this.toolCalls,
      tokensReclaimed: this.tokensReclaimed,
      details: { cycles: this.compactions }
    };
  }
}

// ============================================================================
// 3. Handover / Handoff Strategy (omp /handoff, Devin, SWE-agent)
// ============================================================================

export class HandoverRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "handover";
  private handoffs = 0;
  private toolCalls = 0;
  private tokensReclaimed = 0;
  private readonly thresholdTokens: number;
  private readonly tokenizer: BenchmarkTokenizer;

  constructor(opts: { thresholdTokens?: number; tokenizer?: BenchmarkTokenizer } = {}) {
    this.thresholdTokens = opts.thresholdTokens ?? 35_000;
    this.tokenizer = opts.tokenizer ?? getDefaultTokenizer();
  }

  toolSpecs(): LlmToolSpec[] {
    return [
      {
        type: "function",
        function: {
          name: "handoff",
          description: "Generate a structured task handoff document that captures goals, decisions, files, and next actions, then resets previous chat history.",
          parameters: {
            type: "object",
            properties: {
              goal: { type: "string", description: "The immediate next task or goal for the continuation session" }
            },
            required: ["goal"]
          }
        }
      }
    ];
  }

  systemInstructions(): string {
    return [
      "Context management: Only invoke the `handoff` tool when context grows substantially large or a major multi-phase milestone completes.",
      "Do NOT invoke `handoff` after routine single-turn edits, because each handoff resets prior conversational history to a summary document."
    ].join(" ");
  }

  handleTool(name: string, args: Record<string, unknown>, messages: LlmMessage[]): string {
    if (name !== "handoff") return `unknown tool: ${name}`;
    this.toolCalls++;
    const res = this.performHandoff(messages, String(args.goal ?? "Continue milestone tasks."), false);
    return res.message;
  }

  autoMaintain(messages: LlmMessage[], windowTokens: number, force = false): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    const trigger = Math.round(windowTokens * AUTO_COMPACTION_FILL);
    if (force || totalTokens >= trigger) {
      const res = this.performHandoff(messages, "Periodic 80% context boundary handoff.", true);
      if (res.reclaimed > 0) {
        return { acted: true, note: `Auto-handed off context (${res.reclaimed.toLocaleString()} tokens reclaimed)` };
      }
    }
    return { acted: false };
  }

  private performHandoff(messages: LlmMessage[], goal: string, forced = false): { reclaimed: number; message: string } {
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    const beforeTokens = body.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    if (body.length <= 3) return { reclaimed: 0, message: "Context too small to justify handoff." };
    if (!forced && beforeTokens < Math.min(this.thresholdTokens, 8_000)) {
      return {
        reclaimed: 0,
        message: `Context is compact (~${beforeTokens.toLocaleString()} tokens); continue in the current session without resetting history.`
      };
    }
    const decisions: string[] = [];
    const files: string[] = [];

    for (const m of body) {
      for (const line of m.content.split("\n")) {
        const trimmed = line.trim();
        if (/decision|rule|choice/i.test(trimmed)) decisions.push(trimmed.slice(0, 160));
        if (/src\/|tests\/|docs\/|game|app/i.test(trimmed)) files.push(trimmed.slice(0, 120));
      }
    }

    const handoffDoc = [
      `<handoff-context>`,
      `# Task Handoff #${++this.handoffs}`,
      `## Next Goal`,
      `- ${goal}`,
      `## Key Decisions & Constraints`,
      decisions.length > 0 ? Array.from(new Set(decisions)).slice(0, 8).map((d) => `- ${d}`).join("\n") : "- Maintain existing code conventions.",
      `## Modified Files`,
      files.length > 0 ? Array.from(new Set(files)).slice(0, 8).map((f) => `- ${f}`).join("\n") : "- Repository workspace files.",
      `</handoff-context>`,
      `The above is a handoff document from the prior session. Continue the work seamlessly.`
    ].join("\n");

    const afterTokens = this.tokenizer.countText(handoffDoc);
    const reclaimed = Math.max(0, beforeTokens - afterTokens);
    this.tokensReclaimed += reclaimed;

    // Retain only system + handoffDoc + last 2 active messages
    const tail = body.slice(-2);
    messages.length = 0;
    if (system) messages.push(system);
    messages.push({ role: "user", content: handoffDoc }, ...tail);

    return { reclaimed, message: `Created handoff #${this.handoffs}. Reset history to handoff state, reclaiming ~${reclaimed} tokens.` };
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    return boundedOutbound(messages, windowTokens, this.tokenizer);
  }

  telemetry(): StrategyTelemetry {
    return {
      strategy: this.strategy,
      compactionEvents: this.handoffs,
      toolInvocations: this.toolCalls,
      tokensReclaimed: this.tokensReclaimed,
      details: { handoffs: this.handoffs }
    };
  }
}

// ============================================================================
// 4. Shake / Tool Pruning Strategy (omp /shake, OpenClaw, SWE-Pruner)
// ============================================================================

export class ShakeRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "shake";
  private shakes = 0;
  private toolCalls = 0;
  private tokensReclaimed = 0;
  private prunedMessages = 0;
  private readonly protectRecentTurns: number;
  private readonly tokenizer: BenchmarkTokenizer;

  constructor(opts: { protectRecentTurns?: number; tokenizer?: BenchmarkTokenizer } = {}) {
    this.protectRecentTurns = opts.protectRecentTurns ?? 6;
    this.tokenizer = opts.tokenizer ?? getDefaultTokenizer();
  }
  toolSpecs(): LlmToolSpec[] {
    return [
      {
        type: "function",
        function: {
          name: "shake",
          description: "Elide older bulky tool outputs (file reads, command outputs) without summarizing conversation text.",
          parameters: { type: "object", properties: {} }
        }
      }
    ];
  }

  systemInstructions(): string {
    return "Context management: Use the `shake` tool to prune older heavy tool results while keeping conversation dialog intact.";
  }

  handleTool(name: string, _args: Record<string, unknown>, messages: LlmMessage[]): string {
    if (name !== "shake") return `unknown tool: ${name}`;
    this.toolCalls++;
    const res = this.applyShake(messages);
    return `Shook context: pruned ${res.pruned} heavy observations, reclaiming ~${res.reclaimed} tokens.`;
  }

  autoMaintain(messages: LlmMessage[], windowTokens: number, force = false): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    const trigger = Math.round(windowTokens * AUTO_COMPACTION_FILL);
    if (force || totalTokens >= trigger) {
      const res = this.applyShake(messages);
      if (res.pruned > 0) {
        return { acted: true, note: `Auto-shook ${res.pruned} tool results (${res.reclaimed.toLocaleString()} tokens reclaimed)` };
      }
    }
    return { acted: false };
  }

  private applyShake(messages: LlmMessage[]): { pruned: number; reclaimed: number } {
    let pruned = 0;
    let reclaimed = 0;
    const boundary = Math.max(0, messages.length - this.protectRecentTurns);

    for (let i = 0; i < boundary; i++) {
      const m = messages[i]!;
      if (m.role === "tool" || m.content.includes("lines ") || m.content.includes("read_file") || m.content.length > 800) {
        if (!m.content.includes("[Output truncated")) {
          const originalTokens = this.tokenizer.countText(m.content);
          const preview = m.content.slice(0, 180).trim();
          m.content = `${preview}\n\n[Output truncated - ${originalTokens} tokens elided]`;
          const newTokens = this.tokenizer.countText(m.content);
          reclaimed += Math.max(0, originalTokens - newTokens);
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      this.shakes++;
      this.prunedMessages += pruned;
      this.tokensReclaimed += reclaimed;
    }
    return { pruned, reclaimed };
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    return boundedOutbound(messages, windowTokens, this.tokenizer);
  }

  telemetry(): StrategyTelemetry {
    return {
      strategy: this.strategy,
      compactionEvents: this.shakes,
      toolInvocations: this.toolCalls,
      tokensReclaimed: this.tokensReclaimed,
      details: { prunedObservations: this.prunedMessages }
    };
  }
}

// ============================================================================
// 5. Origami Strategy (Pagoda Folding + Bounded Ledger + JIT Hydration)
// ============================================================================

export class OrigamiRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "origami";
  private toolCalls = 0;
  private readonly db: OrigamiDb;
  private engine: OrigamiEngine;
  private working: JournalEntry[] = [];
  private cachedKernel: KernelMessage[] = [];
  private cachedRaw: unknown[] = [];
  private lastRefreshedLen = -1;
  private appended = 0;
  private syncedMessages = 0;
  private now = 0;
  private policyState = createReplayPolicyState();
  private lastHydrationInjected = false;
  private hydrationInjections = 0;
  private nudgeInjections = 0;
  private projectedTokens = 0;
  private readonly tokenizer: BenchmarkTokenizer;

  constructor(opts: { preset?: Preset; windowTokens?: number; forceThresholds?: boolean; tokenizer?: BenchmarkTokenizer } = {}) {
    this.tokenizer = opts.tokenizer ?? getDefaultTokenizer();
    this.db = openDb(":memory:");
    const baseConfig = configFromPreset(opts.preset ?? "balanced");
    const config = opts.forceThresholds
      ? { ...baseConfig, emergencyFillPct: AUTO_COMPACTION_FILL, protectedTailTokens: 0, minFoldBenefitTokens: 0, compressibleFloor: 0, minFoldBenefitWindowPct: 0 }
      : { ...baseConfig, emergencyFillPct: AUTO_COMPACTION_FILL };
    this.engine = new OrigamiEngine({
      host: {
        sessionId: () => "agentic-origami",
        appendEvent: (op) => {
          this.working.push({
            type: "custom",
            customType: JOURNAL_ENTRY_TYPE,
            id: `origami-${++this.appended}`,
            data: op
          });
        },
        saveArtifact: async () => undefined,
        windowTokens: () => opts.windowTokens ?? 1_000_000,
        projectedTokens: () => this.projectedTokens
      },
      entries: [],
      modelId: "agentic-model",
      config,
      countFn: (input: string) => this.tokenizer.countText(input),
      now: () => this.now
    });
    this.engine.attachDb(this.db);
  }

  toolSpecs(): LlmToolSpec[] {
    return [
      {
        type: "function",
        function: {
          name: "fold",
          description: "Fold a contiguous range of completed messages into a hierarchical summary block to preserve prompt cache and free context headroom.",
          parameters: {
            type: "object",
            properties: {
              range: { type: "string", description: 'Range specifier: message range (e.g. "m00010..m00030") for tier 1, or block ids (e.g. "b1..b3") for tier 2/3' },
              topic: { type: "string", description: "One-line domain topic (<=60 chars)" },
              summary: { type: "string", description: "Dense, factual summary of the folded span" },
              tier: { type: "number", enum: [1, 2, 3], description: "Fold tier: 1 for raw messages, 2 or 3 for merging blocks" }
            },
            required: ["range", "topic", "summary"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fold_search",
          description: "Search earlier folded history across block topics, summaries, and archived original messages.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search terms or keywords" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fold_recall",
          description: "Read exact original archived messages by ref or range (e.g. 'm00004..m00008') without inflating persistent context.",
          parameters: {
            type: "object",
            properties: {
              refs: { type: "string", description: 'Ref or comma-separated range list, e.g. "m00004..m00008"' }
            },
            required: ["refs"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fold_status",
          description: "Report active context occupancy, token split, growth since last fold, and active pagoda blocks.",
          parameters: { type: "object", properties: {} }
        }
      }
    ];
  }

  systemInstructions(): string {
    return [
      "Context folding (origami): This session uses Origami incremental hierarchical compression.",
      "Completed turns are folded into compact summary blocks to maintain immutable prompt-cache prefix stability.",
      "Only call `fold` using exact message boundaries advertised in `[origami]` notices.",
      "When asked a recall question about an earlier briefing or policy key (e.g. `[SYMBOL_NAME]`) not visible verbatim in active context, ALWAYS call `fold_search` (and `fold_recall` on returned message refs, honoring the highest turn number when a policy was later overridden) before answering."
    ].join(" ");
  }

  handleTool(name: string, args: Record<string, unknown>): string {
    this.toolCalls++;
    switch (name) {
      case "fold": {
        const range = String(args.range ?? "");
        const rawTier = Number(args.tier ?? (/^b\d+/i.test(range.trim()) ? 2 : 1));
        const tier: 1 | 2 | 3 = rawTier === 3 ? 3 : rawTier === 2 ? 2 : 1;
        const spec = {
          range,
          tier,
          topic: String(args.topic ?? ""),
          summary: String(args.summary ?? "")
        };
        const res = this.engine.executeFold({ folds: [spec], tier });
        if (res.ok) {
          const b = res.outcome.blocks[0];
          const snapNote = res.outcome.snapped && res.outcome.snapped.length > 0
            ? ` (snapped: ${res.outcome.snapped.join("; ")})`
            : "";
          return `Folded ${spec.range} into block ${b?.id ?? "b"} (reclaimed ${res.outcome.tokensReclaimed} tokens)${snapNote}.`;
        }
        return `Fold rejected: ${res.error}`;
      }
      case "fold_search": {
        const query = String(args.query ?? "");
        const blockHits = this.engine.search(query, 5);
        const messageHits = [...this.engine.searchMessages(query, 10)].sort((a, b) => b.turn - a.turn);
        const sections: string[] = [];
        if (blockHits.length > 0) {
          sections.push(
            "Blocks:\n" +
              blockHits.map((h) => `[${h.blockId} · tier ${h.tier}] ${h.topic}\n${h.snippet}`).join("\n\n")
          );
        }
        const archivedRefSet = new Set(messageHits.map((m) => m.ref));
        if (messageHits.length > 0) {
          const newestTurn = messageHits[0]!.turn;
          const recalledByRef = new Map(
            this.engine.recall(messageHits.slice(0, 6).map((m) => m.ref))
              .filter((r) => r.text !== null)
              .map((r) => [r.ref, r.text!])
          );
          sections.push(
            "Archived Messages (newest turn first; pass refs to fold_recall for full text):\n" +
              messageHits.map((m) => {
                const full = recalledByRef.get(m.ref);
                const preview = full ? full.replace(/\s+/g, " ").trim().slice(0, 420) : m.snippet;
                return `[#${m.ref} · turn ${m.turn}${m.turn === newestTurn && messageHits.length > 1 ? " · LATEST ARCHIVED" : ""} · ${m.role}] ${preview}`;
              }).join("\n")
          );
        }
        const terms = query.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length >= 3);
        if (terms.length > 0) {
          const liveMatches = this.engine.state.bound
            .filter((m) => !m.ephemeral && !archivedRefSet.has(m.ref) && terms.some((t) => m.text.toLowerCase().includes(t)))
            .sort((a, b) => b.turn - a.turn)
            .slice(0, 5);
          if (liveMatches.length > 0) {
            sections.push(
              "Live Unfolded Context Matches (newest turn first):\n" +
                liveMatches.map((m) => `[#${m.ref} · turn ${m.turn} · ${m.role}] ${m.text.replace(/\s+/g, " ").slice(0, 220)}`).join("\n")
            );
          }
        }
        if (sections.length === 0) return `(no matches for "${query}")`;
        return sections.join("\n\n");
      }
      case "fold_recall": {
        const rawRefs = String(args.refs ?? "");
        const parsed = parseRangeList(rawRefs);
        const expanded = parsed.length > 0
          ? parsed.flatMap((r) => expandRefRange(r.start, r.end)).slice(0, 40)
          : rawRefs.split(/[\s,]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean).slice(0, 40);
        if (expanded.length === 0) return "(no valid refs provided)";
        const rows = this.engine.recall(expanded);
        const found = rows.filter((r) => r.text !== null);
        if (found.length === 0) return `(no messages found for refs: ${rawRefs})`;
        return found.map((r) => `[#${r.ref} · ${r.role} · ${r.source}]\n${r.text}`).join("\n\n");
      }
      case "fold_status": {
        const live = this.engine.state.tree.live();
        const t1 = live.filter((b) => b.tier === 1).length;
        const t2 = live.filter((b) => b.tier === 2).length;
        const t3 = live.filter((b) => b.tier === 3).length;
        return `Origami Status: ${live.length} active blocks (T1: ${t1}, T2: ${t2}, T3: ${t3}), growth: ${this.engine.growthSinceFold()} tokens.`;
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  autoMaintain(messages: LlmMessage[], windowTokens = 1_000_000, force = false): { acted: boolean; note?: string } {
    const active = this.prepareOutbound(messages, windowTokens + 8_000);
    this.projectedTokens = active.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    if (force) this.projectedTokens = Math.max(this.projectedTokens, Math.ceil(windowTokens * AUTO_COMPACTION_FILL));
    const thresholdForce = force || this.projectedTokens >= Math.ceil(windowTokens * AUTO_COMPACTION_FILL);
    const decision = decideReplayPolicy("current", this.engine, this.policyState);
    const notes: string[] = [];

    const tryPromote = (fromTier: 1 | 2, forcePromo: boolean): boolean => {
      const blocks = this.engine.state.tree.live().filter((b) => b.tier === fromTier);
      if (blocks.length < (forcePromo ? 2 : 4)) return false;
      const batch = forcePromo ? blocks : blocks.slice(0, Math.max(2, blocks.length - 1));
      if (batch.length < 2) return false;
      const range = batch.map((b) => b.id).join(",");
      const summaryLines = batch.map((b) => {
        const firstLine = b.summary.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("[…")) ?? "";
        return `- [${b.id}] ${b.topic}${firstLine ? `: ${firstLine.slice(0, 180)}` : ""}`;
      });
      const spec = {
        range,
        tier: (fromTier + 1) as 2 | 3,
        topic: `Consolidated ${batch[0]!.id}..${batch.at(-1)!.id}`,
        summary: summaryLines.join("\n")
      };
      const res = this.engine.executeFold({ folds: [spec], tier: (fromTier + 1) as 2 | 3, force: forcePromo });
      if (res.ok) {
        notes.push(`Origami promoted ${range} to Tier ${fromTier + 1}`);
        return true;
      }
      return false;
    };

    if (decision.kind === "promotion" && decision.promotion) {
      tryPromote(decision.promotion.fromTier, true);
    }

    if (decision.kind === "efficiency" || decision.kind === "emergency" || thresholdForce) {
      const specs = this.engine.recommendedRanges(1).map((x) => ({
        range: `${x.start}..${x.end}`,
        topic: `Phase ${x.start}..${x.end}`,
        summary: this.engine.archiveDigest([{ start: x.start, end: x.end }], 120, 3200)
      }));
      if (specs.length > 0) {
        const res = this.engine.executeFold({ folds: specs, tier: 1, force: thresholdForce });
        if (res.ok) {
          notes.push(`Origami folded ${specs.length} range(s) into Tier 1`);
        }
      }

      // Consolidate accumulated Tier-1 / Tier-2 blocks so summary mass never saturates the window
      const liveT1 = this.engine.state.tree.live().filter((b) => b.tier === 1);
      const postFoldActive = this.prepareOutbound(messages, windowTokens + 8_000);
      const postFoldTokens = postFoldActive.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
      const needsTierConsolidation = liveT1.length >= 4 || (thresholdForce && postFoldTokens >= Math.ceil(windowTokens * AUTO_COMPACTION_FILL * 0.85));
      if (needsTierConsolidation) {
        tryPromote(1, true);
      }
      const liveT2 = this.engine.state.tree.live().filter((b) => b.tier === 2);
      if (liveT2.length >= 4) {
        tryPromote(2, true);
      }
    }

    if (notes.length > 0) {
      return { acted: true, note: notes.join("; ") };
    }
    return { acted: false };
  }

  private syncEngine(messages: LlmMessage[]): void {
    if (messages.length < this.syncedMessages) {
      // Rebuild cleanly if caller passed a shorter history snapshot
      const customEntries = this.working.filter((e) => e.type === "custom");
      this.working = [];
      this.cachedKernel = [];
      this.cachedRaw = [];
      this.syncedMessages = 0;
      this.lastRefreshedLen = -1;
      for (let i = 0; i < messages.length; i++) {
        this.appendWorkingMessage(messages[i]!, i);
      }
      this.syncedMessages = messages.length;
      this.working.push(...customEntries);
    } else if (messages.length > this.syncedMessages) {
      for (let i = this.syncedMessages; i < messages.length; i++) {
        this.appendWorkingMessage(messages[i]!, i);
      }
      this.syncedMessages = messages.length;
    }

    if (this.working.length !== this.lastRefreshedLen) {
      this.engine.refresh(this.working as SessionEntryLike[]);
      this.engine.ingest(this.cachedKernel);
      this.lastRefreshedLen = this.working.length;
    }
  }

  private appendWorkingMessage(m: LlmMessage, idx: number): void {
    const role = m.role === "tool" ? "toolResult" : m.role;
    const toolCallId = m.tool_call_id;
    const entry: JournalEntry = {
      type: "message",
      id: `msg-${idx + 1}`,
      timestamp: new Date().toISOString(),
      message: {
        role,
        content: m.content,
        reasoning: m.reasoning,
        tool_calls: m.tool_calls,
        toolCallId,
        tool_call_id: toolCallId,
        name: m.name
      }
    };
    this.working.push(entry);
    const rawMsg = entryMessage(entry as SessionEntryLike);
    if (rawMsg) this.cachedRaw.push(rawMsg);
    const km = kernelMessagesFromEntries([entry as SessionEntryLike]);
    if (km.length > 0) this.cachedKernel.push(...km);
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    this.syncEngine(messages);
    if (this.cachedRaw.length === 0) return boundedOutbound(messages, windowTokens, this.tokenizer);
    const rawMessages = this.cachedRaw;
    const makeFoldMessage = (text: string, blockId: string, refTag?: string) => ({
      role: "user",
      content: refTag ? `${refTag} ${text}` : text
    });

    const renderedRaw = this.engine.render(rawMessages, makeFoldMessage as any) as any[];
    const out: LlmMessage[] = [];

    // System prompt
    const system = messages.find((m) => m.role === "system");
    if (system) out.push(system);

    for (const m of renderedRaw) {
      if (m.role === "system") continue;
      const r = m.role === "assistant" ? "assistant" : (m.role === "tool" || m.role === "toolResult") ? "tool" : "user";
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const msg: LlmMessage = { role: r, content: c };
      if (m.reasoning) msg.reasoning = m.reasoning;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      const toolCallId = m.tool_call_id || m.toolCallId;
      if (toolCallId) msg.tool_call_id = toolCallId;
      if (m.name) msg.name = m.name;
      out.push(msg);
    }

    // At user turn boundaries, inject Origami efficiency/promotion nudges and JIT hydration/recall hints
    // directly before the trailing user message so the prompt prefix remains monotonic and cacheable.
    const isUserBoundary = messages.length > 0 && messages[messages.length - 1]?.role === "user";
    this.lastHydrationInjected = false;
    if (isUserBoundary) {
      const ephemeralNotices: string[] = [];
      const nudgeDecision = this.engine.decideNudge();
      const nudgeText = nudgeDecision.text ?? this.engine.nudgeText;
      if (nudgeText) {
        ephemeralNotices.push(nudgeText);
        this.nudgeInjections++;
        if ((nudgeDecision.text ? nudgeDecision.kind : this.engine.nudgeTextKind) === "emergency") {
          this.engine.noteEmergencySent();
        }
      }
      const hydration = this.engine.hydrationText();
      if (hydration) {
        this.lastHydrationInjected = true;
        this.hydrationInjections++;
        ephemeralNotices.push(hydration);
      } else {
        const hint = this.engine.recallHintText();
        if (hint) ephemeralNotices.push(hint);
      }
      if (ephemeralNotices.length > 0) {
        const combinedNotice = ephemeralNotices.join("\n\n");
        const lastUserIdx = out.findLastIndex((m) => m.role === "user");
        if (lastUserIdx >= 0) {
          out.splice(lastUserIdx, 0, { role: "user", content: combinedNotice });
        } else {
          out.push({ role: "user", content: combinedNotice });
        }
      }
    }

    const availableToolResultIds = new Set<string>();
    for (const m of out) {
      if (m.role === "tool" && m.tool_call_id) {
        availableToolResultIds.add(m.tool_call_id);
      }
    }

    const availableAssistantCallIds = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && m.tool_calls) {
        m.tool_calls = m.tool_calls.filter((tc) => availableToolResultIds.has(tc.id));
        if (m.tool_calls.length === 0) {
          delete m.tool_calls;
        } else {
          for (const tc of m.tool_calls) availableAssistantCallIds.add(tc.id);
        }
      }
    }

    const sanitizedOut = out.filter((m) => {
      if (m.role === "tool") {
        return m.tool_call_id ? availableAssistantCallIds.has(m.tool_call_id) : false;
      }
      return true;
    });

    const bounded = boundedOutbound(sanitizedOut, windowTokens, this.tokenizer);
    this.projectedTokens = bounded.reduce((sum, message) => sum + countLlmMessageTokens(message, this.tokenizer), 0);
    return bounded;
  }

  telemetry(): StrategyTelemetry {
    const live = this.engine.state.tree.live();
    const allBlocks = this.engine.state.tree.all();
    const t1 = live.filter((b) => b.tier === 1).length;
    const t2 = live.filter((b) => b.tier === 2).length;
    const t3 = live.filter((b) => b.tier === 3).length;

    return {
      strategy: this.strategy,
      compactionEvents: allBlocks.length,
      toolInvocations: this.toolCalls,
      tokensReclaimed: this.engine.status().tokenSplit.foldedSavings ?? 0,
      activeBlocks: { t1, t2, t3 },
      details: {
        growthSinceFold: this.engine.growthSinceFold(),
        hydrationInjected: this.hydrationInjections > 0 || this.lastHydrationInjected,
        hydrationCount: this.hydrationInjections,
        nudgeCount: this.nudgeInjections
      }
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createCompactionRuntime(
  strategy: CompactionStrategyName,
  opts?: { preset?: Preset; windowTokens?: number; forceThresholds?: boolean; tokenizer?: BenchmarkTokenizer }
): CompactionRuntime {
  switch (strategy) {
    case "sliding-window":
      return new SlidingWindowRuntime(opts);
    case "soft":
      return new SoftCompactionRuntime(opts);
    case "handover":
      return new HandoverRuntime(opts);
    case "shake":
      return new ShakeRuntime(opts);
    case "origami":
      return new OrigamiRuntime(opts);
    default:
      throw new Error(`Unknown compaction strategy: ${strategy}`);
  }
}
