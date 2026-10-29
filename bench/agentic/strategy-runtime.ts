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

import type { LlmMessage, LlmToolSpec } from "./llm.ts";
import { OrigamiEngine } from "../../src/engine.ts";
import { configFromPreset, type Preset } from "../../src/config.ts";
import { JOURNAL_ENTRY_TYPE } from "../../src/persist/journal.ts";
import { entryMessage } from "../../src/kernel/registry.ts";
import { kernelMessagesFromEntries } from "../../src/runtime.ts";
import type { SessionEntryLike } from "../../src/kernel/state.ts";
import { countTokens, type JournalEntry } from "../replay-lib.ts";
import { createReplayPolicyState, decideReplayPolicy } from "../replay-policy.ts";

export type CompactionStrategyName = "origami" | "soft" | "handover" | "shake" | "sliding-window";

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
  autoMaintain(messages: LlmMessage[], windowTokens: number): { acted: boolean; note?: string };
  /** Prepares outbound messages for the LLM call (e.g. host-side sliding window). */
  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[];
  /** Metrics snapshot. */
  telemetry(): StrategyTelemetry;
}

// ============================================================================
// 1. Sliding Window Strategy (Baseline)
// ============================================================================

export class SlidingWindowRuntime implements CompactionRuntime {
  readonly strategy: CompactionStrategyName = "sliding-window";
  private droppedTurns = 0;

  toolSpecs(): LlmToolSpec[] {
    return [];
  }

  systemInstructions(): string {
    return "Context management: Older conversation history is truncated automatically when approaching the context ceiling.";
  }

  handleTool(): string {
    return "sliding-window has no compaction tools; truncation is host-side.";
  }

  autoMaintain(): { acted: boolean } {
    return { acted: false };
  }

