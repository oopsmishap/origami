import { buildToolPairPartnerMap } from "./tool-pairs.ts";
export interface NudgeRange {
  start: string;
  end: string;
  tokens: number;
  /** Messages in the range. */
  messages: number;
  /** Tokens in the range that are tool results. */
  toolTokens: number;
}

/** Active blocks of one tier the model could merge into the next tier. */
export interface PromotionCandidate {
  fromTier: 1 | 2;
  /** Blocks selected by due order for this merge. */
  blockIds: string[];
  /** Rendered summary mass of the selected blocks. */
  tokens: number;
  /** Rendered summary mass of every active block at this tier; drives the trigger/backoff. */
  totalTokens: number;
}

export interface NudgeState {
  growthSinceFoldTokens: number;
  compressibleTokens: number;
  windowFillPct: number;
  nudgedThisTurn: boolean;
  activeTurn?: number;
  lastFoldTurn?: number | null;
  /** Growth at which the last efficiency nudge fired since the last fold; null if none. */
  lastEfficiencyAtGrowth: number | null;
  lastPromotionAtMass: { 1: number | null; 2: number | null };
  /** Fold timing gate (fill floor, boundary, cost) allows advisory tier-1 nudges. */
  advisoryAllowed: boolean;
  /** Fill floor and boundary allow promotion nudges (they rewrite only summaries; cost gate does not apply). */
  promotionAllowed: boolean;
}
export type NudgeKind = "efficiency" | "emergency" | "promotion";

export interface NudgeDecision {
  kind: NudgeKind | null;
  text: string | null;
  /** Source tier, trigger mass (for backoff), and due-ordered blocks selected for this merge. */
  promotion?: { fromTier: 1 | 2; tokens: number; blockIds: string[] };
}

export interface NudgeConfig {
  growthStep: number;
  compressibleFloor: number;
  emergencyFillPct: number;
  tier2MassTokens: number;
  tier3MassTokens: number;
  /** Resolved minimum reclaim (tokens) that makes an advisory fold worth its cache break. */
  minFoldBenefit: number;
  cooldownTurns?: number;
}
export function formatRange(r: NudgeRange): string {
  const toolPct = r.tokens > 0 ? Math.round((r.toolTokens / r.tokens) * 100) : 0;
  return `${r.start}..${r.end} (${formatTokens(r.tokens)}t · ${r.messages} msg${r.messages === 1 ? "" : "s"} · ${toolPct}% tool)`;
}

