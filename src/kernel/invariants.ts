import type { Block } from "./types.ts";
import { parseRef } from "./types.ts";
import { expandRefRange } from "./render.ts";

export type InvariantKind = "duplicate-coverage" | "active-child" | "orphan-consumed" | "missing-child" | "off-branch";

export interface InvariantViolation {
  kind: InvariantKind;
  blockId: string;
  detail: string;
}

/**
 * Structural checks over the block tree. A healthy tree represents every source
 * message at most once in the rendered context:
 * - no ref is covered by two active blocks;
 * - an active block never has an active child (the child must be consumed);
 * - a consumed block points at an existing parent that is itself active or consumed;
 * - every child id exists;
 * - with `boundRefs`, every active block covers at least one message on the current
 *   branch (otherwise its summary silently drops out of context).
 */
export function checkInvariants(blocks: readonly Block[], boundRefs?: ReadonlySet<string>): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const owner = new Map<number, string>();

  for (const b of blocks) {
    for (const childId of b.children) {
      const child = byId.get(childId);
      if (!child) {
        out.push({ kind: "missing-child", blockId: b.id, detail: `${b.id} lists unknown child ${childId}` });
      } else if (b.status === "active" && child.status === "active") {
        out.push({ kind: "active-child", blockId: b.id, detail: `${b.id} and its child ${childId} are both active` });
      }
    }
    if (b.status === "consumed") {
      const parent = b.consumedBy ? byId.get(b.consumedBy) : undefined;
      if (!parent || parent.status === "unfolded" || !parent.children.includes(b.id)) {
        out.push({ kind: "orphan-consumed", blockId: b.id, detail: `${b.id} is consumed by ${b.consumedBy ?? "nothing"}, which does not hold it` });
      }
    }
    if (b.status !== "active") continue;
    if (boundRefs && !b.ranges.some((r) => expandRefRange(r.start, r.end).some((ref) => boundRefs.has(ref)))) {
      out.push({ kind: "off-branch", blockId: b.id, detail: `${b.id} covers no message on the current branch` });
    }
    let clash: string | null = null;
    for (const r of b.ranges) {
      for (let n = parseRef(r.start); n <= parseRef(r.end); n++) {
        const prev = owner.get(n);
        if (prev && prev !== b.id) clash ??= prev;
        else owner.set(n, b.id);
      }
    }
    if (clash) out.push({ kind: "duplicate-coverage", blockId: b.id, detail: `${b.id} overlaps active block ${clash}` });
  }
  return out;
}

/**
 * Active blocks safe to render: a block that re-covers refs already owned by an earlier
 * active block is skipped so no source is represented twice, even in a damaged tree.
 */
export function renderableBlocks(live: readonly Block[]): Block[] {
  const owned = new Set<number>();
  const out: Block[] = [];
  for (const b of live) {
    const nums: number[] = [];
    let clash = false;
    for (const r of b.ranges) {
      for (let n = parseRef(r.start); n <= parseRef(r.end); n++) {
        if (owned.has(n)) clash = true;
        nums.push(n);
      }
    }
    if (clash) continue;
    for (const n of nums) owned.add(n);
    out.push(b);
  }
  return out;
}
