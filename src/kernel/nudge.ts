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
  blockIds: string[];
  /** Summed rendered size (tokensAfter) of those blocks. */
  tokens: number;
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
}
export type NudgeKind = "efficiency" | "emergency" | "promotion";

export interface NudgeDecision {
  kind: NudgeKind | null;
  text: string | null;
  /** Source tier of a promotion nudge, and the mass it fired at (for backoff). */
  promotion?: { fromTier: 1 | 2; tokens: number };
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
    state.growthSinceFoldTokens >= growthFloor;
  // Check if any tier promotion candidate is eligible
  let activePromotion: { p: PromotionCandidate; toTier: 2 | 3 } | undefined;
  for (const p of promotions) {
    const mass = p.fromTier === 1 ? cfg.tier2MassTokens : cfg.tier3MassTokens;
    const last = state.lastPromotionAtMass[p.fromTier];
    const floor = last === null ? mass : last + Math.ceil(mass / 2);
    if (p.blockIds.length < 2 || p.tokens < floor) continue;
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
        `Additionally, ${p.blockIds.length} tier-${p.fromTier} blocks hold ${formatTokens(p.tokens)} tokens of summaries (${p.blockIds.join(", ")}) and are eligible for tier-${toTier} distillation.\n` +
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
      promotion: { fromTier: p.fromTier, tokens: p.tokens },
      text:
        `[origami] ${p.blockIds.length} tier-${p.fromTier} blocks hold ${formatTokens(p.tokens)} tokens of summaries: ${p.blockIds.join(", ")}.\n` +
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
      cleanRuns.push({
        start: bound[start]!.ref,
        end: bound[end]!.ref,
        tokens,
        messages,
        toolTokens,
      });
    }
  }

  const max = input.maxRanges ?? 8;
  return cleanRuns.sort((a, b) => b.tokens - a.tokens).slice(0, max);
}

/**
 * Per source tier, the active blocks of that tier old enough to merge (oldest first) and their
 * summed size. Young blocks (fewer than `matureFolds` later fold events) keep their detail.
 */
export function promotionCandidates(
  live: readonly { id: string; tier: 1 | 2 | 3; tokensAfter: number }[],
  ages: ReadonlyMap<string, number>,
  matureFolds: number,
): PromotionCandidate[] {
  const out: PromotionCandidate[] = [];
  for (const fromTier of [1, 2] as const) {
    const blocks = live.filter((b) => b.tier === fromTier && (ages.get(b.id) ?? 0) >= matureFolds);
    if (blocks.length === 0) continue;
    out.push({ fromTier, blockIds: blocks.map((b) => b.id), tokens: blocks.reduce((s, b) => s + b.tokensAfter, 0) });
  }
  return out;
}
