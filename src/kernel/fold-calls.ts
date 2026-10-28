import type { BoundMessage } from "./types.ts";

/** Tools whose finished calls are pure bookkeeping once their turn has ended. */
export const FOLD_TOOL_NAMES: ReadonlySet<string> = new Set(["fold"]);

/**
 * Refs of finished fold calls to drop from the outbound context: assistant
 * messages from completed turns whose tool calls are all `fold`, plus their
 * tool results. The block a fold created already carries its content, so the
 * call/result pair only repeats it. Call and result are hidden together, so
 * tool-call pairing stays intact.
 */
export function hiddenFoldCalls(bound: readonly BoundMessage[], protectedFromTurn: number): Set<string> {
  const hidden = new Set<string>();
  const callIds = new Set<string>();
  for (const m of bound) {
    if (m.role !== "assistant" || m.turn >= protectedFromTurn) continue;
    const calls = m.toolCalls;
    if (!calls || calls.length === 0) continue;
    if (!calls.every((c) => FOLD_TOOL_NAMES.has(c.name))) continue;
    hidden.add(m.ref);
    for (const c of calls) callIds.add(c.id);
  }
  if (callIds.size === 0) return hidden;
  for (const m of bound) {
    if (m.role === "toolResult" && m.toolCallId && callIds.has(m.toolCallId)) hidden.add(m.ref);
  }
  return hidden;
}