  prepareOutbound(messages: LlmMessage[], windowTokens: number): LlmMessage[] {
    if (messages.length === 0) return [];
    const maxTokens = Math.max(10_000, windowTokens - 8_000);
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    let accTokens = system ? countTokens(system.content) : 0;
    const kept: LlmMessage[] = [];

    for (let i = body.length - 1; i >= 0; i--) {
      const m = body[i]!;
      const tok = countTokens(m.content);
      if (accTokens + tok > maxTokens) {
        this.droppedTurns++;
        break;
      }
      accTokens += tok;
      kept.push(m);
    }
    kept.reverse();
    return system ? [system, ...kept] : kept;
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

  constructor(opts: { thresholdTokens?: number; keepRecentTokens?: number } = {}) {
    this.thresholdTokens = opts.thresholdTokens ?? 40_000;
    this.keepRecentTokens = opts.keepRecentTokens ?? 16_000;
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

  autoMaintain(messages: LlmMessage[], windowTokens: number): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
    const trigger = Math.min(this.thresholdTokens, Math.round(windowTokens * 0.75));
    if (totalTokens > trigger) {
      const res = this.performCompaction(messages);
      return { acted: true, note: `Soft-compacted older turns (${res.reclaimed.toLocaleString()} tokens reclaimed)` };
    }
    return { acted: false };
  }

  private performCompaction(messages: LlmMessage[], focus?: string): { reclaimed: number; summary: string } {
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    let keptTokens = 0;
    let cut = body.length;
    for (let i = body.length - 1; i >= 0; i--) {
      const tok = countTokens(body[i]!.content);
      if (keptTokens + tok > this.keepRecentTokens) {
        cut = i + 1;
        break;
      }
      keptTokens += tok;
    }

    if (cut <= 2) return { reclaimed: 0, summary: "Context is already compact; no turns to summarize." };

    const toSummarize = body.slice(0, cut);
    const beforeTokens = toSummarize.reduce((s, m) => s + countTokens(m.content), 0);

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

    const afterTokens = countTokens(summaryText);
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

  prepareOutbound(messages: LlmMessage[]): LlmMessage[] {
    return messages;
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

  constructor(opts: { thresholdTokens?: number } = {}) {
    this.thresholdTokens = opts.thresholdTokens ?? 35_000;
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
      "Context management: Use the `handoff` tool to transition task state into a clean session.",
      "Handoff documents preserve architectural decisions, touched files, and the immediate next step while clearing conversational clutter."
    ].join(" ");
  }

  handleTool(name: string, args: Record<string, unknown>, messages: LlmMessage[]): string {
    if (name !== "handoff") return `unknown tool: ${name}`;
    this.toolCalls++;
    const res = this.performHandoff(messages, String(args.goal ?? "Continue milestone tasks."));
    return res.message;
  }

  autoMaintain(messages: LlmMessage[], windowTokens: number): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
    const trigger = Math.min(this.thresholdTokens, Math.round(windowTokens * 0.7));
    if (totalTokens > trigger) {
      const res = this.performHandoff(messages, "Automatic threshold handoff.");
      return { acted: true, note: `Auto-handed off context (${res.reclaimed.toLocaleString()} tokens reclaimed)` };
    }
    return { acted: false };
  }

  private performHandoff(messages: LlmMessage[], goal: string): { reclaimed: number; message: string } {
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const body = system ? messages.slice(1) : messages;

    const beforeTokens = body.reduce((s, m) => s + countTokens(m.content), 0);
    if (body.length <= 3) return { reclaimed: 0, message: "Context too small to justify handoff." };

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

    const afterTokens = countTokens(handoffDoc);
    const reclaimed = Math.max(0, beforeTokens - afterTokens);
    this.tokensReclaimed += reclaimed;

    // Retain only system + handoffDoc + last 2 active messages
    const tail = body.slice(-2);
    messages.length = 0;
    if (system) messages.push(system);
    messages.push({ role: "user", content: handoffDoc }, ...tail);

    return { reclaimed, message: `Created handoff #${this.handoffs}. Reset history to handoff state, reclaiming ~${reclaimed} tokens.` };
  }

  prepareOutbound(messages: LlmMessage[]): LlmMessage[] {
    return messages;
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

  constructor(opts: { protectRecentTurns?: number } = {}) {
    this.protectRecentTurns = opts.protectRecentTurns ?? 6;
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

  autoMaintain(messages: LlmMessage[], windowTokens: number): { acted: boolean; note?: string } {
    const totalTokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
    if (totalTokens > windowTokens * 0.6) {
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
          const originalTokens = countTokens(m.content);
          const preview = m.content.slice(0, 180).trim();
          m.content = `${preview}\n\n[Output truncated - ${originalTokens} tokens elided]`;
          const newTokens = countTokens(m.content);
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

  prepareOutbound(messages: LlmMessage[]): LlmMessage[] {
    return messages;
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
  private engine: OrigamiEngine;
  private working: JournalEntry[] = [];
  private appended = 0;
  private now = 0;
  private policyState = createReplayPolicyState();
  private lastMessageRole: string | undefined;

  constructor(opts: { preset?: Preset; windowTokens?: number } = {}) {
    const config = configFromPreset(opts.preset ?? "balanced");
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
        projectedTokens: () => 0
      },
      entries: [],
      modelId: "agentic-model",
      config,
      countFn: countTokens,
      now: () => this.now
    });
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
              range: { type: "string", description: 'Range specifier, e.g. "m00010..m00030"' },
              topic: { type: "string", description: "One-line domain topic (<=60 chars)" },
              summary: { type: "string", description: "Dense, factual summary of the folded span" }
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
      "Use `fold` to compress finished work, and `fold_search` to query archived history without expanding your prompt."
    ].join(" ");
  }

  handleTool(name: string, args: Record<string, unknown>): string {
    this.toolCalls++;
    switch (name) {
      case "fold": {
        const spec = {
          range: String(args.range ?? ""),
          topic: String(args.topic ?? ""),
          summary: String(args.summary ?? "")
        };
        const res = this.engine.executeFold({ folds: [spec], tier: 1 });
        if (res.ok) {
          const b = res.outcome.blocks[0];
          return `Folded ${spec.range} into block ${b?.id ?? "b"} (reclaimed ${res.outcome.tokensReclaimed} tokens).`;
        }
        return `Fold rejected: ${res.error}`;
      }
      case "fold_search": {
        const query = String(args.query ?? "");
        const hits = this.engine.search(query, 5);
        if (hits.length === 0) return `(no matches for "${query}")`;
        return hits.map((h) => `[${h.blockId}] ${h.topic}\n${h.snippet}`).join("\n\n");
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

  autoMaintain(messages: LlmMessage[]): { acted: boolean; note?: string } {
    // Ingest latest messages into engine
    this.syncEngine(messages);

    const decision = decideReplayPolicy("current", this.engine, this.policyState);
    if (decision.kind === "promotion" && decision.promotion) {
      const fromTier = decision.promotion.fromTier;
      const blocks = this.engine.state.tree.live().filter((b) => b.tier === fromTier);
      if (blocks.length >= 2) {
        const range = blocks.map((b) => b.id).join(",");
        const spec = {
          range,
          tier: (fromTier + 1) as 2 | 3,
          topic: `Consolidated ${blocks[0]!.id}..${blocks.at(-1)!.id}`,
          summary: `- ${blocks.map((b) => b.topic).join("\n- ")}`
        };
        const res = this.engine.executeFold({ folds: [spec], tier: (fromTier + 1) as 2 | 3 });
        if (res.ok) {
          return { acted: true, note: `Origami promoted ${range} to Tier ${fromTier + 1}` };
        }
      }
    } else if (decision.kind === "efficiency" || decision.kind === "emergency") {
      const specs = this.engine.recommendedRanges().map((x) => ({
        range: `${x.start}..${x.end}`,
        topic: `Phase ${x.start}..${x.end}`,
        summary: this.engine.archiveDigest([{ start: x.start, end: x.end }])
      }));
      if (specs.length > 0) {
        const res = this.engine.executeFold({ folds: specs, tier: 1 });
        if (res.ok) {
          return { acted: true, note: `Origami folded ${specs.length} range(s) into Tier 1` };
        }
      }
    }
    return { acted: false };
  }

  private syncEngine(messages: LlmMessage[]): void {
    for (let i = this.working.length; i < messages.length; i++) {
      const m = messages[i]!;
      this.working.push({
        type: "message",
        id: `msg-${i + 1}`,
        timestamp: new Date().toISOString(),
        message: {
          role: m.role,
          content: m.content
        }
      });
    }

    this.engine.refresh(this.working as SessionEntryLike[]);
    this.engine.ingest(kernelMessagesFromEntries(this.working as SessionEntryLike[]));
  }

  prepareOutbound(messages: LlmMessage[]): LlmMessage[] {
    this.syncEngine(messages);
    const rawMessages = this.working.map((e) => entryMessage(e as SessionEntryLike)).filter(Boolean) as any[];
    if (rawMessages.length === 0) return messages;

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
      const r = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      out.push({ role: r, content: c });
    }

    // JIT reactive hydration notice
    const hydration = this.engine.hydrationText();
    if (hydration) {
      out.push({ role: "user", content: hydration });
    }

    return out;
  }

  telemetry(): StrategyTelemetry {
    const live = this.engine.state.tree.live();
    const t1 = live.filter((b) => b.tier === 1).length;
    const t2 = live.filter((b) => b.tier === 2).length;
    const t3 = live.filter((b) => b.tier === 3).length;

    return {
      strategy: this.strategy,
      compactionEvents: live.length,
      toolInvocations: this.toolCalls,
      tokensReclaimed: this.engine.status().tokenSplit.foldedSavings ?? 0,
      activeBlocks: { t1, t2, t3 },
      details: {
        growthSinceFold: this.engine.growthSinceFold(),
        hydrationInjected: Boolean(this.engine.hydrationText())
      }
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createCompactionRuntime(
  strategy: CompactionStrategyName,
  opts?: { preset?: Preset; windowTokens?: number }
): CompactionRuntime {
  switch (strategy) {
    case "sliding-window":
      return new SlidingWindowRuntime();
    case "soft":
      return new SoftCompactionRuntime();
    case "handover":
      return new HandoverRuntime();
    case "shake":
      return new ShakeRuntime();
    case "origami":
      return new OrigamiRuntime(opts);
    default:
      throw new Error(`Unknown compaction strategy: ${strategy}`);
  }
}
