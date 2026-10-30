import type { EngineContext, FoldMessageHit, FoldSearchHit } from "./engine-types.ts";
import { parseRef } from "./kernel/types.ts";
import { expandRefRange } from "./kernel/render.ts";
import { extractPlanTerms, rerankHitsWithPlan } from "./kernel/plan-search.ts";
import { formatRecallHints, matchRecallHints, type RecallHint } from "./kernel/recall-hints.ts";
import { formatHydration, matchHydration, type HydrationMatch } from "./kernel/hydration.ts";

/** Origami's own tools: their calls and results describe folded work, not the task at hand. */
const ORIGAMI_TOOLS: ReadonlySet<string> = new Set(["fold", "fold_candidate", "fold_recall", "fold_search", "fold_status", "fold_cache"]);

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

/**
 * Text of the active turn that recall hints and hydration match against: what the user and
 * the assistant wrote, plus the arguments of non-Origami tool calls. Tool results are
 * excluded — file contents and command output mention paths and words (imports, `false`)
 * that say nothing about the work at hand. Origami's own calls are excluded too: otherwise
 * every fold immediately re-surfaces the block it just created.
 */
function activeTurnProbe(context: Readonly<EngineContext>): string {
  const parts: string[] = [];
  for (const m of context.state.bound) {
    if (m.ephemeral || m.turn !== context.activeTurn) continue;
    if (m.role === "user") parts.push(m.text);
    else if (m.role === "assistant") {
      parts.push(m.prose);
      for (const call of m.toolCalls ?? []) if (!ORIGAMI_TOOLS.has(call.name)) parts.push(JSON.stringify(call.arguments ?? null));
    }
  }
  return parts.join("\n");
}

/**
 * Blocks not to newly surface: shown within the last `quietTurns` turns (including this one;
 * notes already shown this turn are carried by `TurnNotes`), or folded during the active turn.
 */
function quietBlocks(
  shownAt: ReadonlyMap<string, number>,
  foldedInTurn: ReadonlyMap<string, number>,
  activeTurn: number,
  quietTurns: number,
): Set<string> {
  const exclude = new Set<string>();
  for (const [id, turn] of shownAt) {
    const age = activeTurn - turn;
    if (age >= 0 && age <= quietTurns) exclude.add(id);
  }
  for (const [id, turn] of foldedInTurn) if (turn === activeTurn) exclude.add(id);
  return exclude;
}

/**
 * Notes surfaced during the active turn. Tail notes are not persisted, so a note shown on one
 * tool step would vanish on the next; instead the turn's notes are resent verbatim on every
 * step (new matches append), and dropped once their block is folded away or the turn ends.
 */
export interface TurnNotes {
  turn: number;
  hints: RecallHint[];
  hydration: HydrationMatch[];
}

export function emptyTurnNotes(): TurnNotes {
  return { turn: 0, hints: [], hydration: [] };
}

function turnNotesFor(context: Readonly<EngineContext>, notes: TurnNotes, foldedInTurn: ReadonlyMap<string, number>): TurnNotes {
  if (notes.turn !== context.activeTurn) {
    notes.turn = context.activeTurn;
    notes.hints = [];
    notes.hydration = [];
  }
  const live = new Set(context.state.tree.live().map((b) => b.id));
  const keep = (id: string) => live.has(id) && foldedInTurn.get(id) !== context.activeTurn;
  notes.hints = notes.hints.filter((h) => keep(h.blockId));
  notes.hydration = notes.hydration.filter((h) => keep(h.blockId));
  return notes;
}

export function recallHintText(
  context: Readonly<EngineContext>,
  hintedAt: Map<string, number>,
  quietTurns: number,
  foldedInTurn: ReadonlyMap<string, number>,
  notes: TurnNotes,
): string | null {
  const max = context.config.recallHintMax;
  if (max <= 0) return null;
  const turn = turnNotesFor(context, notes, foldedInTurn);
  const room = max - turn.hints.length;
  if (room > 0) {
    const probe = activeTurnProbe(context);
    const exclude = quietBlocks(hintedAt, foldedInTurn, context.activeTurn, quietTurns);
    for (const hint of matchRecallHints({ blocks: context.state.tree.live(), probe, exclude, max: room })) {
      hintedAt.set(hint.blockId, context.activeTurn);
      turn.hints.push(hint);
    }
  }
  return turn.hints.length > 0 ? formatRecallHints(turn.hints) : null;
}

export function hydrationText(
  context: Readonly<EngineContext>,
  hydratedAt: Map<string, number>,
  quietTurns: number,
  foldedInTurn: ReadonlyMap<string, number>,
  notes: TurnNotes,
): string | null {
  if (!context.config.hydration) return null;
  const maxBlocks = context.config.hydrationMaxBlocks;
  if (maxBlocks <= 0) return null;
  const turn = turnNotesFor(context, notes, foldedInTurn);
  const room = maxBlocks - turn.hydration.length;
  const probe = room > 0 ? activeTurnProbe(context) : "";
  if (room > 0 && probe.trim().length > 0) {
    const exclude = quietBlocks(hydratedAt, foldedInTurn, context.activeTurn, quietTurns);
    const matches = matchHydration({
      blocks: context.state.tree.live(),
      probe,
      exclude,
      maxBlocks: room,
      maxRecordsPerBlock: context.config.hydrationMaxRecords,
      mode: context.config.hydrationMode,
    });
    for (const match of matches) {
      hydratedAt.set(match.blockId, context.activeTurn);
      turn.hydration.push(match);
    }
  }
  return turn.hydration.length > 0 ? formatHydration(turn.hydration) : null;
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
