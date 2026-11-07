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

export function selectElideCandidates(bound: readonly { ref: string; index: number; role: string; tokens: number; ephemeral: boolean; turn: number }[]): ElideCandidate[] {
  return bound.filter((m) => m.role === "toolResult" && !m.ephemeral && m.turn > 1).map((m) => ({ ref: m.ref, index: m.index, tokens: m.tokens, turn: m.turn }));
}