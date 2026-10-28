import type { Block, BlockStatus, KernelMessage, RefRange } from "./kernel/types.ts";
import { formatRef, parseRangeSpec, parseRef } from "./kernel/types.ts";
import { messageFacts } from "./kernel/message-facts.ts";
import { SessionState } from "./kernel/state.ts";
import type { SessionEntryLike } from "./kernel/state.ts";
import { detectUncoveredRuns, projectUnit, protectedTailTurn, protectedZoneMap, spanHits, type UncoveredRun } from "./kernel/project-unit.ts";
import { checkInvariants, renderableBlocks } from "./kernel/invariants.ts";
import { historicalFoldCallRefs } from "./kernel/fold-calls.ts";
import { buildToolPairPartnerMap } from "./kernel/tool-pairs.ts";
import type { InvariantViolation } from "./kernel/invariants.ts";
import type { ProjectUnitResult } from "./kernel/project-unit.ts";
import { planRender, applyRender, expandRefRange, foldCoverageStats, renderBlockText } from "./kernel/render.ts";
import type { RenderOp } from "./kernel/render.ts";
import { decideNudge, formatTokens, promotionCandidates, recommendRanges } from "./kernel/nudge.ts";
import type { NudgeDecision, NudgeRange } from "./kernel/nudge.ts";
import { planElision, selectElideCandidates, elideLabel } from "./kernel/guard.ts";
import type { ElideCandidate } from "./kernel/guard.ts";
import type { JournalOp } from "./persist/journal.ts";
import { makeFoldOp, makeUnfoldOp, makeTierOp } from "./persist/journal.ts";
import type { OrigamiDb } from "./persist/db.ts";
import { blockBodyForIndex } from "./persist/db.ts";
import type { OrigamiConfig } from "./config.ts";
import { configFromPreset } from "./config.ts";
import { evaluateCacheRound, getCacheCollapseStatus } from "./telemetry.ts";

export interface HostPort {
  sessionId(): string;
  appendEvent(op: JournalOp): void;
  saveArtifact(content: string, toolType: string): Promise<string | undefined>;
  windowTokens(): number;
  projectedTokens(): number;
}

export interface FoldSpec {
  range: string;
  topic: string;
  summary: string;
}

export interface FoldParams {
  folds: FoldSpec[];
  tier?: 1 | 2 | 3;
}

export interface FoldCreatedBlock {
  id: string;
  tier: 1 | 2 | 3;
  refs: string[];
  tokensBefore: number;
  tokensAfter: number;
  topic: string;
}

export interface FoldOutcome {
  blocks: FoldCreatedBlock[];
  tokensReclaimed: number;
  foldCount: number;
}

export type FoldError = { ok: false; error: string; foldIndex: number };
export type FoldResult = { ok: true; outcome: FoldOutcome } | FoldError;

export interface StatusBlockRow {
  id: string;
  tier: number;
  coverage: string;
  tokens: number;
  tokensBefore: number;
  tokensAfter: number;
  reclaimed: number;
  topic: string;
  summary: string;
  children: string[];
  status: BlockStatus;
  consumedBy: string | null;
  /** Fold calls made after this block's own: blocks become merge candidates once mature. */
  survivedFolds: number;
  generation: "young" | "old";
  createdAt: number;
}

export interface StatusZoneRow {
  kind: string;
  start: string;
  end: string;
  tokens: number;
  messages: number;
}
export interface StatusVaultReport {
  /** Total original tokens preserved in the archive across live fold blocks. */
  archivedTokens: number;
  /** Summary tokens currently active in prompt context. */
  summaryTokens: number;
  /** Net prompt tokens reclaimed by folding. */
  reclaimedTokens: number;
  /** Compression multiplier: archivedTokens / summaryTokens (e.g. 45.4 for 45.4x). */
  compressionRatio: number;
  /** Space reduction percentage (e.g. 97.8 for 97.8%). */
  savingsPct: number;
  /** Total messages preserved in the archive. */
  archivedMessages: number;
  /** Active fold blocks. */
  activeBlocks: number;
  /** Total blocks created across the session. */
  totalBlocks: number;
}


export interface StatusReport {
  occupancyPct: number;
  windowTokens: number;
  usedTokens: number;
  projectedTokens: number;
  tokenSplit: {
    overhead: number;
    system: number;
    conversation: number;
    tools: number;
    summaries: number;
    live: number;
    foldedSavings: number;
  };
  growthSinceFold: number;
  growthStep: number;
  compressibleTokens: number;
  compressibleFloor: number;
  blocks: StatusBlockRow[];
  zones: StatusZoneRow[];
  folded: number;
  live: number;
  nudgeKind: string;
  /** First turn of the protected recent tail (never foldable). */
  protectedFromTurn: number;
  invariantViolations: InvariantViolation[];
  vault: StatusVaultReport;
  cacheCollapse?: {
    collapsed: boolean;
    reason: string | null;
  };
  uncoveredRuns?: UncoveredRun[];
}

