export interface ElideCandidate {
  ref: string;
  index: number;
  tokens: number;
  turn: number;
}

export interface ElidePlan {
  elided: { ref: string; index: number; tokens: number }[];
  label(ref: string, tokens: number): string;
}

export const ELIDE_TAG_SUFFIX = "· elided";

export function elideLabel(ref: string, tokens: number): string {
  return `[#${ref} · ${tokens.toLocaleString()}t · elided]`;
}

export interface GuardThresholds {
  elideFillPct: number;
  targetFillPct: number;
}

export function planElision(input: {
  projectedTokens: number;
  windowTokens: number;
  candidates: readonly ElideCandidate[];
  thresholds: GuardThresholds;
}): ElidePlan {
  const { projectedTokens, windowTokens, candidates, thresholds } = input;
  const limit = Math.floor(windowTokens * thresholds.targetFillPct);
  const elided: { ref: string; index: number; tokens: number }[] = [];

  if (projectedTokens < windowTokens * thresholds.elideFillPct) {
    return { elided, label: elideLabel };
  }

  let current = projectedTokens;
  // Prefix-aware sorting: maximize reclaimed tokens while minimizing cache prefix destruction.
  // Candidates near the tail (higher index) invalidate far less prefix than candidates near the head.
  const maxIdx = candidates.reduce((m, c) => Math.max(m, c.index), 1);
  const sorted = [...candidates].sort((a, b) => {
    const costA = Math.max(1, maxIdx - a.index + 1);
    const costB = Math.max(1, maxIdx - b.index + 1);
    const ratioA = a.tokens / costA;
    const ratioB = b.tokens / costB;
    if (Math.abs(ratioA - ratioB) > 1e-4) return ratioB - ratioA;
    return b.tokens - a.tokens;
  });
  for (const c of sorted) {
    if (current <= limit) break;
    elided.push({ ref: c.ref, index: c.index, tokens: c.tokens });
    current -= c.tokens;
  }
  return { elided, label: elideLabel };
}

export function applyElision<T extends { role: string }>(
  messages: readonly T[],
  plan: ElidePlan,
  refOf: (m: T) => string,
  replace: (m: T, label: string) => T,
): T[] {
  const byIndex = new Map(plan.elided.map((e) => [e.index, e]));
  return messages.map((m, i) => {
    const hit = byIndex.get(i);
    return hit ? replace(m, elideLabel(hit.ref, hit.tokens)) : m;
  });
}

export interface ElideCandidateInput {
  ref: string;
  index: number;
  role: string;
  tokens: number;
  ephemeral: boolean;
  turn: number;
}

export interface ElideExclusions {
  /** Refs an active block already removes; eliding them would credit reclaim render never delivers. */
  foldedRefs: ReadonlySet<string>;
  /** Origami's own bookkeeping tool calls; they are never conversation content. */
  bookkeepingRefs: ReadonlySet<string>;
  /** First turn of the protected tail: recent turns stay verbatim. */
  protectedFromTurn: number;
  /** Current turn: its tool results are the task in progress. */
  activeTurn: number;
}

/**
 * Tool results that are safe to collapse: unfolded, not bookkeeping, and outside both the
 * protected tail and the active turn. Content is replaced by a ref label, so the original
 * stays recoverable with `fold_recall`; the message shell and its pairing stay intact.
 */
export function selectElideCandidates(bound: readonly ElideCandidateInput[], exclusions: ElideExclusions): ElideCandidate[] {
  return bound
    .filter(
      (m) =>
        m.role === "toolResult" &&
        !m.ephemeral &&
        m.turn > 1 &&
        m.turn !== exclusions.activeTurn &&
        m.turn < exclusions.protectedFromTurn &&
        !exclusions.foldedRefs.has(m.ref) &&
        !exclusions.bookkeepingRefs.has(m.ref),
    )
    .map((m) => ({ ref: m.ref, index: m.index, tokens: m.tokens, turn: m.turn }));
}