/**
 * Speculative fold candidates (opt-in `speculativeFolds`).
 *
 * After a turn ends, a host side turn (`ctx.runEphemeralTurn`) drafts one tier-1 fold for
 * the best timely range. The side turn shares the session's model, system prompt and
 * history (so the prompt cache stays warm) and is never appended to history. The draft is
 * validated with `planFoldBatch` and surfaced to the main model, which accepts, edits or
 * rejects it via `fold_candidate`. Nothing is folded without the main model's approval.
 */
import type { FoldOutcome, FoldParams, FoldResult, FoldSpec, MessageRow, PlannedFold } from "./engine.ts";
import type { SessionState } from "./kernel/state.ts";
import type { Block } from "./kernel/types.ts";
import { parseBlockRangeList } from "./engine-ranges.ts";
import { contentHash } from "./kernel/hash.ts";
import { formatTokens, type NudgeRange } from "./kernel/nudge.ts";
import type { FoldTiming } from "./kernel/fold-timing.ts";
import { salvageFoldParams } from "./tools/salvage.ts";

export interface CandidateEngineView {
  state: SessionState;
  config: {
    growthStep: number;
    speculativeFolds?: boolean;
    macroCompaction?: "auto" | "review" | "off";
    macroCompactionMinBlocks?: number;
    blockMatureFolds?: number;
  };
  turn: number;
  planFoldBatch(params: FoldParams): { ok: true; planned: PlannedFold[] } | { ok: false; error: string; foldIndex: number };
  executeFold(params: FoldParams): FoldResult;
  recommendedRanges(maxRanges?: number): NudgeRange[];
  foldTiming(ranges: readonly NudgeRange[]): FoldTiming;
  growthSinceFold(): number;
}

export const CANDIDATE_MARKER = "[origami:candidate-request]";
/** A surfaced candidate expires after this many turns without an answer. */
export const CANDIDATE_MAX_AGE_TURNS = 3;

export interface FoldCandidate {
  id: string;
  spec: FoldSpec;
  refs: string[];
  sourceDigest: string;
  createdTurn: number;
  tokensBefore: number;
  tokensAfter: number;
}

export class CandidateStore {
  pending: FoldCandidate | null = null;
  inFlight: AbortController | null = null;
  /** Growth at which the last candidate was rejected or expired; the next waits for half a growth step more. */
  rejectedAtGrowth: number | null = null;
  nextId = 1;
  /** Set when the host cannot run tool-less side turns; speculative folds stay off for the session. */
  disabled = false;
}

export function candidatePrompt(ranges: readonly NudgeRange[]): string {
  return (
    `${CANDIDATE_MARKER} Do not call tools. Write ONE fold for ranges ${ranges.map((r) => `${r.start}..${r.end}`).join(",")} ` +
    `following the folding doctrine (summary, keep). Reply with only JSON: {"range":"…","topic":"…","summary":"…","keep":[…]}`
  );
}