export interface CacheRound {
  ts: number;
  totalIn: number;
  cacheRead: number;
  cacheWrite: number;
  foldEventId: string | null;
}

export interface FoldSearchHit {
  blockId: string;
  sessionId: string;
  tier: number;
  topic: string;
  status: string;
  snippet: string;
  rank: number;
}

export interface FoldMessageHit {
  sessionId: string;
  ref: string;
  role: string;
  turn: number;
  snippet: string;
  rank: number;
  /** False when the hit came from another session's archive (not recallable here). */
  ownSession: boolean;
}

export function parseRangeList(spec: string): RefRange[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseRangeSpec(s));
}

export function parseBlockRangeList(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("..");
    if (i < 0) {
      out.push(s);
      continue;
    }
    const a = s.slice(0, i).trim();
    const b = s.slice(i + 2).trim();
    const na = Number.parseInt(a.replace(/^b/, ""), 10);
    const nb = Number.parseInt(b.replace(/^b/, ""), 10);
    if (!Number.isInteger(na) || !Number.isInteger(nb)) throw new Error(`invalid block range: ${s}`);
    if (na > nb) throw new Error(`reversed block range: ${s}`);
    for (let n = na; n <= nb; n++) out.push(`b${n}`);
  }
  return out;
}

interface MessageRow {
  ref: string;
  role?: string;
  ephemeral: boolean;
  turn: number;
  tokens: number;
  tool: boolean;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string;
}

export class OrigamiEngine {
  readonly state: SessionState;
  config: OrigamiConfig;
  private host: HostPort;
  private db: OrigamiDb | null = null;
  private nudgedThisTurn = false;
  private activeTurn = 1;
  private protectedFromTurn = 1;
  private bookkeepingRefs: ReadonlySet<string> = new Set();
  private pinnedHeadRef: string | null = null;
  private lastNudge: NudgeDecision = { kind: null, text: null };
  private activeNudge: string | null = null;
  private pendingFoldAttribution: string | null = null;
  private onPersistenceError: ((error: unknown) => void) | null = null;
  private lastEfficiencyAtGrowth: number | null = null;
  private lastPromotionAtMass: { 1: number | null; 2: number | null } = { 1: null, 2: null };
  get sessionId(): string {
    return this.host.sessionId();
  }

  get windowTokens(): number {
    return this.host.windowTokens();
  }

  constructor(opts: { host: HostPort; entries: readonly SessionEntryLike[]; modelId: string; config?: OrigamiConfig; countFn?: (input: string, encoding?: string) => number }) {
    this.host = opts.host;
    this.config = opts.config ?? configFromPreset("balanced");
    this.state = new SessionState({
      sessionId: opts.host.sessionId(),
      modelId: opts.modelId,
      entries: opts.entries,
      countFn: opts.countFn ? (input, encoding) => opts.countFn!(input, encoding) : null,
    });
  }

  attachDb(db: OrigamiDb | null, onPersistenceError?: (error: unknown) => void): void {
    this.db = db;
    this.onPersistenceError = onPersistenceError ?? null;
  }

  refresh(entries: readonly SessionEntryLike[]): void {
    this.state.refresh(entries);
  }

  ingest(messages: readonly KernelMessage[]): void {
    const bound = this.state.bind(messages);
    const turns = bound.map((m) => m.turn);
    this.activeTurn = turns.length > 0 ? Math.max(...turns) : 1;
    const head = bound.find((m) => !m.ephemeral);
    this.pinnedHeadRef = head ? head.ref : null;
    const tailTurn = protectedTailTurn(
      bound,
      this.activeTurn,
      this.config.protectedTailMessages,
      this.config.protectedTailTokens,
      (m) => this.state.ledger.countMessage(m),
    );
    // The latest user instruction stays verbatim even when custom messages opened later turns.
    let lastUserTurn = this.activeTurn;
    for (let i = bound.length - 1; i >= 0; i--) {
      const m = bound[i]!;
      if (!m.ephemeral && m.role === "user") {
        lastUserTurn = m.turn;
        break;
      }
    }
    this.protectedFromTurn = Math.min(tailTurn, lastUserTurn);
    this.bookkeepingRefs = historicalFoldCallRefs(bound, this.protectedFromTurn);
  }

  get bound() {
    return this.state.bound;
  }

  onTurnStart(): void {
    this.nudgedThisTurn = false;
    this.lastNudge = { kind: null, text: null };
  }

  messageRows(): MessageRow[] {
    return this.state.bound.map((m) => ({
      ref: m.ref,
      role: m.role,
      ephemeral: m.ephemeral,
      turn: m.turn,
      tokens: this.bookkeepingRefs.has(m.ref) ? 0 : this.state.ledger.countMessage(m),
      tool: m.role === "toolResult",
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    }));
  }