/** Largest first: the order the model should consider them in. */
export function formatRanges(ranges: readonly NudgeRange[]): string {
  return ranges.map((r) => `- ${formatRange(r)}`).join("\n");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const NONE: NudgeDecision = { kind: null, text: null };

/**
 * Emergency (window nearly full) is mandatory. Efficiency and promotion nudges are
 * advisory: the model may fold a subset or defer, and a declined nudge only returns
 * after another half step of growth/mass.
 */
export function decideNudge(
  state: NudgeState,
  ranges: readonly NudgeRange[],
  promotions: readonly PromotionCandidate[],
  cfg: NudgeConfig,
): NudgeDecision {
  if (state.nudgedThisTurn) return NONE;
  const total = ranges.reduce((s, r) => s + r.tokens, 0);

  if (state.windowFillPct >= cfg.emergencyFillPct && ranges.length > 0) {
    return {
      kind: "emergency",
      text:
        `[origami] Context is ${Math.round(state.windowFillPct * 100)}% full. Fold NOW before continuing; this is not optional.\n` +
        `Call \`fold\` on these ranges (largest first):\n` +
        `${formatRanges(ranges)}\n` +
        `Estimated reclaim: ~${formatTokens(total)} tokens.`,
    };
  }

  const cooldown = cfg.cooldownTurns ?? 2;
  const inCooldown =
    state.lastFoldTurn !== null &&
    state.lastFoldTurn !== undefined &&
    state.activeTurn !== undefined &&
    state.activeTurn < state.lastFoldTurn + cooldown;
  if (inCooldown) return NONE;

  const growthFloor =
    state.lastEfficiencyAtGrowth === null ? cfg.growthStep : state.lastEfficiencyAtGrowth + Math.ceil(cfg.growthStep / 2);
  const efficient =
    ranges.length > 0 &&
    total >= cfg.minFoldBenefit &&
    state.compressibleTokens >= cfg.compressibleFloor &&
    state.growthSinceFoldTokens >= growthFloor &&
    state.advisoryAllowed;
  // Check if any tier promotion candidate is eligible
  let activePromotion: { p: PromotionCandidate; toTier: 2 | 3 } | undefined;
  for (const p of state.promotionAllowed ? promotions : []) {
    const mass = p.fromTier === 1 ? cfg.tier2MassTokens : cfg.tier3MassTokens;
    const last = state.lastPromotionAtMass[p.fromTier];
    const floor = last === null ? mass : last + Math.ceil(mass / 2);
    if (p.blockIds.length < 2 || p.totalTokens < floor) continue;
    activePromotion = { p, toTier: (p.fromTier + 1) as 2 | 3 };
    break;
  }

  // Case 1: Compound Nudge (Both efficiency candidate ranges AND tier promotion are eligible)
  if (efficient && activePromotion) {
    const { p, toTier } = activePromotion;
    return {
      kind: "efficiency",
      text:
        `[origami] ${formatTokens(state.growthSinceFoldTokens)} tokens have accumulated since the last fold; ` +
        `${formatTokens(state.compressibleTokens)} are foldable.\n` +
        `Candidate ranges (largest first, ~${formatTokens(total)} tokens total):\n` +
        `${formatRanges(ranges)}\n` +
        `Additionally, ${p.blockIds.length} due tier-${p.fromTier} blocks hold ${formatTokens(p.tokens)} tokens of summaries (${p.blockIds.join(", ")}); the tier holds ${formatTokens(p.totalTokens)} and is eligible for tier-${toTier} distillation.\n` +
        `Wrap up candidate tier-1 ranges first to reclaim prompt space (or fold both in the same call).`,
    };
  }

  // Case 2: Standard Efficiency Nudge
  if (efficient) {
    return {
      kind: "efficiency",
      text:
        `[origami] ${formatTokens(state.growthSinceFoldTokens)} tokens have accumulated since the last fold; ` +
        `${formatTokens(state.compressibleTokens)} are foldable.\n` +
        `Candidate ranges (largest first, ~${formatTokens(total)} tokens total):\n` +
        `${formatRanges(ranges)}\n` +
        `Fold the ranges whose work is finished — all of them or a subset` +
        (cfg.minFoldBenefit > 0 ? ` reclaiming at least ~${formatTokens(cfg.minFoldBenefit)} tokens per call. ` : `. `) +
        `If a range is still in active use, defer it; this reminder returns after more growth.`,
    };
  }

  // Case 3: Tier Promotion Nudge (with warning if pending raw candidate ranges exist)
  if (activePromotion) {
    const { p, toTier } = activePromotion;
    const pendingNote = ranges.length > 0 && total >= cfg.minFoldBenefit
      ? `\nNotice: ~${formatTokens(total)} tokens of raw history are also foldable in candidate ranges (${ranges.map((r) => `${r.start}..${r.end}`).join(", ")}). Tier-1 folds reclaim prompt space, whereas tier-${toTier} distillation only consolidates summaries; consider wrapping up tier-1 ranges alongside or before promotion.`
      : "";
    return {
      kind: "promotion",
      promotion: { fromTier: p.fromTier, tokens: p.totalTokens, blockIds: p.blockIds },
      text:
        `[origami] ${p.blockIds.length} due tier-${p.fromTier} blocks hold ${formatTokens(p.tokens)} tokens of summaries (${formatTokens(p.totalTokens)} across the tier): ${p.blockIds.join(", ")}.\n` +
        `Consider merging related ones with \`fold\` tier ${toTier} (range \`"${p.blockIds.join(",")}"\` or a related subset of at least 2).` +
        pendingNote +
        ` Defer if they cover unrelated threads you still need apart.`,
    };
  }
  return NONE;
}

export interface RecommendBoundMessage {
  ref: string;
  ephemeral: boolean;
  turn: number;
  tokens: number;
  tool: boolean;
  role?: string;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string;
  text?: string;
  isError?: boolean;
}
export function recommendRanges(input: {
  bound: readonly RecommendBoundMessage[];
  foldedRefs: ReadonlySet<string>;
  /** First protected turn: only messages from strictly earlier turns are candidates. */
  protectedFromTurn: number;
  pinnedHeadRef?: string | null;
  maxRanges?: number;
}): NudgeRange[] {
  const { bound, foldedRefs, protectedFromTurn, pinnedHeadRef } = input;
  const pinnedTurn = pinnedHeadRef ? bound.find((m) => m.ref === pinnedHeadRef)?.turn ?? -1 : -1;
  const partnerMap = buildToolPairPartnerMap(bound);

  const rawRuns: { startIdx: number; endIdx: number }[] = [];
  let currentStart = -1;

  const pushRun = (startIdx: number, endIdx: number) => {
    while (endIdx >= startIdx && bound[endIdx]!.ephemeral) endIdx--;
    while (startIdx <= endIdx && bound[startIdx]!.ephemeral) startIdx++;
    if (startIdx <= endIdx && bound[startIdx]!.ref && bound[endIdx]!.ref) {
      rawRuns.push({ startIdx, endIdx });
    }
  };

  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    const isProtected = m.turn >= protectedFromTurn || m.turn === pinnedTurn;
    const isFolded = !m.ephemeral && foldedRefs.has(m.ref);

    if (isProtected || isFolded) {
      if (currentStart !== -1) {
        pushRun(currentStart, i - 1);
        currentStart = -1;
      }
      continue;
    }

    if (m.ephemeral) {
      // Intermediate ephemeral message within foldable region: allow run to continue across it,
      // but do not start a new run on an ephemeral message.
      continue;
    }

    if (currentStart === -1) {
      currentStart = i;
    }
  }
  if (currentStart !== -1) {
    pushRun(currentStart, bound.length - 1);
  }

  const cleanRuns: NudgeRange[] = [];
  const seenRanges = new Set<string>();

  for (const { startIdx: origStart, endIdx: origEnd } of rawRuns) {
    let start = origStart;
    let end = origEnd;
    let changed = true;

    while (changed && start <= end) {
      changed = false;
      const runRefs = new Set<string>();
      for (let k = start; k <= end; k++) runRefs.add(bound[k]!.ref);

      // Check if end needs trimming (e.g. caller missing its later result)
      for (let k = end; k >= start; k--) {
        const partners = partnerMap.get(bound[k]!.ref);
        if (!partners) continue;
        const missing = [...partners].some((p) => !runRefs.has(p) && !foldedRefs.has(p));
        if (missing) {
          end = k - 1;
          changed = true;
          break;
        }
      }

      if (!changed) {
        // Check if start needs trimming (e.g. result missing its earlier caller)
        for (let k = start; k <= end; k++) {
          const partners = partnerMap.get(bound[k]!.ref);
          if (!partners) continue;
          const missing = [...partners].some((p) => !runRefs.has(p) && !foldedRefs.has(p));
          if (missing) {
            start = k + 1;
            changed = true;
            break;
          }
        }
      }
    }

    while (end >= start && bound[end]!.ephemeral) end--;
    while (start <= end && bound[start]!.ephemeral) start++;

    if (start <= end && bound[start]!.ref && bound[end]!.ref) {
      let tokens = 0;
      let messages = 0;
      let toolTokens = 0;
      for (let k = start; k <= end; k++) {
        const m = bound[k]!;
        tokens += m.tokens;
        messages++;
        if (m.tool) toolTokens += m.tokens;
      }
      const key = `${bound[start]!.ref}..${bound[end]!.ref}`;
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        cleanRuns.push({
          start: bound[start]!.ref,
          end: bound[end]!.ref,
          tokens,
          messages,
          toolTokens,
        });
      }
    }
  }

  const max = input.maxRanges ?? 8;
  return cleanRuns.sort((a, b) => b.tokens - a.tokens).slice(0, max);
}

