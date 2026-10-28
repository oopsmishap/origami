import type { BoundMessage } from "./types.ts";

/** Tools whose calls represent Origami bookkeeping rather than conversational payload. */
export const FOLD_TOOL_NAMES: Record<string, true> = {
  fold: true,
  unfold: true,
  fold_recall: true,
  fold_search: true,
  fold_status: true,
  fold_cache: true,
};

/**
 * Refs of completed fold and bookkeeping call/result pairs. They remain in outbound
 * context so the host retains the durable record of executed tool actions, but
 * are excluded from fold economics and growth calculations across all turns (#5058).
 */
export function historicalFoldCallRefs(bound: readonly BoundMessage[], _protectedFromTurn?: number): Set<string> {
  const refs = new Set<string>();
  const callIds = new Set<string>();
  for (const m of bound) {
    if (m.role !== "assistant") continue;
    const calls = m.toolCalls;
    if (!calls || calls.length === 0) continue;
    if (!calls.every((c) => Boolean(FOLD_TOOL_NAMES[c.name]))) continue;
    refs.add(m.ref);
    for (const c of calls) callIds.add(c.id);
  }
  if (callIds.size === 0) return refs;
  for (const m of bound) {
    if (m.role === "toolResult" && m.toolCallId && callIds.has(m.toolCallId)) refs.add(m.ref);
  }
  return refs;
}
