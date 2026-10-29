import type { EngineContext, FoldMessageHit, FoldSearchHit } from "./engine-types.ts";
import { parseRef } from "./kernel/types.ts";
import { expandRefRange } from "./kernel/render.ts";
import { extractPlanTerms, rerankHitsWithPlan } from "./kernel/plan-search.ts";
import { formatRecallHints, matchRecallHints } from "./kernel/recall-hints.ts";
import { formatHydration, matchHydration } from "./kernel/hydration.ts";

export interface RecalledMessage { ref: string; role: string | null; text: string | null; source: "context" | "archive" | "missing" }

export function recall(context: Readonly<EngineContext>, refs: readonly string[]): RecalledMessage[] {
  const byRef = new Map(context.state.bound.map((message) => [message.ref, message]));
  const missing = refs.filter((ref) => !byRef.has(ref));
  const archived = new Map(context.db && missing.length > 0 ? context.db.messagesForRefs(context.host.sessionId(), missing).map((row) => [row.ref, row]) : []);
  return refs.map((ref) => {
    const message = byRef.get(ref);
    if (message) return { ref, role: message.role, text: message.text, source: "context" as const };
    const row = archived.get(ref);
    if (row) return { ref, role: row.role, text: row.text, source: "archive" as const };
    return { ref, role: null, text: null, source: "missing" as const };
  });
}

export function searchBlocks(context: Readonly<EngineContext>, query: string, limit = 10, planAware = true): FoldSearchHit[] {
  if (!context.db) return [];
  const poolLimit = planAware ? Math.max(limit * 2, 20) : limit;
  const hits = context.db.searchBlocks(query, poolLimit).map((row) => ({ blockId: row.block_id, sessionId: row.session_id, tier: row.tier, topic: row.topic, status: row.status, snippet: row.snippet, rank: row.rank }));
  return (planAware ? rerankHitsWithPlan(hits, extractPlanTerms(context.state.bound)) : hits).slice(0, limit);
}

export function searchMessages(context: Readonly<EngineContext>, query: string, limit = 10): FoldMessageHit[] {
  if (!context.db) return [];
  const own = context.host.sessionId();
  return context.db.searchMessages(query, limit).map((row) => ({ sessionId: row.session_id, ref: row.ref, role: row.role, turn: row.turn, snippet: row.snippet, rank: row.rank, ownSession: row.session_id === own }));
}

export function recallHintText(context: Readonly<EngineContext>, hintedAt: Map<string, number>, quietTurns = 5): string | null {
  const max = context.config.recallHintMax;
  if (max <= 0) return null;
  const probe = context.state.bound.filter((message) => !message.ephemeral && message.turn === context.activeTurn).map((message) => message.text).join("\n");
  const exclude = new Set<string>();
  for (const [id, turn] of hintedAt) {
    const age = context.activeTurn - turn;
    if (age >= 1 && age <= quietTurns) exclude.add(id);
  }
  const hints = matchRecallHints({ blocks: context.state.tree.live(), probe, exclude, max });
  if (hints.length === 0) return null;
  for (const hint of hints) hintedAt.set(hint.blockId, context.activeTurn);
  return formatRecallHints(hints);
}

export function hydrationText(context: Readonly<EngineContext>, hydratedAt: Map<string, number>, quietTurns = 3): string | null {
  if (!context.config.hydration) return null;
  const maxBlocks = context.config.hydrationMaxBlocks;
  if (maxBlocks <= 0) return null;
  const probe = context.state.bound.filter((message) => !message.ephemeral && message.turn === context.activeTurn).map((message) => message.text).join("\n");
  if (!probe || probe.trim().length === 0) return null;
  const exclude = new Set<string>();
  for (const [id, turn] of hydratedAt) {
    const age = context.activeTurn - turn;
    if (age >= 1 && age <= quietTurns) exclude.add(id);
  }
  const matches = matchHydration({
    blocks: context.state.tree.live(),
    probe,
    exclude,
    maxBlocks,
    maxRecordsPerBlock: context.config.hydrationMaxRecords,
    mode: context.config.hydrationMode,
  });
  if (matches.length === 0) return null;
  for (const match of matches) hydratedAt.set(match.blockId, context.activeTurn);
  return formatHydration(matches);
}
export async function unfoldArtifact(context: Readonly<EngineContext>, id: string): Promise<{ ok: true; path: string; refs: string[]; toc: string } | { ok: false; error: string }> {
  const block = context.state.tree.get(id);
  if (!block) return { ok: false, error: `unknown block: ${id}` };
  const refs = block.ranges.flatMap((range) => expandRefRange(range.start, range.end));
  const lines: string[] = [`# ${block.id} — ${block.topic}`, ""];
  const recalled = new Map(recall(context, refs).map((message) => [message.ref, message]));
  for (const ref of refs) {
    const message = recalled.get(ref);
    const label = message?.source === "archive" ? `${message.role}, archived` : message?.role;
    lines.push(`## ${ref}${label ? ` (${label})` : ""}`, message?.text ?? "<not in current branch view or archive>", "");
  }
  const path = await context.host.saveArtifact(lines.join("\n"), `origami-unfold-${id}`);
  return { ok: true, path: path ?? "", refs, toc: refs.map((ref) => `- ${ref}`).join("\n") };
}
