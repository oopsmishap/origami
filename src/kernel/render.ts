import type { Block, BoundMessage, RefRange } from "./types.ts";
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
  return `${TIER_HEADERS[block.tier]} ${block.id}${coverage ? ` (${coverage})` : ""} — ${block.topic}\n${block.summary}`;
}

function refInRanges(ref: string, ranges: readonly RefRange[]): boolean {
  const n = parseRef(ref);
  for (const r of ranges) {
    if (n >= parseRef(r.start) && n <= parseRef(r.end)) return true;
  }
  return false;
}

function coveredIndices(bound: readonly BoundMessage[], block: Block): number[] {
  const out: number[] = [];
  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    if (m.ephemeral) continue;
    if (refInRanges(m.ref, block.ranges)) out.push(i);
  }
  return out;
}

export function planRender(input: {
  bound: readonly BoundMessage[];
  blocks: readonly Block[];
  pinnedHeadIndex: number;
}): RenderOp[] {
  const { bound, blocks, pinnedHeadIndex } = input;
  const ops: RenderOp[] = [];
  const removed = new Set<number>();

  for (const block of blocks) {
    const indices = coveredIndices(bound, block);
    if (indices.length === 0) continue;
    for (const i of indices) {
      if (i < pinnedHeadIndex) continue;
      removed.add(i);
    }

    const first = indices[0]!;
    const anchor = first < pinnedHeadIndex ? pinnedHeadIndex : first;
    ops.push({
      kind: "insert",
      index: anchor,
      blockId: block.id,
      text: renderBlockText(block),
      refTag: `[#${bound[first]!.ref}]`,
    });
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
  const indices = coveredIndices(bound, block);
  return indices.length === 0 ? null : bound[indices[0]!]!.ref;
}

export function expandRefRange(start: string, end: string): string[] {
  const a = parseRef(start);
  const z = parseRef(end);
  const out: string[] = [];
  for (let n = a; n <= z; n++) out.push(`m${String(n).padStart(5, "0")}`);
  return out;
}