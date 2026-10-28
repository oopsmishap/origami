export interface NudgeRange {
  start: string;
  end: string;
  tokens: number;
}

export interface NudgeState {
  growthSinceFoldTokens: number;
  compressibleTokens: number;
  windowFillPct: number;
  nudgedThisTurn: boolean;
}

export interface NudgeDecision {
  kind: "efficiency" | "emergency" | null;
  text: string | null;
}

export interface NudgeConfig {
  growthStep: number;
  compressibleFloor: number;
  emergencyFillPct: number;
}

export function formatRanges(ranges: readonly NudgeRange[]): string {
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  return sorted.map((r) => `${r.start}..${r.end} (${r.tokens.toLocaleString()}t)`).join(", ");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function decideNudge(state: NudgeState, ranges: readonly NudgeRange[], cfg: NudgeConfig): NudgeDecision {
  if (state.nudgedThisTurn) return { kind: null, text: null };
  const total = ranges.reduce((s, r) => s + r.tokens, 0);

  if (state.windowFillPct >= cfg.emergencyFillPct) {
    return {
      kind: "emergency",
      text:
        `[origami] Context is ${Math.round(state.windowFillPct * 100)}% full. Fold NOW before continuing.\n` +
        `Call the \`fold\` tool on these ranges immediately:\n` +
        `${formatRanges(ranges)}\n` +
        `Estimated reclaim: ${formatTokens(total)} tokens.`,
    };
  }

  const eligible = state.compressibleTokens >= cfg.compressibleFloor && state.growthSinceFoldTokens >= cfg.growthStep;
  if (!eligible || ranges.length === 0) return { kind: null, text: null };

  return {
    kind: "efficiency",
    text:
      `[origami] ${formatTokens(state.growthSinceFoldTokens)} tokens accumulated since the last fold. ` +
      `${formatTokens(state.compressibleTokens)} compressible tokens are available.\n` +
      `Fold these ranges to reclaim ~${formatTokens(total)} tokens:\n` +
      `${formatRanges(ranges)}\n` +
      `Respond by calling \`fold\` with exactly these ranges.`,
  };
}

export function recommendRanges(input: {
  bound: readonly { ref: string; ephemeral: boolean; turn: number; tokens: number }[];
  foldedRefs: ReadonlySet<string>;
  activeTurn: number;
  pinnedHeadRef?: string | null;
  maxRanges?: number;
}): NudgeRange[] {
  const { bound, foldedRefs, activeTurn, pinnedHeadRef } = input;
  const pinnedTurn = pinnedHeadRef ? bound.find((m) => m.ref === pinnedHeadRef)?.turn ?? -1 : -1;
  const runs: NudgeRange[] = [];
  let runStart: string | null = null;
  let runEnd = "";
  let runTokens = 0;

  for (const m of bound) {
    const foldable = !m.ephemeral && !foldedRefs.has(m.ref) && m.turn < activeTurn && m.turn !== pinnedTurn;
    if (foldable) {
      if (runStart === null) runStart = m.ref;
      runEnd = m.ref;
      runTokens += m.tokens;
    } else {
      if (runStart !== null) runs.push({ start: runStart, end: runEnd, tokens: runTokens });
      runStart = null;
      runTokens = 0;
    }
  }
  if (runStart !== null) runs.push({ start: runStart, end: runEnd, tokens: runTokens });

  const max = input.maxRanges ?? 8;
  return runs.sort((a, b) => b.tokens - a.tokens).slice(0, max);
}