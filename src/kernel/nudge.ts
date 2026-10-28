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
  /** Growth at which the last efficiency nudge fired since the last fold; null if none. */
  lastEfficiencyAtGrowth: number | null;
  /** Mass at which the last promotion nudge fired per source tier; null if none. */
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

  const growthFloor =
    state.lastEfficiencyAtGrowth === null ? cfg.growthStep : state.lastEfficiencyAtGrowth + Math.ceil(cfg.growthStep / 2);
  const efficient =
    ranges.length > 0 &&
    total >= cfg.minFoldBenefit &&
    state.compressibleTokens >= cfg.compressibleFloor &&
    state.growthSinceFoldTokens >= growthFloor;
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

  for (const p of promotions) {
    const mass = p.fromTier === 1 ? cfg.tier2MassTokens : cfg.tier3MassTokens;
    const last = state.lastPromotionAtMass[p.fromTier];
    const floor = last === null ? mass : last + Math.ceil(mass / 2);
    if (p.blockIds.length < 2 || p.tokens < floor) continue;
    const toTier = p.fromTier + 1;
    return {
      kind: "promotion",
      promotion: { fromTier: p.fromTier, tokens: p.tokens },
      text:
        `[origami] ${p.blockIds.length} tier-${p.fromTier} blocks hold ${formatTokens(p.tokens)} tokens of summaries: ${p.blockIds.join(", ")}.\n` +
        `Consider merging related ones with \`fold\` tier ${toTier} (range \`"${p.blockIds.join(",")}"\` or a related subset of at least 2). ` +
        `Defer if they cover unrelated threads you still need apart.`,
    };
  }
  return NONE;
}

export function recommendRanges(input: {
  bound: readonly { ref: string; ephemeral: boolean; turn: number; tokens: number; tool: boolean }[];
  foldedRefs: ReadonlySet<string>;
  /** First protected turn: only messages from strictly earlier turns are candidates. */
  protectedFromTurn: number;
  pinnedHeadRef?: string | null;
  maxRanges?: number;
}): NudgeRange[] {
  const { bound, foldedRefs, protectedFromTurn, pinnedHeadRef } = input;
  const pinnedTurn = pinnedHeadRef ? bound.find((m) => m.ref === pinnedHeadRef)?.turn ?? -1 : -1;
  const runs: NudgeRange[] = [];
  let run: NudgeRange | null = null;

  for (const m of bound) {
    const foldable = !m.ephemeral && !foldedRefs.has(m.ref) && m.turn < protectedFromTurn && m.turn !== pinnedTurn;
    if (!foldable) {
      if (run) runs.push(run);
      run = null;
      continue;
    }
    run ??= { start: m.ref, end: m.ref, tokens: 0, messages: 0, toolTokens: 0 };
    run.end = m.ref;
    run.tokens += m.tokens;
    run.messages++;
    if (m.tool) run.toolTokens += m.tokens;
  }
  if (run) runs.push(run);

  const max = input.maxRanges ?? 8;
  return runs.sort((a, b) => b.tokens - a.tokens).slice(0, max);
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
