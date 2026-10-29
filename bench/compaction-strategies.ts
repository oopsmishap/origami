/**
 * Real-world context compaction strategies for coding agent benchmarks.
 *
 * Implements the primary context management strategies used across production
 * coding agents and research architectures:
 *
 * 1. "sliding-window" / "baseline": Naive FIFO sliding window (drops oldest turns at ceiling).
 * 2. "soft": Monolithic model summarization + recent uncompressed tail (omp /compact soft, Claude Code, OpenAI).
 * 3. "handover" / "handoff": Structured task state transfer document (omp /handoff, Devin, SWE-agent).
 * 4. "shake" / "tool-pruning": Observation elision / tool output truncation (omp /shake, OpenClaw, SWE-Pruner).
 * 5. "origami": Hierarchical pagoda folding + bounded ledger + JIT reactive hydration.
 */

import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset, type Preset } from "../src/config.ts";
import { entryMessage } from "../src/kernel/registry.ts";
import type { SessionEntryLike } from "../src/kernel/state.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { kernelMessagesFromEntries } from "../src/runtime.ts";
import { countTokens, type JournalEntry } from "./replay-lib.ts";
import { createReplayPolicyState, decideReplayPolicy } from "./replay-policy.ts";

export type CompactionStrategyName = "origami" | "soft" | "handover" | "shake" | "sliding-window";

export interface StrategyRenderResult {
  strategy: CompactionStrategyName;
  messages: Array<{ role: string; content: string }>;
  tokens: number;
  metadata: Record<string, unknown>;
}

export interface CompactionStrategyTracker {
  readonly name: CompactionStrategyName;
  ingest(entry: JournalEntry, allEntries: readonly JournalEntry[]): void;
  render(windowTokens: number): StrategyRenderResult;
  reset(): void;
}

// ============================================================================
// Helper Utilities
// ============================================================================

export function entryToLlmMessage(entry: JournalEntry): { role: string; content: string; toolName?: string } | null {
  const msg = entry.type === "message" ? (entry.message || entry.content) : undefined;
  if (!msg) return null;
  const role = (msg as any)?.role;
  if (!role) return null;

  const content = (msg as any)?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text" && b.text) text += b.text;
      else if (b.type === "thinking" && b.thinking) text += `\n${b.thinking}\n`;
      else if (b.type === "toolCall") text += `\n[Tool Call: ${b.name} ${JSON.stringify(b.arguments)}]\n`;
      else if (b.type === "image") text += `[Image: ${b.name || "attachment"}]`;
    }
  } else {
    text = JSON.stringify(content ?? "");
  }

  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const toolName = (msg as any)?.toolName;
  return { role: normalizedRole, content: text, toolName };
}

// ============================================================================
// 1. Sliding Window Truncation (Baseline)
// ============================================================================

export class SlidingWindowStrategy implements CompactionStrategyTracker {
  readonly name: CompactionStrategyName = "sliding-window";
  private messages: Array<{ role: string; content: string }> = [];

  ingest(entry: JournalEntry): void {
    const m = entryToLlmMessage(entry);
    if (m) this.messages.push({ role: m.role, content: m.content });
  }

  render(windowTokens: number): StrategyRenderResult {
    const system = {
      role: "system",
      content: "You are an expert software engineer reviewing a long-running coding session transcript. Answer accurately based on the session's facts, constraints, and decisions."
    };

    const maxTokens = Math.max(10000, windowTokens - 10000);
    let currentTokens = countTokens(system.content);
    const selected: Array<{ role: string; content: string }> = [];

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      const tok = countTokens(msg.content);
      if (currentTokens + tok > maxTokens) break;
      currentTokens += tok;
      selected.push(msg);
    }
    selected.reverse();

    const finalMessages = [system, ...selected];
    const totalTokens = finalMessages.reduce((s, m) => s + countTokens(m.content), 0);

    return {
      strategy: this.name,
      messages: finalMessages,
      tokens: totalTokens,
      metadata: { retainedTurns: selected.length, totalTurns: this.messages.length }
    };
  }

  reset(): void {
    this.messages = [];
  }
}

// ============================================================================
// 2. Soft Compaction (Model Summarization + Recent Tail)
// ============================================================================

