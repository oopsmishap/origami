import type { Block, BoundMessage } from "./types.ts";
import { parseRef } from "./types.ts";

export interface RenderOp {
  kind: "remove" | "insert";
  index: number;
  text?: string;
  blockId?: string;
  refTag?: string;
}

export const TIER_HEADERS = {
  1: "[Compressed conversation section]",
  2: "[Distilled conversation summary]",
  3: "[Ultra-condensed conversation summary]",
} as const;

/** Header names the block and its coverage so the model can recall, unfold, or merge it. */
export function renderBlockText(block: Block): string {
  const coverage = block.ranges.map((r) => (r.start === r.end ? r.start : `${r.start}..${r.end}`)).join(",");
  let text = `${TIER_HEADERS[block.tier]} ${block.id}${coverage ? ` (${coverage})` : ""} — ${block.topic}\n${block.summary}`;
  if (block.ledger && block.ledger.length > 0) {
    text += `\nPinned:\n${block.ledger.map((r) => `- [${r.kind}] ${r.text}${r.ref ? ` (${r.ref})` : ""}`).join("\n")}`;
  }
  if (block.missing && block.missing.length > 0) {
    text += `\nAlso covered (fold_recall for detail): ${block.missing.join("; ")}`;
  }
  return text;
}

/** Prefix a raw user/tool-result message with its `[#mNNNNN]` ref so the model can cite it. */
export function withRefTag<T>(message: T, ref: string): T {
  const raw = message as { content?: unknown };
  const tag = `[#${ref}]`;
  if (typeof raw.content === "string") return { ...(message as object), content: `${tag} ${raw.content}` } as T;
  if (Array.isArray(raw.content)) return { ...(message as object), content: [{ type: "text", text: tag }, ...raw.content] } as T;
  return message;
}

/** Non-ephemeral ref ordinal -> bound index. Refs are assigned per journal entry. */
function refIndex(bound: readonly BoundMessage[]): Map<number, number> {
  const byRef = new Map<number, number>();
  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    if (m.ephemeral) continue;
    byRef.set(parseRef(m.ref), i);
  }
  return byRef;
}

/**
 * Indices a block covers, plus the lowest one. Blocks are disjoint by invariant, so the
 * total work across a plan is O(bound + covered refs) instead of O(blocks × bound).
 */
function coveredIndices(byRef: ReadonlyMap<number, number>, block: Block): { indices: number[]; first: number } {
  const indices: number[] = [];
  let first = -1;
  for (const r of block.ranges) {
    const a = parseRef(r.start);
    const z = parseRef(r.end);
    for (let n = a; n <= z; n++) {
      const i = byRef.get(n);
      if (i === undefined) continue;
      indices.push(i);
      if (first === -1 || i < first) first = i;
    }
  }
  return { indices, first };
}

export function planRender(input: {
  bound: readonly BoundMessage[];
  blocks: readonly Block[];
  pinnedHeadIndex: number;
}): RenderOp[] {
  const { bound, blocks, pinnedHeadIndex } = input;
  const ops: RenderOp[] = [];
  const removed = new Set<number>();
  const byRef = refIndex(bound);

  for (const block of blocks) {
    const { indices, first } = coveredIndices(byRef, block);
    if (indices.length === 0) continue;
    for (const i of indices) {
      if (i < pinnedHeadIndex) continue;
      removed.add(i);
    }

    const anchor = first < pinnedHeadIndex ? pinnedHeadIndex : first;
    ops.push({
      kind: "insert",
      index: anchor,
      blockId: block.id,
      text: renderBlockText(block),
      refTag: `[#${bound[first]!.ref}]`,
    });
  }

  // Nearest non-ephemeral neighbours and per-turn counts, computed once: deciding whether an
  // ephemeral reminder sits inside folded history is then O(1) instead of two array scans.
  const prevNonEph = new Int32Array(bound.length).fill(-1);
  const nextNonEph = new Int32Array(bound.length).fill(-1);
  const turnTotal = new Map<number, number>();
  const turnRemoved = new Map<number, number>();
  let prev = -1;
  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    prevNonEph[i] = prev;
    if (m.ephemeral) continue;
    prev = i;
    turnTotal.set(m.turn, (turnTotal.get(m.turn) ?? 0) + 1);
    if (removed.has(i)) turnRemoved.set(m.turn, (turnRemoved.get(m.turn) ?? 0) + 1);
  }
  let next = -1;
  for (let i = bound.length - 1; i >= 0; i--) {
    nextNonEph[i] = next;
    if (!bound[i]!.ephemeral) next = i;
  }

  // Remove obsolete ephemeral developer/system messages inside folded history:
  // 1. both nearest non-ephemeral neighbours are removed (surrounded by folded history), OR
  // 2. every non-ephemeral message in its turn is removed.
  for (let i = pinnedHeadIndex; i < bound.length; i++) {
    const m = bound[i]!;
    if (!m.ephemeral || removed.has(i)) continue;
    const before = prevNonEph[i]!;
    const after = nextNonEph[i]!;
    if (before !== -1 && removed.has(before) && after !== -1 && removed.has(after)) {
      removed.add(i);
      continue;
    }
    const total = turnTotal.get(m.turn) ?? 0;
    if (m.turn > 0 && total > 0 && (turnRemoved.get(m.turn) ?? 0) >= total) removed.add(i);
  }

  for (const i of [...removed].sort((a, b) => a - b)) {
    ops.push({ kind: "remove", index: i });
  }
  return ops;
}

export function applyRender<TIn, TOut>(
  messages: readonly TIn[],
  ops: readonly RenderOp[],
  makeFoldMessage: (text: string, blockId: string, refTag?: string) => TOut,
): (TIn | TOut)[] {
  const removals = new Set<number>();
  const inserts = new Map<number, RenderOp[]>();
  for (const op of ops) {
    if (op.kind === "remove") removals.add(op.index);
    else {
      const list = inserts.get(op.index);
      if (list) list.push(op);
      else inserts.set(op.index, [op]);
    }
  }

  const out: (TIn | TOut)[] = [];
  for (let i = 0; i < messages.length; i++) {
    const inserted = inserts.get(i);
    if (inserted) {
      for (const op of inserted) out.push(makeFoldMessage(op.text ?? "", op.blockId ?? "", op.refTag));
    }
    if (!removals.has(i)) out.push(messages[i]!);
  }
  const tail = inserts.get(messages.length);
  if (tail) {
    for (const op of tail) out.push(makeFoldMessage(op.text ?? "", op.blockId ?? "", op.refTag));
  }
  return out;
}

export function parseRefTag(tag: string): string | null {
  const m = /^\[#(m\d{5,})\]$/.exec(tag);
  return m ? m[1]! : null;
}

export function foldCoverageStats(bound: readonly BoundMessage[], foldedRefs: ReadonlySet<string>) {
  let folded = 0;
  let live = 0;
  for (const m of bound) {
    if (m.ephemeral) continue;
    if (foldedRefs.has(m.ref)) folded++;
    else live++;
  }
  return { folded, live };
}

export function blockAnchorRef(bound: readonly BoundMessage[], block: Block): string | null {
  const { indices, first } = coveredIndices(refIndex(bound), block);
  return indices.length === 0 ? null : bound[first]!.ref;
}

export function expandRefRange(start: string, end: string): string[] {
  const a = parseRef(start);
  const z = parseRef(end);
  const out: string[] = [];
  for (let n = a; n <= z; n++) out.push(`m${String(n).padStart(5, "0")}`);
  return out;
}