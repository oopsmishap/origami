import type { Block, KernelMessage, LedgerKind, LedgerRecord, RefRange } from "./kernel/types.ts";
import { formatRef, parseRef } from "./kernel/types.ts";
import { SessionState } from "./kernel/state.ts";
import type { SessionEntryLike } from "./kernel/state.ts";
import { detectUncoveredRuns, isEphemeralFolded, projectUnit, protectedTailTurn, protectedZoneMap, spanHits } from "./kernel/project-unit.ts";
import { checkInvariants } from "./kernel/invariants.ts";
import type { InvariantViolation } from "./kernel/invariants.ts";
import { historicalFoldCallRefs } from "./kernel/fold-calls.ts";
import { buildToolPairPartnerMap } from "./kernel/tool-pairs.ts";
import type { ProjectUnitResult } from "./kernel/project-unit.ts";
import { expandRefRange, foldCoverageStats, renderBlockText } from "./kernel/render.ts";
import { decideNudge, formatTokens, promotionCandidates, recommendRanges } from "./kernel/nudge.ts";
import type { NudgeDecision, NudgeKind, NudgeRange } from "./kernel/nudge.ts";
import { assessFoldTiming, type FoldTiming } from "./kernel/fold-timing.ts";
import { annotateCachedPrefix } from "./kernel/cache-zones.ts";
import { EMPTY_MANIFEST, extractManifest, mergeManifests } from "./kernel/manifest.ts";
import { formatRecallHints, matchRecallHints } from "./kernel/recall-hints.ts";
import { ledgerSemanticKey, normalizeInheritedLedger } from "./kernel/ledger.ts";
import { estimateOutboundTokens, type OutboundEstimate } from "./engine-status.ts";
import { lintSummary } from "./kernel/summary-lint.ts";
import { makeFoldOp, makeUnfoldOp, makeTierOp } from "./persist/journal.ts";
import type { OrigamiDb } from "./persist/db.ts";
import { blockBodyForIndex, blockFactsForIndex } from "./persist/db.ts";
import type { OrigamiConfig } from "./config.ts";
import { configFromPreset } from "./config.ts";
import { evaluateCacheRound, getCacheCollapseStatus } from "./telemetry.ts";
import { extractPlanTerms, rerankHitsWithPlan } from "./kernel/plan-search.ts";
import { buildCacheReport, foldEventsFromBlocks, resolveEconomicsPrice, type CacheReport, type CacheSample, type FoldBlockInfo, type PriceProfile } from "./kernel/cache-report.ts";
import { formatCoverage, mergeRanges, parseBlockRangeList, parseRangeList, rangesFromRefs } from "./engine-ranges.ts";
import { renderOutbound } from "./engine-render.ts";
import { foldTiming as buildFoldTiming, recommendedRanges as buildRecommendedRanges } from "./engine-timing.ts";
import {
  emptyTurnNotes,
  hydrationText as buildHydrationText,
  recall as recallMessages,
  recallHintText as buildRecallHintText,
  searchBlocks,
  searchMessages as searchArchivedMessages,
  unfoldArtifact as buildUnfoldArtifact,
  type TurnNotes,
} from "./engine-recall.ts";
import { archiveDigest as buildArchiveDigest } from "./engine-folds.ts";
import type { CacheRound, EngineContext, FoldCreatedBlock, FoldError, FoldMessageHit, FoldParams, FoldResult, FoldSearchHit, FoldSpec, HostPort, MessageRow, PlannedFold, StatusReport, StatusVaultReport, StatusZoneRow } from "./engine-types.ts";
export type { CacheRound, EngineContext, FoldCreatedBlock, FoldError, FoldKeep, FoldMessageHit, FoldOutcome, FoldParams, FoldResult, FoldSearchHit, FoldSpec, HostPort, MessageRow, PlannedFold, StatusBlockRow, StatusReport, StatusVaultReport, StatusZoneRow } from "./engine-types.ts";
/** Child block ids from a DB `children` JSON column; malformed values yield []. */
function parseChildIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Upper bound on the payback-extended cooldown so an unprofitable fold never silences nudges for long. */
const MAX_PAYBACK_COOLDOWN_TURNS = 8;
/** Assumed summary/source ratio until the session has three tier-1 folds to take a median from. */
const DEFAULT_SUMMARY_RATIO = 0.05;
/** Turns after a recall hint during which the same block is not hinted again. */
const RECALL_HINT_QUIET_TURNS = 5;
/** Unmentioned manifest items attached to one block as "Also covered". */
const MAX_MISSING_ITEMS = 12;
/** Pinned ledger limits: explicit keep records per fold and their length. */
const MAX_KEEP_RECORDS = 20;
const MAX_KEEP_CHARS = 500;
/** Auto-pinned user intents: kept verbatim up to this length, otherwise clipped. */
const INTENT_VERBATIM_CHARS = 600;
const INTENT_CLIP_CHARS = 300;
/** At most this many intents per tier-1 fold: the first 2 and the most recent rest. */
const MAX_INTENTS = 8;


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
  private activeNudgeKind: NudgeKind | null = null;
  private pendingFoldAttribution: string | null = null;
  private onPersistenceError: ((error: unknown) => void) | null = null;
  private lastEfficiencyAtGrowth: number | null = null;
  private lastPromotionAtMass: { 1: number | null; 2: number | null } = { 1: null, 2: null };
  private lastFoldTurn: number | null = null;
  private readonly now: () => number;
  /** The newest bound message is a user message: a fresh task boundary. */
  private atUserBoundary = false;
  private turnEndRef: string | null = null;
  /** Timestamp of the newest recorded provider round (cache telemetry); null without telemetry. */
  private lastRoundAt: number | null = null;
  private roundsLoaded = false;
  /** Latest telemetry remains available to status/zones even when persistence is disabled. */
  private lastCacheRound: CacheRound | null = null;
  private lastFoldTiming: FoldTiming | null = null;
  /** Turn at which each block was last named in a recall hint. */
  private hintedAt = new Map<string, number>();
  /** Turn at which each block was last reactively hydrated. */
  private hydratedAt = new Map<string, number>();
  /** Recall/hydration notes surfaced this turn, resent on every step until the turn ends. */
  private turnNotes: TurnNotes = emptyTurnNotes();
  /** Tokens reclaimed by folds since the last provider round (still inside the host's projected anchor). */
  private reclaimedSinceRound = 0;
  /** Turn in which each block was folded; a block is never recalled into its own folding turn. */
  private foldedInTurn = new Map<string, number>();
  private pendingHostRewrite = false;
  /** Content hash per ref as last sent, to detect host-side rewrites of history. */
  private seenHashes = new Map<string, string>();
  private emergencyWarningsIgnored = 0;
  private emergencyOutstanding = false;
  get sessionId(): string {
    return this.host.sessionId();
  }

  get windowTokens(): number {
    return this.host.windowTokens();
  }

  constructor(opts: {
    host: HostPort;
    entries: readonly SessionEntryLike[];
    modelId: string;
    config?: OrigamiConfig;
    countFn?: (input: string, encoding?: string) => number;
    now?: () => number;
  }) {
    this.host = opts.host;
    this.now = opts.now ?? Date.now;
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
    let last: (typeof bound)[number] | undefined;
    for (let i = bound.length - 1; i >= 0 && !last; i--) if (!bound[i]!.ephemeral) last = bound[i];
    this.atUserBoundary = last?.role === "user";
    if (this.turnEndRef !== null && this.turnEndRef !== this.newestRef()) this.turnEndRef = null;
  }

  get bound() {
    return this.state.bound;
  }

  onTurnStart(): void {
    if (this.emergencyOutstanding) this.emergencyWarningsIgnored++;
    this.nudgedThisTurn = false;
    this.lastNudge = { kind: null, text: null };
  }

  noteEmergencySent(): void {
    this.emergencyOutstanding = true;
  }

  shouldAutoFoldEmergency(): boolean {
    return this.emergencyWarningsIgnored >= 2;
  }

  /** Outbound estimate of the last request blocked at the context limit; null when none is pending. */
  private abortedAtEstimate: number | null = null;

  /**
   * Whether to block a request whose estimate is at or over the window. A request is blocked at
   * most once per estimate: if nothing shrank since the last block, the next attempt goes through,
   * so an over-estimate can never leave the session unable to send anything (including a fold).
   */
  shouldAbortAtLimit(estimateTokens: number): boolean {
    if (this.abortedAtEstimate !== null && estimateTokens >= this.abortedAtEstimate) return false;
    this.abortedAtEstimate = estimateTokens;
    return true;
  }

  clearContextAbort(): void {
    this.abortedAtEstimate = null;
  }

  get ignoredEmergencyWarnings(): number {
    return this.emergencyWarningsIgnored;
  }

  outboundEstimateTokens(messages: readonly unknown[]): OutboundEstimate {
    return estimateOutboundTokens(messages, this.context(), this.reclaimedSinceRound);
  }

  private context(): EngineContext {
    return { state: this.state, config: this.config, host: this.host, db: this.db, now: this.now, activeTurn: this.activeTurn, protectedFromTurn: this.protectedFromTurn, bookkeepingRefs: this.bookkeepingRefs, pinnedHeadRef: this.pinnedHeadRef };
  }

  onTurnEnd(): void {
    this.turnEndRef = this.newestRef();
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
    return buildRecommendedRanges(this.context(), maxRanges);
  }

  /** Smallest reclaim worth a fold call: below this, the cache rewrite costs more than it saves. */
  minFoldBenefit(): number {
    const window = this.host.windowTokens();
    return Math.max(this.config.minFoldBenefitTokens, Math.round(this.config.minFoldBenefitWindowPct * Math.max(0, window)));
  }

  /** Whether an advisory fold of `ranges` is timely: fill floor, task boundary, cache payback. */
  foldTiming(ranges: readonly NudgeRange[]): FoldTiming {
    if (!this.roundsLoaded) {
      this.roundsLoaded = true;
      const rounds = this.cacheRounds();
      if (this.lastRoundAt === null && rounds.length > 0) this.lastRoundAt = rounds[rounds.length - 1]!.ts;
    }
    return buildFoldTiming({
      context: this.context(),
      ranges,
      lastRoundAt: this.lastRoundAt,
      turnEndRef: this.turnEndRef,
      atUserBoundary: this.atUserBoundary,
      newestRef: this.newestRef(),
      price: this.price(),
    });
  }

  decideNudge(): NudgeDecision {
    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    const ranges = this.recommendedRanges();
    const timing = this.foldTiming(ranges);
    this.lastFoldTiming = timing;
    const decision = decideNudge(
      {
        growthSinceFoldTokens: this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs),
        compressibleTokens: this.state.compressibleTokens(this.protectedFromTurn, this.bookkeepingRefs),
        windowFillPct: window > 0 ? projected / window : 0,
        nudgedThisTurn: this.nudgedThisTurn,
        activeTurn: this.activeTurn,
        lastFoldTurn: this.lastFoldTurn,
        lastEfficiencyAtGrowth: this.lastEfficiencyAtGrowth,
        lastPromotionAtMass: this.lastPromotionAtMass,
        advisoryAllowed: timing.allowed,
        promotionAllowed: timing.blockedBy === null || timing.blockedBy === "cost",
      },
      ranges,
      promotionCandidates(this.state.tree.live(), this.state.tree.foldAges(), this.config.blockMatureFolds),
      {
        ...this.config,
        minFoldBenefit: this.minFoldBenefit(),
        cooldownTurns: this.paybackCooldown(),
      },
    );
    if (decision.text) {
      this.activeNudge = decision.text;
      this.activeNudgeKind = decision.kind;
      this.nudgedThisTurn = true;
      if (decision.kind === "efficiency") this.lastEfficiencyAtGrowth = this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs);
      if (decision.promotion) this.lastPromotionAtMass[decision.promotion.fromTier] = decision.promotion.tokens;
    } else if (!this.nudgedThisTurn) {
      this.activeNudge = null;
      this.activeNudgeKind = null;
    }
    this.lastNudge = decision;
    return decision;
  }

  /** Cooldown after a fold, extended (bounded) while the latest tier-1 fold has not yet paid back. */
  private paybackCooldown(): number {
    const base = this.config.cooldownTurns ?? 2;
    try {
      const tier1 = this.cacheReport().folds.filter((f) => f.tier === 1);
      const latest = tier1[tier1.length - 1];
      if (latest && !latest.paidBack && latest.breakevenTurns !== null) {
        return Math.max(base, Math.min(Math.ceil(latest.breakevenTurns), MAX_PAYBACK_COOLDOWN_TURNS));
      }
    } catch {}
    return base;
  }

  noteHostRewrite(): void {
    this.pendingHostRewrite = true;
  }

  /** The nudge text still owed to the model, carried across a turn's continuations until folded. */
  get nudgeText(): string | null {
    return this.activeNudge;
  }

  /** Kind of the owed nudge in `nudgeText` (null when none is owed). */
  get nudgeTextKind(): NudgeKind | null {
    return this.activeNudge === null ? null : this.activeNudgeKind;
  }

  get nudge(): NudgeDecision {
    return this.lastNudge;
  }

  /** Turn number of the newest bound message. */
  get turn(): number {
    return this.activeTurn;
  }

  /** Unfolded tokens accumulated since the last fold (the efficiency-nudge growth measure). */
  growthSinceFold(): number {
    return this.state.growthSinceFold(this.activeTurn, this.bookkeepingRefs);
  }

  /** Tail note naming folded blocks whose manifest matches the current turn. */
  recallHintText(): string | null {
    return buildRecallHintText(this.context(), this.hintedAt, RECALL_HINT_QUIET_TURNS, this.foldedInTurn, this.turnNotes);
  }

  /** Tail note reactively hydrating key decisions and constraints from matching folded history. */
  hydrationText(): string | null {
    return buildHydrationText(this.context(), this.hydratedAt, RECALL_HINT_QUIET_TURNS, this.foldedInTurn, this.turnNotes);
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
    const plan = this.planFoldBatch(params);
    return plan.ok ? this.commitFoldBatch(plan.planned) : plan;
  }

  /**
   * Validate a fold batch against the current state and build its blocks (manifest, lint,
   * ledger) without writing anything: a batch either applies completely or not at all.
   */
  planFoldBatch(params: FoldParams): { ok: true; planned: PlannedFold[] } | FoldError {
    if (params.folds.length === 0) return { ok: false, error: "no folds given", foldIndex: 0 };
    const tree = this.state.tree;
    const folded = this.state.foldedRefs();
    const claimedRefs = new Map<string, number>();
    const claimedChildren = new Map<string, number>();
    let ordinal = this.nextBlockOrdinal();
    const planned: PlannedFold[] = [];

    // Validate the whole batch against the pre-mutation state before writing anything:
    // a batch either applies completely or not at all.
    for (let i = 0; i < params.folds.length; i++) {
      const spec = params.folds[i]!;
      const fail = (error: string): FoldError => ({ ok: false, error, foldIndex: i });
      const topic = (spec.topic ?? "").trim();
      const summary = (spec.summary ?? "").trim();
      if (!topic) return fail("topic must not be empty");
      if (!summary) return fail("summary must not be empty");

      // Per-spec tier allows mixed batches (e.g. compressing raw turns at tier 1 while distilling old blocks at tier 2)
      const specTier: 1 | 2 | 3 = spec.tier ?? params.tier ?? 1;

      let projection: ProjectUnitResult;
      let children: string[] = [];
      try {
        if (specTier > 1) children = [...new Set(parseBlockRangeList(spec.range))];
        projection = this.project(spec.range, specTier);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      if (!projection.ok) return fail(projection.error);

      let refs: string[];
      let ranges: RefRange[];
      let replacedTokens: number;
      let tokensBefore: number;
      let anchorRef: string | null = null;

      if (specTier === 1) {
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
        // Tier 1 records frontier anchor to prevent the protected tail from immediately counting as growth
        anchorRef = this.newestRef();
      } else {
        for (const childId of children) {
          const child = tree.get(childId);
          if (!child) return fail(`child block ${childId} not found`);
          if (child.tier >= specTier) return fail(`block ${childId} is tier ${child.tier}; a tier-${specTier} fold only merges lower-tier blocks`);
          const prior = claimedChildren.get(childId);
          if (prior !== undefined) return fail(`block ${childId} is already merged by fold ${prior} in this batch`);
        }
        if (children.length < 2) return fail(`a tier-${specTier} fold must merge at least 2 blocks`);
        refs = projection.projected.refs;
        ranges = projection.projected.ranges;
        const kids = children.map((c) => tree.get(c)!);
        tokensBefore = kids.reduce((s, b) => s + b.tokensBefore, 0);
        replacedTokens = kids.reduce((s, b) => s + b.tokensAfter, 0);
        // Distillations inherit the maximum anchor of their children; they must never advance
        // the conversation frontier anchor or wipe turn growth of newer uncompressed turns.
        anchorRef = kids.reduce((best, b) => {
          if (!b.anchorRef) return best;
          return !best || parseRef(b.anchorRef) > parseRef(best) ? b.anchorRef : best;
        }, null as string | null);
      }
      for (const ref of refs) {
        const prior = claimedRefs.get(ref);
        if (prior !== undefined) return fail(`overlaps fold ${prior} in this batch at ${ref}; fold ranges in one call must be disjoint`);
      }

      const refSet = new Set(refs);
      const manifest =
        specTier === 1
          ? extractManifest(this.state.bound.filter((m) => !m.ephemeral && refSet.has(m.ref)))
          : mergeManifests(children.map((c) => tree.get(c)!.manifest ?? EMPTY_MANIFEST));
      let id = `b${ordinal++}`;
      while (tree.get(id)) id = `b${ordinal++}`;
      const block: Block = {
        id,
        tier: specTier,
        ranges,
        topic,
        summary,
        children,
        status: "active",
        consumedBy: null,
        anchorRef,
        tokensBefore,
        tokensAfter: 0,
        createdAt: Date.now(),
        manifest,
      };
      const ledger = this.buildLedger(spec, specTier, id, refs, children);
      if (typeof ledger === "string") return fail(ledger);
      if (ledger.length > 0) block.ledger = ledger;
      if (specTier < 3) {
        const missing = lintSummary(`${topic}\n${summary}`, manifest).missing.slice(0, MAX_MISSING_ITEMS);
        if (missing.length > 0) block.missing = missing;
      }
      // Measure what is actually sent: header, summary, and attached items.
      block.tokensAfter = this.state.ledger.countText(renderBlockText(block));
      if (block.tokensAfter >= replacedTokens) {
        return fail(`summary (${block.tokensAfter}t) is not smaller than what it replaces (${replacedTokens}t)`);
      }

      for (const ref of refs) claimedRefs.set(ref, i);
      for (const c of children) claimedChildren.set(c, i);
      planned.push({ refs, block });
    }

    const tier1Planned = planned.filter((p) => p.block.tier === 1);
    if (tier1Planned.length > 0) {
      const partnerMap = buildToolPairPartnerMap(this.state.bound);
      for (let i = 0; i < planned.length; i++) {
        const p = planned[i]!;
        if (p.block.tier !== 1) continue;
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

      const floor = this.minFoldBenefit();
      const total = tier1Planned.reduce((s, p) => s + Math.max(0, p.block.tokensBefore - p.block.tokensAfter), 0);
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
    // Coverage regression guard (#3322):
    // A committed fold must never leave a previously-covered message without any covering block.
    const coveredBefore = this.state.foldedRefs();
    const simulatedConsumed = new Set<string>();
    for (const p of planned) {
      for (const c of p.block.children) simulatedConsumed.add(c);
    }
    const simulatedActive = tree.live().filter((b) => !simulatedConsumed.has(b.id)).concat(planned.map((p) => p.block));
    const coveredAfter = new Set<string>();
    for (const b of simulatedActive) {
      for (const r of b.ranges) {
        for (const ref of expandRefRange(r.start, r.end)) {
          coveredAfter.add(ref);
        }
      }
    }
    for (const ref of coveredBefore) {
      if (!coveredAfter.has(ref)) {
        return {
          ok: false,
          error: `coverage regression: message ${ref} was previously covered but would lose its covering block; fold aborted`,
          foldIndex: 0,
        };
      }
    }

    // Pre-commit structural invariant verification: prevent duplicate coverage or broken hierarchy from ever landing.
    const simulatedAll = tree.all().map((b) => {
      if (simulatedConsumed.has(b.id)) {
        return { ...b, status: "consumed" as const, consumedBy: planned[0]!.block.id };
      }
      return b;
    }).concat(planned.map((p) => p.block));

    const violations = checkInvariants(simulatedAll);
    const fatal = violations.find((v) => v.kind === "duplicate-coverage" || v.kind === "missing-child" || v.kind === "active-child");
    if (fatal) {
      return {
        ok: false,
        error: `invariant violation (${fatal.kind}): ${fatal.detail}; fold aborted`,
        foldIndex: 0,
      };
    }
    return { ok: true, planned };
  }

  /** Apply a validated batch: journal, tree, persistence, and nudge bookkeeping. */
  commitFoldBatch(planned: readonly PlannedFold[]): FoldResult {
    const tree = this.state.tree;
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
        missing: p.block.missing ?? [],
      });
      reclaimed += Math.max(0, replaced - p.block.tokensAfter);
    }
    this.persistFoldBatch(planned);
    // A block just folded must not be "recalled" into the turn that folded it.
    for (const c of created) {
      this.foldedInTurn.set(c.id, this.activeTurn);
    }
    this.reclaimedSinceRound += reclaimed;

    this.pendingFoldAttribution = created[created.length - 1]!.id;
    this.activeNudge = null;
    this.emergencyWarningsIgnored = 0;
    this.emergencyOutstanding = false;
    // A fold answers the outstanding nudge: growth re-anchors, and a merge resets its tier's mass backoff.
    this.lastEfficiencyAtGrowth = null;
    this.lastFoldTurn = this.activeTurn;
    for (const p of planned) {
      if (p.block.tier > 1) this.lastPromotionAtMass[(p.block.tier - 1) as 1 | 2] = null;
    }
    return {
      ok: true,
      outcome: { blocks: created, tokensReclaimed: reclaimed, foldCount: created.length },
    };
  }

  /**
   * Pinned ledger for a planned block, or an error message. Tier 1 pins its user messages
   * as intents; merges inherit records subject to deterministic semantic deduplication and
   * tier budgets. Explicit `keep` records are appended after inherited selection.
   */
  private buildLedger(spec: FoldSpec, tier: 1 | 2 | 3, blockId: string, refs: readonly string[], children: readonly string[]): LedgerRecord[] | string {
    const keep = spec.keep ?? [];
    if (keep.length > MAX_KEEP_RECORDS) return `at most ${MAX_KEEP_RECORDS} keep records per fold`;
    const refSet = new Set(refs);
    const kept: { kind: LedgerKind; text: string; ref: string | null }[] = [];
    for (const k of keep) {
      const text = k.text.trim();
      if (text.length < 1 || text.length > MAX_KEEP_CHARS) return `keep text must be 1-${MAX_KEEP_CHARS} characters`;
      const ref = k.ref?.trim() || null;
      if (ref !== null && tier === 1 && !refSet.has(ref)) return `keep ref ${ref} is outside this fold`;
      kept.push({ kind: k.kind, text, ref });
    }

    let inherited: LedgerRecord[] = [];
    const seed: { kind: LedgerKind; text: string; ref: string | null }[] = [];
    if (tier === 1) {
      if (spec.retire && spec.retire.length > 0) return "retire is only valid when merging blocks";
      const intents = this.state.bound
        .filter((m) => !m.ephemeral && m.role === "user" && refSet.has(m.ref))
        .map((m) => {
          const text = m.text.replace(/^text:/gm, "").trim();
          return { kind: "intent" as const, text: text.length <= INTENT_VERBATIM_CHARS ? text : `${text.slice(0, INTENT_CLIP_CHARS)} …`, ref: m.ref };
        })
        .filter((r) => r.text.length > 0);
      seed.push(...(intents.length > MAX_INTENTS ? [...intents.slice(0, 2), ...intents.slice(-(MAX_INTENTS - 2))] : intents));
    } else {
      for (const c of children) inherited.push(...(this.state.tree.get(c)?.ledger ?? []));
      const retire = new Set(spec.retire ?? []);
      for (const id of retire) {
        const rec = inherited.find((r) => r.id === id);
        if (!rec) return `unknown ledger record ${id}`;
        if (rec.kind !== "objective" && rec.kind !== "intent") return `ledger ${id} is a ${rec.kind}; only objectives and intents can be retired`;
      }
      inherited = normalizeInheritedLedger(inherited.filter((r) => !retire.has(r.id)), tier);
    }
    const seen = new Set(inherited.map(ledgerSemanticKey));
    const fresh: LedgerRecord[] = [];
    const usedIds = new Set(inherited.map((r) => r.id));
    let ordinal = 1;
    for (const record of [...seed, ...kept]) {
      const key = ledgerSemanticKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      while (usedIds.has(`${blockId}.L${ordinal}`)) ordinal++;
      const id = `${blockId}.L${ordinal++}`;
      usedIds.add(id);
      fresh.push({ id, ...record });
    }
    return [...inherited, ...fresh];
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
      manifest: JSON.stringify(b.manifest ?? EMPTY_MANIFEST),
      ledger: JSON.stringify(b.ledger ?? []),
      facts: blockFactsForIndex(b),
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
    return buildArchiveDigest(this.context(), ranges, perMessageChars);
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
    return recallMessages(this.context(), refs);
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
    for (let i = 0; i < bound.length; i++) {
      const m = bound[i]!;
      const tokens = this.state.ledger.countMessage(m);
      if (m.ephemeral) {
        if (!isEphemeralFolded(i, bound, foldedRefs)) {
          systemTokens += tokens;
        }
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

    let breakEvenTurns: number | null = 1;
    let paidBack = false;
    let cumulativeSavedTokens = 0;
    let paybackStatus = foldedSavings === 0 ? "No folds yet" : "Break-even in ~1 turn(s)";

    const rounds = this.cacheRounds();
    const latestRound = rounds[rounds.length - 1] ?? this.lastCacheRound;
    if (rounds.length > 0 && liveBlocks.length > 0) {
      try {
        const report = this.cacheReport();
        if (report.folds.length > 0) {
          const latest = report.folds[report.folds.length - 1]!;
          const b = latest.breakevenTurns;
          breakEvenTurns = b;
          paidBack = report.folds.every((f) => f.paidBack);
          cumulativeSavedTokens = Math.max(0, Math.round(report.summary.netUnits));
          if (b === null) {
            paybackStatus = "Does not pay back";
          } else if (paidBack) {
            paybackStatus = `Paid back (${Math.floor(latest.requestsAfter - b)} turns past break-even)`;
          } else {
            paybackStatus = `Break-even in ~${Math.max(1, Math.ceil(b - latest.requestsAfter))} turn(s)`;
          }
        }
      } catch {
        // Fallback to turn estimation below if cacheReport throws
      }
    } else if (foldedSavings > 0) {
      breakEvenTurns = Math.max(1, Math.ceil(summaryTokens / Math.max(1, foldedSavings)));
      const oldestFoldTurn = liveBlocks.length > 0
        ? Math.min(...liveBlocks.map((b) => {
            const firstRef = b.ranges[0]?.start;
            const m = firstRef ? bound.find((msg) => msg.ref === firstRef) : null;
            return m ? m.turn : 1;
          }))
        : this.activeTurn;
      const turnsSinceFold = Math.max(0, this.activeTurn - oldestFoldTurn);
      paidBack = turnsSinceFold >= breakEvenTurns;
      cumulativeSavedTokens = Math.max(0, foldedSavings * turnsSinceFold - summaryTokens);
      paybackStatus = paidBack
        ? `Paid back (${turnsSinceFold - breakEvenTurns} turns past break-even)`
        : `Break-even in ~${Math.max(1, breakEvenTurns - turnsSinceFold)} turn(s)`;
    }
    const vault: StatusVaultReport = {
      archivedTokens,
      summaryTokens,
      reclaimedTokens: foldedSavings,
      compressionRatio,
      savingsPct,
      archivedMessages: coverage.folded,
      activeBlocks: liveBlocks.length,
      totalBlocks: allBlocks.length,
      breakEvenTurns,
      paidBack,
      cumulativeSavedTokens,
      paybackStatus,
    };

    const windowTokens = Math.max(0, this.host.windowTokens());
    const projectedTokens = Math.max(0, this.host.projectedTokens());
    const usedTokens = projectedTokens > 0 ? projectedTokens : renderedBoundTokens;
    const overheadTokens = Math.max(0, usedTokens - renderedBoundTokens);
    const occupancyPct =
      windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;

    const rawZones = protectedZoneMap(bound, this.protectedFromTurn, foldedRefs, this.pinnedHeadRef);
    const baseZones = rawZones.map((z) => {
      const validStart = /^m\d{5,}$/.test(z.start);
      const validEnd = /^m\d{5,}$/.test(z.end);
      if (!validStart && !validEnd) {
        let ephTokens = 0;
        let ephCount = 0;
        for (let i = 0; i < bound.length; i++) {
          const m = bound[i]!;
          if (!m.ephemeral) continue;
          const k = m.turn >= this.protectedFromTurn ? "protected" : isEphemeralFolded(i, bound, foldedRefs) ? "folded" : "compressible";
          if (k === z.kind) {
            ephCount++;
            ephTokens += this.state.ledger.countMessage(m);
          }
        }
        return {
          kind: z.kind,
          start: "sys",
          end: "sys",
          tokens: ephTokens,
          messages: ephCount,
        };
      }
      const startRef = validStart ? z.start : z.end;
      const endRef = validEnd ? z.end : z.start;
      const startNum = parseRef(startRef);
      const endNum = parseRef(endRef);
      let msgTokens = 0;
      let messages = 0;
      for (let i = 0; i < bound.length; i++) {
        const m = bound[i]!;
        if (m.ephemeral) {
          if (z.kind !== "folded") {
            let pRef = 0;
            for (let k = i - 1; k >= 0; k--) {
              if (!bound[k]!.ephemeral && /^m\d{5,}$/.test(bound[k]!.ref)) {
                pRef = parseRef(bound[k]!.ref);
                break;
              }
            }
            if (pRef >= startNum && pRef <= endNum) {
              messages++;
              msgTokens += this.state.ledger.countMessage(m);
            }
          }
          continue;
        }
        if (!/^m\d{5,}$/.test(m.ref)) continue;
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
    const zones: StatusZoneRow[] = annotateCachedPrefix(baseZones, latestRound?.cacheRead ?? 0, overheadTokens);

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
      foldGate: { ...(this.lastFoldTiming ?? this.foldTiming(this.recommendedRanges())), paybackHorizonTurns: this.config.paybackHorizonTurns },
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
      hostRewrite: r.host_rewrite === 1,
      price: { cacheRead: r.cache_read_price ?? 0.1, output: r.output_price ?? 4, cacheWrite: r.cache_write_price ?? 1 },
      priceSource: (r.price_source ?? "fallback") as import("./kernel/cache-report.ts").PriceSource,
    }));
  }

  recordRound(round: CacheRound): void {
    const resolved = resolveEconomicsPrice(this.host.modelCost?.(), this.config);
    evaluateCacheRound(this.host.sessionId(), round.totalIn, round.cacheRead);
    this.lastRoundAt = round.ts;
    this.roundsLoaded = true;
    this.lastCacheRound = round;
    // The host's projected-token anchor now reflects the folded context.
    this.reclaimedSinceRound = 0;
    const hostRewrite = round.hostRewrite || this.pendingHostRewrite;
    if (!this.db) {
      this.pendingHostRewrite = false;
      return;
    }
    const foldEventId = round.foldEventId ?? this.pendingFoldAttribution;
    try {
      this.db.insertRound({
        session_id: this.host.sessionId(),
        ts: round.ts,
        total_in: round.totalIn,
        cache_read: round.cacheRead,
        cache_write: round.cacheWrite,
        fold_event_id: foldEventId,
        host_rewrite: hostRewrite ? 1 : 0,
        cache_read_price: round.price?.cacheRead ?? resolved.price.cacheRead,
        output_price: round.price?.output ?? resolved.price.output,
        cache_write_price: round.price?.cacheWrite ?? resolved.price.cacheWrite,
        price_source: round.priceSource ?? resolved.source,
      });
      this.pendingHostRewrite = false;
      this.pendingFoldAttribution = null;
    } catch (error) {
      this.disablePersistence(error);
    }
  }

  cacheReport(): CacheReport {
    const samples: CacheSample[] = this.cacheRounds().map((r) => ({
      at: r.ts,
      input: r.totalIn,
      cached: r.cacheRead,
      write: r.cacheWrite,
      foldEventId: r.foldEventId,
      hostRewrite: r.hostRewrite,
      price: r.price,
      priceSource: r.priceSource,
    }));
    const dbBlocks = this.db ? this.db.blocksForSession(this.host.sessionId()) : [];
    const infos: FoldBlockInfo[] =
      dbBlocks.length > 0
        ? dbBlocks.map((b) => ({
            id: b.block_id,
            createdAt: b.created_at,
            tier: (b.tier === 2 || b.tier === 3 ? b.tier : 1) as 1 | 2 | 3,
            tokensBefore: b.tokens_before,
            tokensAfter: b.tokens_after,
            children: parseChildIds(b.children),
            topic: b.topic,
          }))
        : this.state.tree.all().map((b) => ({
            id: b.id,
            createdAt: b.createdAt,
            tier: b.tier,
            tokensBefore: b.tokensBefore,
            tokensAfter: b.tokensAfter,
            children: b.children,
            topic: b.topic,
          }));
    return buildCacheReport(samples, foldEventsFromBlocks(infos), this.price());
  }

  private price(): PriceProfile {
    return resolveEconomicsPrice(this.host.modelCost?.(), this.config).price;
  }

  search(query: string, limit = 10, options?: { planAware?: boolean }): FoldSearchHit[] {
    return searchBlocks(this.context(), query, limit, options?.planAware !== false);
  }
  /** Ranked full-text search over archived original messages. */
  searchMessages(query: string, limit = 10): FoldMessageHit[] {
    return searchArchivedMessages(this.context(), query, limit);
  }

  async unfoldArtifact(id: string): Promise<{ ok: true; path: string; refs: string[]; toc: string } | { ok: false; error: string }> {
    return buildUnfoldArtifact(this.context(), id);
  }

  render(messages: readonly unknown[], makeFoldMessage: (text: string, blockId: string, refTag?: string) => unknown, projectedTokensOverride?: number): unknown[] {
    const rendered = renderOutbound({
      context: this.context(),
      messages,
      makeFoldMessage,
      seenHashes: this.seenHashes,
      pendingHostRewrite: this.pendingHostRewrite,
      projectedTokensOverride,
    });
    this.pendingHostRewrite = rendered.hostRewrite;
    return rendered.messages;
  }

  renderBlock(block: Block): string {
    return renderBlockText(block);
  }
}


export { formatTokens, formatRef };