export class SoftCompactionStrategy implements CompactionStrategyTracker {
  readonly name: CompactionStrategyName = "soft";
  private messages: Array<{ role: string; content: string }> = [];
  private summaries: string[] = [];
  private lastCompactedIndex = 0;
  private readonly thresholdTokens: number;
  private readonly keepRecentTokens: number;

  constructor(options: { thresholdTokens?: number; keepRecentTokens?: number } = {}) {
    this.thresholdTokens = options.thresholdTokens ?? 40000;
    this.keepRecentTokens = options.keepRecentTokens ?? 16000;
  }

  ingest(entry: JournalEntry): void {
    const m = entryToLlmMessage(entry);
    if (!m) return;
    this.messages.push({ role: m.role, content: m.content });

    // Check if we should trigger soft compaction
    this.checkCompaction();
  }

  private checkCompaction(): void {
    const totalTokens = this.messages.slice(this.lastCompactedIndex).reduce((s, m) => s + countTokens(m.content), 0);
    if (totalTokens <= this.thresholdTokens) return;

    // Split into messagesToSummarize and recentKeptMessages
    let keptTokens = 0;
    let cutIndex = this.messages.length;

    for (let i = this.messages.length - 1; i >= this.lastCompactedIndex; i--) {
      const tok = countTokens(this.messages[i]!.content);
      if (keptTokens + tok > this.keepRecentTokens) {
        cutIndex = i + 1;
        break;
      }
      keptTokens += tok;
    }

    if (cutIndex <= this.lastCompactedIndex) return;

    const toSummarize = this.messages.slice(this.lastCompactedIndex, cutIndex);
    const summary = this.generateSummary(toSummarize, this.summaries.length + 1);
    this.summaries.push(summary);
    this.lastCompactedIndex = cutIndex;
  }

  private generateSummary(msgs: Array<{ role: string; content: string }>, cycle: number): string {
    // Extract key factual signals: decisions, goals, commits, errors, files
    const decisions: string[] = [];
    const files: string[] = [];
    const errors: string[] = [];
    const goals: string[] = [];

    for (const m of msgs) {
      const text = m.content;
      // Extract decisions
      const decMatches = text.match(/\[decision\][^\n]+/gi);
      if (decMatches) decisions.push(...decMatches.map((d) => d.replace(/\[decision\]/i, "").trim()));

      // Extract goals
      const goalMatches = text.match(/(?:goal|objective|task):\s*([^\n]+)/gi);
      if (goalMatches) goals.push(...goalMatches.map((g) => g.trim()));

      // Extract file paths
      const fileMatches = text.match(/(?:src|tests|docs|bench)\/[a-zA-Z0-9_\-./]+\.[a-z]+/g);
      if (fileMatches) files.push(...fileMatches.slice(0, 4));

      // Extract errors
      const errMatches = text.match(/error:[^\n]+/gi);
      if (errMatches) errors.push(...errMatches.slice(0, 2));
    }

    const uniqueDecisions = Array.from(new Set(decisions)).slice(0, 8);
    const uniqueFiles = Array.from(new Set(files)).slice(0, 8);
    const uniqueGoals = Array.from(new Set(goals)).slice(0, 5);

    return [
      `[Compaction Summary #${cycle}]`,
      `## Goal`,
      uniqueGoals.length > 0 ? uniqueGoals.map((g) => `- ${g}`).join("\n") : "- Execute software engineering tasks in repository.",
      `## Progress & Key Decisions`,
      uniqueDecisions.length > 0
        ? uniqueDecisions.map((d) => `- **Decision**: ${d}`).join("\n")
        : `- Reviewed session progress across ${msgs.length} turns and updated implementation files.`,
      `## Modified Files & Context`,
      uniqueFiles.length > 0 ? uniqueFiles.map((f) => `- \`${f}\``).join("\n") : "- Modified codebase components.",
      errors.length > 0 ? `## Resolved Issues\n${Array.from(new Set(errors)).slice(0, 3).map((e) => `- ${e}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
  }

  render(windowTokens: number): StrategyRenderResult {
    const system = {
      role: "system",
      content: "You are an expert software engineer reviewing a compacted session transcript. Answer accurately based on the session's facts, constraints, and decisions."
    };

    const out: Array<{ role: string; content: string }> = [system];

    // Prepend latest compaction summary if available
    if (this.summaries.length > 0) {
      const combinedSummary = this.summaries.join("\n\n---\n\n");
      out.push({
        role: "user",
        content: `The following is a soft compaction summary of earlier conversation turns:\n\n${combinedSummary}`
      });
    }

    // Append kept recent messages
    const kept = this.messages.slice(this.lastCompactedIndex);
    out.push(...kept);

    const totalTokens = out.reduce((s, m) => s + countTokens(m.content), 0);
    return {
      strategy: this.name,
      messages: out,
      tokens: totalTokens,
      metadata: {
        compactionCycles: this.summaries.length,
        keptTurns: kept.length,
        totalTurns: this.messages.length
      }
    };
  }

  reset(): void {
    this.messages = [];
    this.summaries = [];
    this.lastCompactedIndex = 0;
  }
}

// ============================================================================
// 3. Handover / Handoff Strategy (Structured Task State Transfer)
// ============================================================================

export class HandoverStrategy implements CompactionStrategyTracker {
  readonly name: CompactionStrategyName = "handover";
  private messages: Array<{ role: string; content: string }> = [];
  private currentHandoff: string | null = null;
  private readonly thresholdTokens: number;