/**
 * Per source tier, the active blocks to merge into the next tier, and the tier's total summary
 * mass (what the promotion trigger compares against its floor).
 *
 * Which blocks: the most *due* first, where due = (newest ref − block's last ref) / refs the block
 * covers — how long ago the block ended, measured in its own size (Taelin's rollback-push order).
 * Blocks are taken in that order until they hold at least half the tier's mass (minimum 2), so
 * old history coarsens while recent blocks keep their detail, and summaries that were merged
 * least recently stay put longest. Young blocks (fewer than `matureFolds` later fold events)
 * are never selected.
 */
export function promotionCandidates(
  live: readonly { id: string; tier: 1 | 2 | 3; tokensAfter: number; ranges: readonly { start: string; end: string }[] }[],
  ages: ReadonlyMap<string, number>,
  matureFolds: number,
  newestRef: number,
): PromotionCandidate[] {
  const out: PromotionCandidate[] = [];
  const refNo = (ref: string): number => Number.parseInt(ref.slice(1), 10);
  for (const fromTier of [1, 2] as const) {
    const tier = live.filter((b) => b.tier === fromTier);
    const mature = tier.filter((b) => (ages.get(b.id) ?? 0) >= matureFolds && b.ranges.length > 0);
    if (mature.length === 0) continue;
    const mass = tier.reduce((s, b) => s + b.tokensAfter, 0);
    const due = (b: (typeof mature)[number]): number => {
      const covered = b.ranges.reduce((s, r) => s + refNo(r.end) - refNo(r.start) + 1, 0);
      const last = Math.max(...b.ranges.map((r) => refNo(r.end)));
      return (newestRef - last) / Math.max(1, covered);
    };
    const first = (b: (typeof mature)[number]): number => Math.min(...b.ranges.map((r) => refNo(r.start)));
    const byDue = [...mature].sort((a, b) => due(b) - due(a) || first(a) - first(b));
    const selected: typeof mature = [];
    let taken = 0;
    for (const b of byDue) {
      if (selected.length >= 2 && taken * 2 >= mass) break;
      selected.push(b);
      taken += b.tokensAfter;
    }
    selected.sort((a, b) => first(a) - first(b));
    out.push({ fromTier, blockIds: selected.map((b) => b.id), tokens: taken, totalTokens: mass });
  }
  return out;
}
