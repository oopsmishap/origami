export interface ElideCandidate {
  ref: string;
  index: number;
  tokens: number;
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
  const sorted = [...candidates].sort((a, b) => b.tokens - a.tokens);
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

export function selectElideCandidates(bound: readonly { ref: string; index: number; role: string; tokens: number; ephemeral: boolean }[]): ElideCandidate[] {
  return bound.filter((m) => m.role === "toolResult" && !m.ephemeral).map((m) => ({ ref: m.ref, index: m.index, tokens: m.tokens }));
}