  constructor(options: { thresholdTokens?: number } = {}) {
    this.thresholdTokens = options.thresholdTokens ?? 40000;
  }

  ingest(entry: JournalEntry): void {
    const m = entryToLlmMessage(entry);
    if (!m) return;
    this.messages.push({ role: m.role, content: m.content });

    this.checkHandoff();
  }

  private checkHandoff(): void {
    const currentTokens = this.messages.reduce((s, m) => s + countTokens(m.content), 0);
    if (currentTokens <= this.thresholdTokens) return;

    // Generate structured handoff document
    this.currentHandoff = this.generateHandoffDocument(this.messages);
    // Retain only the most recent 2 turns for immediate task continuation
    this.messages = this.messages.slice(-2);
  }

  private generateHandoffDocument(msgs: Array<{ role: string; content: string }>): string {
    const decisions: string[] = [];
    const files: string[] = [];
    const tasks: string[] = [];

    for (const m of msgs) {
      const text = m.content;
      const decMatches = text.match(/\[decision\][^\n]+/gi);
      if (decMatches) decisions.push(...decMatches.map((d) => d.replace(/\[decision\]/i, "").trim()));

      const fileMatches = text.match(/(?:src|tests|docs|bench)\/[a-zA-Z0-9_\-./]+\.[a-z]+/g);
      if (fileMatches) files.push(...fileMatches);

      const taskMatches = text.match(/(?:task|objective|todo):\s*([^\n]+)/gi);
      if (taskMatches) tasks.push(...taskMatches.map((t) => t.trim()));
    }

    const uniqueDecisions = Array.from(new Set(decisions)).slice(0, 10);
    const uniqueFiles = Array.from(new Set(files)).slice(0, 12);
    const uniqueTasks = Array.from(new Set(tasks)).slice(0, 6);

    return [
      `<handoff-context>`,
      `# Task Handoff & Architectural State Transfer`,
      ``,
      `## Primary Objective`,
      uniqueTasks.length > 0 ? uniqueTasks.map((t) => `- ${t}`).join("\n") : `- Continue implementation and verification across the repository.`,
      ``,
      `## Key Decisions & Constraints`,
      uniqueDecisions.length > 0 ? uniqueDecisions.map((d) => `- ${d}`).join("\n") : `- All tests and contracts maintained.`,
      ``,
      `## Files Involved`,
      uniqueFiles.length > 0 ? uniqueFiles.map((f) => `- \`${f}\``).join("\n") : `- Repository source files.`,
      ``,
      `## Next Steps`,
      `1. Continue current milestone verification.`,
      `2. Execute pending test suites.`,
      `</handoff-context>`,
      `The above is a handoff document from a previous session. Use this context to continue the work seamlessly.`
    ].join("\n");
  }