export function parseCandidateReply(reply: string): FoldParams | { error: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "candidate reply contains no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch (error) {
    return { error: `candidate reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const salvaged = salvageFoldParams(raw);
  if (!salvaged.ok) return { error: salvaged.error };
  if (salvaged.params.folds.length !== 1) return { error: `candidate reply must contain exactly one fold, got ${salvaged.params.folds.length}` };
  const tier = salvaged.params.folds[0]?.tier ?? salvaged.params.tier ?? 1;
  return { folds: salvaged.params.folds, tier };
}

export function sourceDigest(texts: readonly string[]): string {
  return contentHash(texts.join("\u0000"));
}

/** Digest of the current bound text of `refs` (missing refs digest as empty strings). */
export function digestRefs(engine: CandidateEngineView, refs: readonly string[]): string {
  const byRef = new Map(engine.state.bound.filter((m) => !m.ephemeral).map((m) => [m.ref, m.text]));
  return sourceDigest(refs.map((r) => byRef.get(r) ?? ""));
}

/** True when the candidate no longer matches the session: a ref was folded or its text changed. */
export function candidateStale(engine: CandidateEngineView, c: FoldCandidate): boolean {
  const tier = c.spec.tier ?? 1;
  if (tier > 1) {
    const liveIds = new Set(engine.state.tree.live().map((b) => b.id));
    const targetBlocks = parseBlockRangeList(c.spec.range);
    return targetBlocks.some((id) => !liveIds.has(id));
  }
  const folded = engine.state.foldedRefs();
  return c.refs.some((r) => folded.has(r)) || digestRefs(engine, c.refs) !== c.sourceDigest;
}

/** Validate a side-turn reply against the current state and build the pending candidate. */
export function buildCandidate(engine: CandidateEngineView, store: CandidateStore, reply: string): FoldCandidate | { error: string } {
  const params = parseCandidateReply(reply);
  if ("error" in params) return params;
  const plan = engine.planFoldBatch(params);
  if (!plan.ok) return { error: plan.error };
  const planned = plan.planned[0]!;
  const spec: FoldSpec = { ...params.folds[0]! };
  if (spec.tier === undefined && params.tier !== undefined) {
    spec.tier = params.tier;
  }
  return {
    id: `c${store.nextId++}`,
    spec,
    refs: planned.refs,
    sourceDigest: digestRefs(engine, planned.refs),
    createdTurn: engine.turn,
    tokensBefore: planned.block.tokensBefore,
    tokensAfter: planned.block.tokensAfter,
  };
}

export function formatCandidate(c: FoldCandidate): string {
  const tier = c.spec.tier ?? 1;
  const tierLabel = tier > 1 ? `tier-${tier} distillation` : "fold";
  return (
    `[origami] A ${tierLabel} was prepared in the background: ${c.id} covers ${c.spec.range} (~${formatTokens(c.tokensBefore)} → ~${formatTokens(c.tokensAfter)} tokens).\n` +
    `Topic: ${c.spec.topic}\n` +
    `${c.spec.summary}\n` +
    `Call fold_candidate {"id":"${c.id}","action":"accept"} if that work is finished, "edit" with your own topic/summary, or "reject".`
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

/** The outbound request is a candidate side turn: its last message is the marked user prompt. */
export function isCandidateRequest(messages: readonly unknown[]): boolean {
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown } | undefined;
  return last?.role === "user" && contentText(last.content).includes(CANDIDATE_MARKER);
}

/** The pending candidate if still valid; expired ones back off generation, stale ones are dropped. */
export function liveCandidate(engine: CandidateEngineView, store: CandidateStore): FoldCandidate | null {
  const c = store.pending;
  if (!c) return null;
  if (engine.turn - c.createdTurn > CANDIDATE_MAX_AGE_TURNS) {
    store.pending = null;
    store.rejectedAtGrowth = engine.growthSinceFold();
    return null;
  }
  if (candidateStale(engine, c)) {
    store.pending = null;
    return null;
  }
  return c;
}

/** Ranges worth drafting a candidate for now, or null when generation should not start. */
export function candidateRanges(engine: CandidateEngineView, store: CandidateStore): NudgeRange[] | null {
  if (store.disabled || store.inFlight || store.pending) return null;
  const ranges = engine.recommendedRanges(4);
  if (ranges.length === 0 || !engine.foldTiming(ranges).allowed) return null;
  if (store.rejectedAtGrowth !== null && engine.growthSinceFold() < store.rejectedAtGrowth + engine.config.growthStep / 2) return null;
  return ranges;
}

export interface ConsolidationCandidate {
  fromTier: 1 | 2;
  toTier: 2 | 3;
  blocks: readonly Block[];
}

export function candidateConsolidation(engine: CandidateEngineView, store: CandidateStore): ConsolidationCandidate | null {
  if (store.disabled || store.inFlight || store.pending) return null;
  const cfg = engine.config;
  if (cfg.macroCompaction === "off") return null;

  const minBlocks = cfg.macroCompactionMinBlocks ?? 3;
  const live = engine.state.tree.live();
  const ages = engine.state.tree.foldAges();
  const matureFolds = cfg.blockMatureFolds ?? 2;

  // 1. Mature tier-1 blocks eligible for tier-2 distillation
  const matureTier1 = live.filter((b) => b.tier === 1 && (ages.get(b.id) ?? 0) >= matureFolds);
  if (matureTier1.length >= minBlocks) {
    return { fromTier: 1, toTier: 2, blocks: matureTier1.slice(0, 6) };
  }

  // 2. Mature tier-2 blocks eligible for tier-3 distillation
  const matureTier2 = live.filter((b) => b.tier === 2 && (ages.get(b.id) ?? 0) >= matureFolds);
  if (matureTier2.length >= minBlocks) {
    return { fromTier: 2, toTier: 3, blocks: matureTier2.slice(0, 4) };
  }

  return null;
}

export function consolidationPrompt(consolidation: ConsolidationCandidate): string {
  const { blocks, toTier } = consolidation;
  const blockList = blocks
    .map((b) => {
      const ledgerItems =
        b.ledger && b.ledger.length > 0
          ? `  Pinned ledger: ${b.ledger.map((l) => `[${l.kind}] ${l.text}`).join("; ")}`
          : "";
      return `- ${b.id} ("${b.topic}"):\n  ${b.summary}${ledgerItems ? `\n${ledgerItems}` : ""}`;
    })
    .join("\n");

  const rangeSpec = `${blocks[0]!.id}..${blocks[blocks.length - 1]!.id}`;
  return (
    `${CANDIDATE_MARKER} Do not call tools. Consolidate these ${blocks.length} active tier-${consolidation.fromTier} blocks into ONE tier-${toTier} distillation covering ${rangeSpec}.\n` +
    `Blocks to consolidate:\n${blockList}\n` +
    `Follow the tier-${toTier} distillation doctrine:\n` +
    `- Write a dense, unified summary (>50% net shrink) capturing the major milestones and decisions.\n` +
    `- Keep load-bearing decisions and architectural constraints in "keep" [{kind, text}].\n` +
    `- Reply with ONLY JSON: {"range":"${rangeSpec}","topic":"…","summary":"…","keep":[…],"tier":${toTier}}`
  );
}

export type CandidateWork =
  | { kind: "tier1"; ranges: readonly NudgeRange[]; prompt: string }
  | { kind: "consolidation"; consolidation: ConsolidationCandidate; prompt: string };

export function candidateWork(engine: CandidateEngineView, store: CandidateStore): CandidateWork | null {
  if (store.disabled || store.inFlight || store.pending) return null;

  // Priority 1: Uncompressed raw history ready for tier-1 fold (if speculativeFolds is enabled)
  if (engine.config.speculativeFolds) {
    const ranges = engine.recommendedRanges(4);
    const timing = ranges.length > 0 ? engine.foldTiming(ranges) : null;
    const tier1Eligible =
      ranges.length > 0 &&
      Boolean(timing?.allowed) &&
      (store.rejectedAtGrowth === null || engine.growthSinceFold() >= store.rejectedAtGrowth + engine.config.growthStep / 2);

    if (tier1Eligible) {
      return { kind: "tier1", ranges, prompt: candidatePrompt(ranges) };
    }
  }

  // Priority 2: Mature blocks eligible for macro-compaction consolidation
  if (engine.config.macroCompaction !== "off") {
    const consolidation = candidateConsolidation(engine, store);
    if (consolidation) {
      return { kind: "consolidation", consolidation, prompt: consolidationPrompt(consolidation) };
    }
  }

  return null;
}

export type RunEphemeralTurn = (options: {
  promptText: string;
  minimizeEffort?: boolean;
  replyMaxBytes?: number;
  signal?: AbortSignal;
}) => Promise<{ replyText: string }>;

/**
 * Draft one candidate in a side turn. Tools are omitted (not `tools: false`) so the request
 * keeps the main prompt cache. Failures are reported, never thrown.
 */
export interface GenerateCandidateOptions {
  onAutoApplied?: (outcome: FoldOutcome, candidate: FoldCandidate) => void;
  onFailure?: (error: string) => void;
  beforeBuild?: () => void;
}

export async function generateCandidate(
  engine: CandidateEngineView,
  store: CandidateStore,
  run: RunEphemeralTurn,
  work: CandidateWork | readonly NudgeRange[],
  options: GenerateCandidateOptions | ((error: string) => void) = {},
  beforeBuildLegacy?: () => void,
): Promise<void> {
  const onFailure = typeof options === "function" ? options : options.onFailure ?? (() => {});
  const onAutoApplied = typeof options === "object" ? options.onAutoApplied : undefined;
  const beforeBuild =
    typeof options === "object"
      ? options.beforeBuild ?? beforeBuildLegacy ?? (() => {})
      : beforeBuildLegacy ?? (() => {});

  const candidateJob: CandidateWork =
    "kind" in work
      ? work
      : { kind: "tier1", ranges: work, prompt: candidatePrompt(work) };

  const controller = new AbortController();
  store.inFlight = controller;
  try {
    const { replyText } = await run({
      promptText: candidateJob.prompt,
      minimizeEffort: true,
      replyMaxBytes: 65536,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    beforeBuild();
    const built = buildCandidate(engine, store, replyText);
    if ("error" in built) {
      onFailure(built.error);
      return;
    }

    // If autonomous macro-compaction is enabled for this consolidation candidate, apply immediately!
    const isMacroAuto =
      candidateJob.kind === "consolidation" &&
      engine.config.macroCompaction === "auto" &&
      (built.spec.tier ?? 1) > 1;

    if (isMacroAuto) {
      const result = engine.executeFold({ folds: [built.spec], tier: built.spec.tier });
      if (result.ok) {
        onAutoApplied?.(result.outcome, built);
        return;
      }
      onFailure(`autonomous macro-compaction fold failed: ${result.error}`);
      return;
    }

    // Otherwise, place into store.pending for review
    store.pending = built;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/tool/i.test(message)) store.disabled = true;
    onFailure(message);
  } finally {
    store.inFlight = null;
  }
}
