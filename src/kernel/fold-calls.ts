import type { BoundMessage } from "./types.ts";

/** Tools whose historical calls duplicate content already carried by their block. */
export const FOLD_TOOL_NAMES: ReadonlySet<string> = new Set(["fold"]);

/**
 * Refs of completed historical fold call/result pairs. They remain in outbound
 * context so the host retains the durable record of executed tool actions, but
 * are excluded from fold economics because their block already carries the
 * useful content.
 */
export function historicalFoldCallRefs(bound: readonly BoundMessage[], protectedFromTurn: number): Set<string> {
  const refs = new Set<string>();
  const callIds = new Set<string>();
  for (const m of bound) {
    if (m.role !== "assistant" || m.turn >= protectedFromTurn) continue;
    const calls = m.toolCalls;
    if (!calls || calls.length === 0) continue;
    if (!calls.every((c) => FOLD_TOOL_NAMES.has(c.name))) continue;
    refs.add(m.ref);
    for (const c of calls) callIds.add(c.id);
  }
  if (callIds.size === 0) return refs;
  for (const m of bound) {
    if (m.role === "toolResult" && m.toolCallId && callIds.has(m.toolCallId)) refs.add(m.ref);
  }
  return refs;
}