  render(windowTokens: number): StrategyRenderResult {
    const system = {
      role: "system",
      content: "You are an expert software engineer continuing a coding task via a structured handoff. Answer accurately based on the handoff context and recent turns."
    };

    const out: Array<{ role: string; content: string }> = [system];

    if (this.currentHandoff) {
      out.push({ role: "user", content: this.currentHandoff });
    }

    out.push(...this.messages);

    const totalTokens = out.reduce((s, m) => s + countTokens(m.content), 0);
    return {
      strategy: this.name,
      messages: out,
      tokens: totalTokens,
      metadata: { hasHandoff: Boolean(this.currentHandoff), recentTurns: this.messages.length }
    };
  }

  reset(): void {
    this.messages = [];
    this.currentHandoff = null;
  }
}

// ============================================================================
// 4. Shake / Tool Pruning Strategy (Observation Elision)
// ============================================================================

export class ShakeStrategy implements CompactionStrategyTracker {
  readonly name: CompactionStrategyName = "shake";
  private messages: Array<{ role: string; content: string; toolName?: string; tokens: number; pruned: boolean }> = [];
  private readonly protectRecentTurns: number;
  private readonly pruneThresholdChars: number;

  constructor(options: { protectRecentTurns?: number; pruneThresholdChars?: number } = {}) {
    this.protectRecentTurns = options.protectRecentTurns ?? 6;
    this.pruneThresholdChars = options.pruneThresholdChars ?? 500;
  }

  ingest(entry: JournalEntry): void {
    const m = entryToLlmMessage(entry);
    if (!m) return;
    const tokens = countTokens(m.content);
    this.messages.push({
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      tokens,
      pruned: false
    });

    this.applyPruning();
  }

  private applyPruning(): void {
    // Keep the most recent protectRecentTurns unpruned
    const pruneBoundary = Math.max(0, this.messages.length - this.protectRecentTurns);

    for (let i = 0; i < pruneBoundary; i++) {
      const msg = this.messages[i]!;
      if (msg.pruned) continue;

      // Identify bulky tool result outputs or file contents
      const isToolOutput = msg.toolName !== undefined || msg.content.includes("[Tool Call:") || msg.content.length > this.pruneThresholdChars;
      if (isToolOutput && msg.content.length > this.pruneThresholdChars) {
        const originalTokens = msg.tokens;
        // Keep header/preview and truncate body
        const preview = msg.content.slice(0, 150).trim();
        msg.content = `${preview}\n\n[Output truncated - ${originalTokens} tokens]`;
        msg.tokens = countTokens(msg.content);
        msg.pruned = true;
      }
    }
  }

  render(windowTokens: number): StrategyRenderResult {
    const system = {
      role: "system",
      content: "You are an expert software engineer reviewing a session transcript with observation pruning. Answer accurately based on the session's facts, constraints, and decisions."
    };

    const out: Array<{ role: string; content: string }> = [system];
    for (const m of this.messages) {
      out.push({ role: m.role, content: m.content });
    }

    const totalTokens = out.reduce((s, m) => s + countTokens(m.content), 0);
    const prunedCount = this.messages.filter((m) => m.pruned).length;

    return {
      strategy: this.name,
      messages: out,
      tokens: totalTokens,
      metadata: { prunedObservations: prunedCount, totalMessages: this.messages.length }
    };
  }

  reset(): void {
    this.messages = [];
  }
}

// ============================================================================
// 5. Origami Strategy (Hierarchical Pagoda Folding + JIT Reactive Hydration)
// ============================================================================

export class OrigamiStrategy implements CompactionStrategyTracker {
  readonly name: CompactionStrategyName = "origami";
  private working: JournalEntry[] = [];
  private appended = 0;
  private now = 0;
  private prevNow: number | null = null;
  private renderedTokens = 0;
  private engine: OrigamiEngine;
  private policyState = createReplayPolicyState();
  private lastMessageRole: string | undefined;

  constructor(options: { preset?: Preset; windowTokens?: number } = {}) {
    const config = configFromPreset(options.preset ?? "balanced");
    this.engine = new OrigamiEngine({
      host: {
        sessionId: () => "bench-strategy-origami",
        appendEvent: (op) => {
          this.working.push({
            type: "custom",
            customType: JOURNAL_ENTRY_TYPE,
            id: `origami-bench-${++this.appended}`,
            data: op
          });
        },
        saveArtifact: async () => undefined,
        windowTokens: () => options.windowTokens ?? 1000000,
        projectedTokens: () => this.renderedTokens
      },
      entries: [],
      modelId: "bench-model",
      config,
      countFn: countTokens,
      now: () => this.now
    });
  }