  recommendedRanges(maxRanges = 8): NudgeRange[] {
    return recommendRanges({
      bound: this.messageRows(),
      foldedRefs: this.state.foldedRefs(),
      protectedFromTurn: this.protectedFromTurn,
      pinnedHeadRef: this.pinnedHeadRef,
      maxRanges,
    });
  }

  /** Smallest reclaim worth a fold call: below this, the cache rewrite costs more than it saves. */
  minFoldBenefit(): number {
    const window = this.host.windowTokens();
    return Math.max(this.config.minFoldBenefitTokens, Math.round(this.config.minFoldBenefitWindowPct * Math.max(0, window)));
  }

  decideNudge(): NudgeDecision {
    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    const decision = decideNudge(
      {
        growthSinceFoldTokens: this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs),
        compressibleTokens: this.state.compressibleTokens(this.protectedFromTurn, this.bookkeepingRefs),
        windowFillPct: window > 0 ? projected / window : 0,
        nudgedThisTurn: this.nudgedThisTurn,
        lastEfficiencyAtGrowth: this.lastEfficiencyAtGrowth,
        lastPromotionAtMass: this.lastPromotionAtMass,
      },
      this.recommendedRanges(),
      promotionCandidates(this.state.tree.live(), this.state.tree.foldAges(), this.config.blockMatureFolds),
      { ...this.config, minFoldBenefit: this.minFoldBenefit() },
    );
    if (decision.text) {
      this.activeNudge = decision.text;
      this.nudgedThisTurn = true;
      if (decision.kind === "efficiency") this.lastEfficiencyAtGrowth = this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs);
      if (decision.promotion) this.lastPromotionAtMass[decision.promotion.fromTier] = decision.promotion.tokens;
    } else if (!this.nudgedThisTurn) {
      this.activeNudge = null;
    }
    this.lastNudge = decision;
    return decision;
  }

  /** The nudge text still owed to the model, carried across a turn's continuations until folded. */
  get nudgeText(): string | null {
    return this.activeNudge;
  }

  get nudge(): NudgeDecision {
    return this.lastNudge;
  }

  project(spec: string, tier: 1 | 2 | 3): ProjectUnitResult {
    if (tier === 1) {
      return projectUnit({
        bound: this.state.bound,
        ranges: parseRangeList(spec),
        foldedRefs: this.state.foldedRefs(),
        pinnedHeadRef: this.pinnedHeadRef,
        activeTurn: this.activeTurn,
        protectedFromTurn: this.protectedFromTurn,
      });
    }
    return this.projectBlocks(parseBlockRangeList(spec));
  }

  private projectBlocks(ids: readonly string[]): ProjectUnitResult {
    const ranges: RefRange[] = [];
    for (const id of ids) {
      const block = this.state.tree.get(id);
      if (!block) return { ok: false, error: `unknown block: ${id}` };
      if (block.status !== "active") return { ok: false, error: `block ${id} is ${block.status}${block.consumedBy ? ` by ${block.consumedBy}` : ""}; only active blocks can be folded` };
      ranges.push(...block.ranges);
    }
    if (ranges.length === 0) return { ok: false, error: "empty range" };
    const merged = mergeRanges(ranges);
    const refs: string[] = [];
    for (const r of merged) refs.push(...expandRefRange(r.start, r.end));
    const refSet = new Set(refs);
    return {
      ok: true,
      projected: { indices: [], refs, ranges: merged, tokens: this.state.tokensFor(refs) },
      widened: false,
      turnCount: new Set(this.state.bound.filter((m) => refSet.has(m.ref)).map((m) => m.turn)).size,
    };
  }

  executeFold(params: FoldParams): FoldResult {
    const tier = params.tier ?? 1;
    if (params.folds.length === 0) return { ok: false, error: "no folds given", foldIndex: 0 };
    const tree = this.state.tree;
    const folded = this.state.foldedRefs();
    const anchorRef = this.newestRef();
    const claimedRefs = new Map<string, number>();
    const claimedChildren = new Map<string, number>();
    let ordinal = this.nextBlockOrdinal();
    const planned: { block: Block; refs: string[] }[] = [];

    // Validate the whole batch against the pre-mutation state before writing anything:
    // a batch either applies completely or not at all.
    for (let i = 0; i < params.folds.length; i++) {
      const spec = params.folds[i]!;
      const fail = (error: string): FoldError => ({ ok: false, error, foldIndex: i });
      const topic = (spec.topic ?? "").trim();
      const summary = (spec.summary ?? "").trim();
      if (!topic) return fail("topic must not be empty");
      if (!summary) return fail("summary must not be empty");

      let projection: ProjectUnitResult;
      let children: string[] = [];
      try {
        if (tier > 1) children = [...new Set(parseBlockRangeList(spec.range))];
        projection = this.project(spec.range, tier);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      if (!projection.ok) return fail(projection.error);

      let refs: string[];
      let ranges: RefRange[];
      let replacedTokens: number;
      let tokensBefore: number;
      if (tier === 1) {
        // Refs already owned by an active block stay with that block: the new block
        // covers only unfolded sources, so nothing is represented twice. Turn widening
        // can pull a turn shared by two disjoint requested ranges into both folds; the
        // earlier fold keeps it. Only requested spans that intersect are an overlap.
        const requested = parseRangeList(spec.range);
        refs = [];
        for (const r of projection.projected.refs) {
          if (folded.has(r)) continue;
          const prior = claimedRefs.get(r);
          if (prior === undefined) {
            refs.push(r);
            continue;
          }
          if (spanHits(r, requested) && spanHits(r, parseRangeList(params.folds[prior]!.range))) {
            return fail(`overlaps fold ${prior} in this batch at ${r}; fold ranges in one call must be disjoint`);
          }
        }
        if (refs.length === 0) return fail("range covers only messages already folded or claimed by an earlier fold in this batch");
        ranges = rangesFromRefs(refs);
        tokensBefore = this.state.tokensFor(refs.filter((r) => !this.bookkeepingRefs.has(r)));
        replacedTokens = tokensBefore;
      } else {
        for (const childId of children) {
          const child = tree.get(childId)!;
          if (child.tier >= tier) return fail(`block ${childId} is tier ${child.tier}; a tier-${tier} fold only merges lower-tier blocks`);
          const prior = claimedChildren.get(childId);
          if (prior !== undefined) return fail(`block ${childId} is already merged by fold ${prior} in this batch`);
        }
        if (children.length < 2) return fail(`a tier-${tier} fold must merge at least 2 blocks`);
        refs = projection.projected.refs;
        ranges = projection.projected.ranges;
        const kids = children.map((c) => tree.get(c)!);
        tokensBefore = kids.reduce((s, b) => s + b.tokensBefore, 0);
        replacedTokens = kids.reduce((s, b) => s + b.tokensAfter, 0);
      }
      for (const ref of refs) {
        const prior = claimedRefs.get(ref);
        if (prior !== undefined) return fail(`overlaps fold ${prior} in this batch at ${ref}; fold ranges in one call must be disjoint`);
      }

      const tokensAfter = this.state.ledger.countText(`${topic}\n${summary}`);
      if (tokensAfter >= replacedTokens) {
        return fail(`summary (${tokensAfter}t) is not smaller than what it replaces (${replacedTokens}t)`);
      }

      for (const ref of refs) claimedRefs.set(ref, i);
      for (const c of children) claimedChildren.set(c, i);
      let id = `b${ordinal++}`;
      while (tree.get(id)) id = `b${ordinal++}`;
      planned.push({
        refs,
        block: {
          id,
          tier,
          ranges,
          topic,
          summary,
          children,
          status: "active",
          consumedBy: null,
          anchorRef,
          tokensBefore,
          tokensAfter,
          createdAt: Date.now(),
        },
      });
    }

    if (tier === 1) {
      const partnerMap = buildToolPairPartnerMap(this.state.bound);
      for (let i = 0; i < planned.length; i++) {
        const p = planned[i]!;
        for (const r of p.refs) {
          const partners = partnerMap.get(r);
          if (!partners) continue;
          for (const partner of partners) {
            if (folded.has(partner)) continue;
            const partnerFoldIdx = claimedRefs.get(partner);
            if (partnerFoldIdx !== i) {
              return {
                ok: false,
                error: `tool pair split: ${r} is in fold ${i} but its partner ${partner} is ${partnerFoldIdx === undefined ? "unfolded" : `in fold ${partnerFoldIdx}`}; tool call and its results must fold into the same block`,
                foldIndex: i,
              };
            }
          }
        }
      }
    }

    // Folding rewrites the cached prefix; a tiny tier-1 reclaim costs more than it saves.
    // Merges are gated by the mass nudges instead, and an emergency always folds.
    if (tier === 1) {
      const floor = this.minFoldBenefit();
      const total = planned.reduce((s, p) => s + Math.max(0, p.block.tokensBefore - p.block.tokensAfter), 0);
      const window = this.host.windowTokens();
      const emergency = window > 0 && this.host.projectedTokens() / window >= this.config.emergencyFillPct;
      if (floor > 0 && total < floor && !emergency) {
        return {
          ok: false,
          error: `batch reclaims ~${formatTokens(total)}t, below the minimum fold benefit of ${formatTokens(floor)}t; fold more finished work at once or defer`,
          foldIndex: 0,
        };
      }
    }

    const created: FoldCreatedBlock[] = [];
    let reclaimed = 0;
    for (const p of planned) {
      const replaced = p.block.tier === 1 ? p.block.tokensBefore : p.block.children.reduce((s, c) => s + (tree.get(c)?.tokensAfter ?? 0), 0);
      this.host.appendEvent(makeFoldOp(p.block));
      tree.apply({ op: "fold", block: p.block });
      created.push({
        id: p.block.id,
        tier: p.block.tier,
        refs: p.refs,
        tokensBefore: p.block.tokensBefore,
        tokensAfter: p.block.tokensAfter,
        topic: p.block.topic,
      });
      reclaimed += Math.max(0, replaced - p.block.tokensAfter);
    }
    this.persistFoldBatch(planned);

    this.pendingFoldAttribution = created[created.length - 1]!.id;
    this.activeNudge = null;
    // A fold answers the outstanding nudge: growth re-anchors, and a merge resets its tier's mass backoff.
    this.lastEfficiencyAtGrowth = null;
    if (tier > 1) this.lastPromotionAtMass[(tier - 1) as 1 | 2] = null;
    return {
      ok: true,
      outcome: { blocks: created, tokensReclaimed: reclaimed, foldCount: created.length },
    };
  }

  /** Newest non-ephemeral ref currently bound (the fold-time anchor for growth). */
  private newestRef(): string | null {
    let best = 0;
    for (const m of this.state.bound) {
      if (m.ephemeral || !/^m\d{5,}$/.test(m.ref)) continue;
      best = Math.max(best, parseRef(m.ref));
    }
    return best > 0 ? formatRef(best) : null;
  }

  private nextBlockOrdinal(): number {
    let max = 0;
    for (const b of this.state.tree.all()) {
      const n = Number.parseInt(b.id.replace(/^b/, ""), 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max + 1;
  }

  private blockRow(b: Block) {
    return {
      session_id: this.host.sessionId(),
      block_id: b.id,
      tier: b.tier,
      topic: b.topic,
      summary: b.summary,
      body: blockBodyForIndex(b),
      tokens_before: b.tokensBefore,
      tokens_after: b.tokensAfter,
      created_at: b.createdAt,
      status: b.status,
      consumed_by: b.consumedBy,
      ranges: JSON.stringify(b.ranges),
      children: JSON.stringify(b.children),
    };
  }

  private statusRow(b: Block) {
    return {
      session_id: this.host.sessionId(),
      block_id: b.id,
      status: b.status,
      consumed_by: b.consumedBy,
    };
  }

  private disablePersistence(error: unknown): void {
    if (!this.db) return;
    this.db = null;
    this.onPersistenceError?.(error);
  }

  private persistFoldBatch(planned: readonly { block: Block; refs: string[] }[]): void {
    if (!this.db) return;
    const refs = new Set(planned.filter((p) => p.block.tier === 1).flatMap((p) => p.refs));
    const now = Date.now();
    const messages = this.state.bound
      .filter((m) => refs.has(m.ref))
      .map((m) => ({
        session_id: this.host.sessionId(),
        ref: m.ref,
        role: m.role,
        text: m.text,
        turn: m.turn,
        tokens: this.state.ledger.countMessage(m),
        captured_at: now,
      }));
    const blocks = planned.map((p) => this.blockRow(this.state.tree.get(p.block.id)!));
    const childIds = [...new Set(planned.flatMap((p) => p.block.children))];
    const statuses = childIds.map((id) => this.state.tree.get(id)).filter((b): b is Block => b !== undefined).map((b) => this.statusRow(b));
    try {
      this.db.persistFoldBatch({ messages, blocks, statuses });
    } catch (error) {
      this.disablePersistence(error);
    }
  }

  private persistStatuses(ids: readonly string[]): void {
    if (!this.db) return;
    const rows = [...new Set(ids)].map((id) => this.state.tree.get(id)).filter((b): b is Block => b !== undefined).map((b) => this.statusRow(b));
    try {
      this.db.updateBlockStatuses(rows);
    } catch (error) {
      this.disablePersistence(error);
    }
  }

  /**
   * One clipped line per covered message: a mechanical summary for emergency archives.
   * Full originals are kept in the durable archive (see `recall`), not in the summary.
   */
  archiveDigest(ranges: readonly RefRange[], perMessageChars = 160): string {
    const parts: string[] = [];
    for (const m of this.state.bound) {
      if (m.ephemeral) continue;
      const n = parseRef(m.ref);
      if (!ranges.some((r) => n >= parseRef(r.start) && n <= parseRef(r.end))) continue;
      const flat = m.text.replace(/\s+/g, " ").trim();
      const clipped = flat.length > perMessageChars ? `${flat.slice(0, perMessageChars - 1)}…` : flat;
      parts.push(`[#${m.ref}] ${m.role}: ${clipped}`);
    }
    return parts.join("\n");
  }

  /**
   * Unfold an active block. Its direct children become active again (one level).
   * With `deep`, every restored descendant is unfolded too, so the raw messages return.
   */
  executeUnfold(
    id: string,
    opts: { deep?: boolean; force?: boolean } = {},
  ): { ok: true; block: Block; refs: string[]; unfolded: string[] } | { ok: false; error: string } {
    const tree = this.state.tree;
    const block = tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    if (block.status === "unfolded") return { ok: false, error: `block already unfolded: ${id}` };
    if (block.status === "consumed") {
      return { ok: false, error: `block ${id} is consumed by ${block.consumedBy}; unfold ${block.consumedBy} first` };
    }

    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    if (!opts.force && window > 0) {
      const netTokens = opts.deep || block.tier === 1
        ? block.tokensBefore - block.tokensAfter
        : block.children.reduce((s, c) => s + (tree.get(c)?.tokensAfter ?? 0), 0) - block.tokensAfter;
      const projectedAfter = projected + Math.max(0, netTokens);
      const limitPct = Math.max(0.85, this.config.emergencyFillPct);
      if (projectedAfter > window * limitPct) {
        return {
          ok: false,
          error: `inline unfold would push context to ~${formatTokens(projectedAfter)}t (${Math.round((projectedAfter / window) * 100)}% of ${formatTokens(window)}t window, emergency limit is ${Math.round(limitPct * 100)}%); use mode: "file" to inspect artifact safely without inflating context`,
        };
      }
    }
    const refs: string[] = [];
    for (const r of block.ranges) refs.push(...expandRefRange(r.start, r.end));
    const unfolded: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const next = tree.get(queue.shift()!)!;
      this.host.appendEvent(makeUnfoldOp(next.id));
      tree.apply({ op: "unfold", id: next.id });
      unfolded.push(next.id);
      const changed = [next.id];
      for (const c of next.children) {
        const child = tree.get(c);
        if (!child) continue;
        changed.push(c);
        if (opts.deep && child.status === "active") queue.push(c);
      }
      this.persistStatuses(changed);
    }
    return { ok: true, block, refs, unfolded };
  }

  /** Original text for refs: current branch first, durable archive for the rest. */
  recall(refs: readonly string[]): { ref: string; role: string | null; text: string | null; source: "context" | "archive" | "missing" }[] {
    const byRef = new Map(this.state.bound.map((m) => [m.ref, m]));
    const missing = refs.filter((r) => !byRef.has(r));
    const archived = new Map(
      this.db && missing.length > 0 ? this.db.messagesForRefs(this.host.sessionId(), missing).map((r) => [r.ref, r]) : [],
    );
    return refs.map((ref) => {
      const m = byRef.get(ref);
      if (m) return { ref, role: m.role, text: m.text, source: "context" as const };
      const a = archived.get(ref);
      if (a) return { ref, role: a.role, text: a.text, source: "archive" as const };
      return { ref, role: null, text: null, source: "missing" as const };
    });
  }

  /** Structural violations; off-branch checks only once a branch view is bound. */
  invariants(): InvariantViolation[] {
    const bound = this.state.bound;
    return checkInvariants(this.state.tree.all(), bound.length > 0 ? new Set(bound.map((m) => m.ref)) : undefined);
  }

  executeTier(id: string, tier: 1 | 2 | 3, topic: string, summary: string): { ok: true; block: Block } | { ok: false; error: string } {
    const block = this.state.tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    const op = makeTierOp(id, tier, topic, summary, block.tokensBefore, block.tokensAfter);
    this.host.appendEvent(op);
    this.state.tree.apply(op);
    return { ok: true, block: this.state.tree.get(id)! };
  }

  status(): StatusReport {
    const bound = this.state.bound;
    const foldedRefs = this.state.foldedRefs();
    const coverage = foldCoverageStats(bound, foldedRefs);

    let systemTokens = 0;
    let conversationTokens = 0;
    let toolTokens = 0;
    for (const m of bound) {
      const tokens = this.state.ledger.countMessage(m);
      if (m.ephemeral) {
        systemTokens += tokens;
      } else if (!foldedRefs.has(m.ref)) {
        if (m.role === "toolResult") toolTokens += tokens;
        else conversationTokens += tokens;
      }
    }

    const liveBlocks = this.state.tree.live();
    const allBlocks = this.state.tree.all();
    const summaryTokens = liveBlocks.reduce((s, b) => s + b.tokensAfter, 0);
    const archivedTokens = liveBlocks.reduce((s, b) => s + b.tokensBefore, 0);
    const foldedSavings = liveBlocks.reduce((s, b) => s + Math.max(0, b.tokensBefore - b.tokensAfter), 0);
    const liveTokens = conversationTokens + toolTokens;
    const renderedBoundTokens = systemTokens + liveTokens + summaryTokens;

    const compressionRatio =
      summaryTokens > 0
        ? Math.round((archivedTokens / summaryTokens) * 10) / 10
        : archivedTokens > 0
          ? archivedTokens
          : 1;
    const savingsPct =
      archivedTokens > 0
        ? Math.round((foldedSavings / archivedTokens) * 1000) / 10
        : 0;

    const vault: StatusVaultReport = {
      archivedTokens,
      summaryTokens,
      reclaimedTokens: foldedSavings,
      compressionRatio,
      savingsPct,
      archivedMessages: coverage.folded,
      activeBlocks: liveBlocks.length,
      totalBlocks: allBlocks.length,
    };

    const windowTokens = Math.max(0, this.host.windowTokens());
    const projectedTokens = Math.max(0, this.host.projectedTokens());
    const usedTokens = projectedTokens > 0 ? projectedTokens : renderedBoundTokens;
    const overheadTokens = Math.max(0, usedTokens - renderedBoundTokens);
    const occupancyPct =
      windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;

    const rawZones = protectedZoneMap(bound, this.protectedFromTurn, foldedRefs, this.pinnedHeadRef);
    const zones: StatusZoneRow[] = rawZones.map((z) => {
      const validStart = /^m\d{5,}$/.test(z.start);
      const validEnd = /^m\d{5,}$/.test(z.end);
      if (!validStart && !validEnd) {
        const ephCount = bound.filter((m) => m.ephemeral).length;
        return {
          kind: z.kind,
          start: "sys",
          end: "sys",
          tokens: systemTokens,
          messages: ephCount,
        };
      }
      const startRef = validStart ? z.start : z.end;
      const endRef = validEnd ? z.end : z.start;
      const startNum = parseRef(startRef);
      const endNum = parseRef(endRef);
      let msgTokens = 0;
      let messages = 0;
      for (const m of bound) {
        if (m.ephemeral || !/^m\d{5,}$/.test(m.ref)) continue;
        const n = parseRef(m.ref);
        if (n >= startNum && n <= endNum) {
          messages++;
          msgTokens += this.state.ledger.countMessage(m);
        }
      }
      let tokens = msgTokens;
      if (z.kind === "folded") {
        const summaryInZone = liveBlocks
          .filter((b) =>
            b.ranges.some((r) => parseRef(r.start) <= endNum && parseRef(r.end) >= startNum),
          )
          .reduce((s, b) => s + b.tokensAfter, 0);
        tokens = summaryInZone > 0 ? summaryInZone : msgTokens;
      }
      return {
        kind: z.kind,
        start: startRef,
        end: endRef,
        tokens,
        messages,
      };
    });

    const ages = this.state.tree.foldAges();
    return {
      occupancyPct,
      windowTokens,
      usedTokens,
      projectedTokens,
      tokenSplit: {
        overhead: overheadTokens,
        system: systemTokens,
        conversation: conversationTokens,
        tools: toolTokens,
        summaries: summaryTokens,
        live: liveTokens,
        foldedSavings,
      },
      vault,
      growthSinceFold: this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs),
      growthStep: this.config.growthStep,
      compressibleTokens: this.state.compressibleTokens(this.protectedFromTurn, this.bookkeepingRefs),
      compressibleFloor: this.config.compressibleFloor,
      blocks: this.state.tree.all().map((b) => ({
        id: b.id,
        tier: b.tier,
        coverage: formatCoverage(b.ranges),
        tokens: b.tokensBefore,
        tokensBefore: b.tokensBefore,
        tokensAfter: b.tokensAfter,
        reclaimed: Math.max(0, b.tokensBefore - b.tokensAfter),
        topic: b.topic,
        summary: b.summary,
        children: [...b.children],
        status: b.status,
        consumedBy: b.consumedBy,
        survivedFolds: ages.get(b.id) ?? 0,
        generation: (ages.get(b.id) ?? 0) >= this.config.blockMatureFolds ? ("old" as const) : ("young" as const),
        createdAt: b.createdAt,
      })),
      zones,
      folded: coverage.folded,
      live: coverage.live,
      nudgeKind: this.lastNudge.kind ?? "none",
      protectedFromTurn: this.protectedFromTurn,
      invariantViolations: this.invariants(),
      cacheCollapse: getCacheCollapseStatus(this.host.sessionId()),
      uncoveredRuns: detectUncoveredRuns(
        bound,
        this.protectedFromTurn,
        foldedRefs,
        this.pinnedHeadRef,
        this.bookkeepingRefs,
        (m) => this.state.ledger.countMessage(m),
        this.recommendedRanges().map((r) => ({ start: r.start, end: r.end })),
      ),
    };
  }

  cacheRounds(): CacheRound[] {
    if (!this.db) return [];
    return this.db.roundsForSession(this.host.sessionId()).map((r) => ({
      ts: r.ts,
      totalIn: r.total_in,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      foldEventId: r.fold_event_id,
    }));
  }

  recordRound(round: CacheRound): void {
    evaluateCacheRound(this.host.sessionId(), round.totalIn, round.cacheRead);
    if (!this.db) return;
    const foldEventId = round.foldEventId ?? this.pendingFoldAttribution;
    try {
      this.db.insertRound({
        session_id: this.host.sessionId(),
        ts: round.ts,
        total_in: round.totalIn,
        cache_read: round.cacheRead,
        cache_write: round.cacheWrite,
        fold_event_id: foldEventId,
      });
      this.pendingFoldAttribution = null;
    } catch (error) {
      this.disablePersistence(error);
    }
  }

  search(query: string, limit = 10): FoldSearchHit[] {
    if (!this.db) return [];
    return this.db.searchBlocks(query, limit).map((r) => ({
      blockId: r.block_id,
      sessionId: r.session_id,
      tier: r.tier,
      topic: r.topic,
      status: r.status,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  /** Ranked full-text search over archived original messages (populated when folds archive their sources). */
  searchMessages(query: string, limit = 10): FoldMessageHit[] {
    if (!this.db) return [];
    const own = this.host.sessionId();
    return this.db.searchMessages(query, limit).map((r) => ({
      sessionId: r.session_id,
      ref: r.ref,
      role: r.role,
      turn: r.turn,
      snippet: r.snippet,
      rank: r.rank,
      ownSession: r.session_id === own,
    }));
  }

  async unfoldArtifact(id: string): Promise<{ ok: true; path: string; refs: string[]; toc: string } | { ok: false; error: string }> {
    const block = this.state.tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    const refs: string[] = [];
    for (const r of block.ranges) refs.push(...expandRefRange(r.start, r.end));
    const lines: string[] = [`# ${block.id} — ${block.topic}`, ""];
    const recalled = new Map(this.recall(refs).map((r) => [r.ref, r]));
    for (const ref of refs) {
      const r = recalled.get(ref);
      const label = r?.source === "archive" ? `${r.role}, archived` : r?.role;
      lines.push(`## ${ref}${label ? ` (${label})` : ""}`, r?.text ?? "<not in current branch view or archive>", "");
    }
    const path = await this.host.saveArtifact(lines.join("\n"), `origami-unfold-${id}`);
    return {
      ok: true,
      path: path ?? "",
      refs,
      toc: refs.map((r) => `- ${r}`).join("\n"),
    };
  }

  render(messages: readonly unknown[], makeFoldMessage: (text: string, blockId: string, refTag?: string) => unknown): unknown[] {
    // Bind the array we are actually rewriting: the outbound request may carry
    // ephemeral developer reminders the journal never recorded, and
    // `bound[i].index === messages[i]` must hold for removals/elision to land.
    const facts: KernelMessage[] = [];
    for (const m of messages) {
      const f = messageFacts(m);
      if (!f) break;
      facts.push(f);
    }
    const aligned = facts.length === messages.length;
    const bound = aligned ? this.state.bindOutbound(facts) : this.state.bound;
    const headIndex = bound.findIndex((m) => !m.ephemeral);
    const pinnedHeadIndex = headIndex < 0 ? 0 : headIndex;

    // Elision runs BEFORE render removals: bound[i].index === i, so bound indices
    // map 1:1 onto the input array here and would drift after any removal.
    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    let source: readonly unknown[] = messages;
    if (window > 0 && projected >= window * this.config.elideFillPct && aligned) {
      const candidates: ElideCandidate[] = selectElideCandidates(
        bound.map((m) => ({
          ref: m.ref,
          index: m.index,
          role: m.role,
          tokens: this.state.ledger.countMessage(m),
          ephemeral: m.ephemeral,
        })),
      );
      const plan = planElision({
        projectedTokens: projected,
        windowTokens: window,
        candidates,
        thresholds: { elideFillPct: this.config.elideFillPct, targetFillPct: 0.7 },
      });
      if (plan.elided.length > 0) {
        const elideAt = new Map(plan.elided.map((e) => [e.index, e]));
        source = messages.map((m, i) => {
          const hit = elideAt.get(i);
          if (!hit) return m;
          const raw = m as { content?: unknown };
          const label = elideLabel(hit.ref, hit.tokens);
          const content = typeof raw.content === "string" ? label : [{ type: "text", text: label }];
          return { ...(m as object), content };
        });
      }
    }

    const ops: RenderOp[] = planRender({
      bound,
      blocks: renderableBlocks(this.state.tree.live()),
      pinnedHeadIndex,
    });
    return applyRender(source, ops, makeFoldMessage);
  }

  renderBlock(block: Block): string {
    return renderBlockText(block);
  }
}

/** Compress sorted-or-not refs into contiguous ordinal ranges. */
function rangesFromRefs(refs: readonly string[]): RefRange[] {
  const nums = [...new Set(refs.map(parseRef))].sort((a, b) => a - b);
  const out: RefRange[] = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && parseRef(last.end) === n - 1) last.end = formatRef(n);
    else out.push({ start: formatRef(n), end: formatRef(n) });
  }
  return out;
}

function formatCoverage(ranges: readonly RefRange[]): string {
  return ranges.map((r) => `${r.start}..${r.end}`).join(", ");
}

function mergeRanges(ranges: readonly RefRange[]): RefRange[] {
  const sorted = [...ranges].sort((a, b) => parseRef(a.start) - parseRef(b.start));
  const out: RefRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && parseRef(r.start) <= parseRef(last.end) + 1) {
      if (parseRef(r.end) > parseRef(last.end)) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export { formatTokens, formatRef };