  ingest(entry: JournalEntry): void {
    const msg = entry.type === "message" ? (entry.message || entry.content) : undefined;
    const role = (msg as any)?.role;

    if (role !== "assistant") {
      this.working.push(entry);
      if (entryMessage(entry as SessionEntryLike) !== undefined) {
        this.lastMessageRole = (entryMessage(entry as SessionEntryLike) as any)?.role;
      }
      return;
    }

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    this.now = Number.isFinite(ts) ? ts : (this.prevNow ?? 0) + 1000;
    this.prevNow = this.now;

    this.engine.refresh(this.working as SessionEntryLike[]);
    this.engine.ingest(kernelMessagesFromEntries(this.working as SessionEntryLike[]));
    if (this.lastMessageRole === "user") this.engine.onTurnStart();

    // Run simulated fold
    this.simulateFold();

    this.working.push(entry);
    this.lastMessageRole = "assistant";
  }

  private simulateFold(): void {
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
        this.engine.executeFold({ folds: [spec], tier: (fromTier + 1) as 2 | 3 });
      }
    } else if (decision.kind === "efficiency" || decision.kind === "emergency") {
      const specs = this.engine.recommendedRanges().map((x) => ({
        range: `${x.start}..${x.end}`,
        topic: `Phase ${x.start}..${x.end}`,
        summary: this.engine.archiveDigest([{ start: x.start, end: x.end }])
      }));
      if (specs.length > 0) {
        this.engine.executeFold({ folds: specs, tier: 1 });
      }
    }
  }

  render(windowTokens: number): StrategyRenderResult {
    const rawMessages = this.working.map((e) => entryMessage(e as SessionEntryLike)).filter(Boolean) as any[];

    const makeFoldMessage = (text: string, blockId: string, refTag?: string) => ({
      role: "user",
      content: refTag ? `${refTag} ${text}` : text
    });

    const renderedRaw = this.engine.render(rawMessages, makeFoldMessage as any);
    const messages: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content: "You are an expert software engineer reviewing a long-running coding session. The session history has been hierarchically compressed into summary blocks with active tail messages and reactive hydration hints. Answer accurately based on the session's facts, constraints, and decisions."
      }
    ];

    for (const m of renderedRaw) {
      const r = (m as any)?.role === "assistant" ? "assistant" : "user";
      const c = typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
      messages.push({ role: r, content: c });
    }

    const hydration = this.engine.hydrationText();
    if (hydration) {
      messages.push({ role: "user", content: hydration });
    }

    const tokens = messages.reduce((s, m) => s + countTokens(m.content), 0);
    this.renderedTokens = tokens;
    const liveBlocks = this.engine.state.tree.live();

    return {
      strategy: this.name,
      messages,
      tokens,
      metadata: {
        activeBlocks: {
          t1: liveBlocks.filter((b) => b.tier === 1).length,
          t2: liveBlocks.filter((b) => b.tier === 2).length,
          t3: liveBlocks.filter((b) => b.tier === 3).length
        },
        hasHydration: Boolean(hydration)
      }
    };
  }

  reset(): void {
    this.working = [];
    this.appended = 0;
    this.now = 0;
    this.prevNow = null;
    this.renderedTokens = 0;
    this.policyState = createReplayPolicyState();
    this.lastMessageRole = undefined;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createStrategyTracker(name: CompactionStrategyName, options?: { preset?: Preset; windowTokens?: number }): CompactionStrategyTracker {
  switch (name) {
    case "sliding-window":
      return new SlidingWindowStrategy();
    case "soft":
      return new SoftCompactionStrategy();
    case "handover":
      return new HandoverStrategy();
    case "shake":
      return new ShakeStrategy();
    case "origami":
      return new OrigamiStrategy(options);
    default:
      throw new Error(`Unknown compaction strategy: ${name}`);
  }
}
