import type { Block } from "./types.ts";
import { parseRef } from "./types.ts";
import type { JournalOp } from "./journal.ts";

export type { JournalOp } from "./journal.ts";

export class BlockTree {
  private blocks = new Map<string, Block>();
  private order: string[] = [];
  private _version = 0;

  /** Monotonic: changes whenever a block is added, consumed, unfolded or re-summarised. */
  get version(): number {
    return this._version;
  }

  apply(op: JournalOp): void {
    this._version++;
    if (op.op === "fold") {
      const block: Block = { ...op.block, children: [...op.block.children], status: "active", consumedBy: null };
      // A committed fold is applied in memory and then replayed from the journal on the next
      // refresh; replacing in place keeps `order` free of duplicates.
      const existed = this.blocks.has(block.id);
      this.blocks.set(block.id, block);
      if (!existed) this.order.push(block.id);
      for (const childId of block.children) {
        const child = this.blocks.get(childId);
        if (!child) continue;
        child.status = "consumed";
        child.consumedBy = block.id;
      }
    } else if (op.op === "unfold") {
      const b = this.blocks.get(op.id);
      if (!b || b.status !== "active") return;
      b.status = "unfolded";
      // One level at a time: the parent's children take its place again.
      for (const childId of b.children) {
        const child = this.blocks.get(childId);
        if (child && child.status === "consumed" && child.consumedBy === b.id) {
          child.status = "active";
          child.consumedBy = null;
        }
      }
    } else {
      const b = this.blocks.get(op.id);
      if (b) {
        b.tier = op.tier;
        b.summary = op.summary;
        b.topic = op.topic;
        b.tokensBefore = op.tokensBefore;
        b.tokensAfter = op.tokensAfter;
      }
    }
  }

  get(id: string): Block | undefined {
    return this.blocks.get(id);
  }

  live(): Block[] {
    return this.order.map((id) => this.blocks.get(id)!).filter((b) => b.status === "active");
  }

  /** Every descendant of `id` (children first-level first), regardless of status. */
  descendants(id: string): Block[] {
    const out: Block[] = [];
    const queue = [...(this.blocks.get(id)?.children ?? [])];
    while (queue.length > 0) {
      const child = this.blocks.get(queue.shift()!);
      if (!child) continue;
      out.push(child);
      queue.push(...child.children);
    }
    return out;
  }

  all(): Block[] {
    return this.order.map((id) => this.blocks.get(id)!);
  }

  foldedRefs(): Set<string> {
    const out = new Set<string>();
    for (const b of this.live()) {
      for (const r of b.ranges) {
        const a = parseRef(r.start);
        const z = parseRef(r.end);
        for (let n = a; n <= z; n++) {
          out.add(`m${String(n).padStart(5, "0")}`);
        }
      }
    }
    return out;
  }

  /**
   * Ordinal of the newest message present at the most recent fold event (any status:
   * a later unfold does not reset growth). 0 when nothing was ever folded.
   */
  latestFoldAnchor(): number {
    let anchor = 0;
    for (const b of this.blocks.values()) anchor = Math.max(anchor, foldAnchor(b));
    return anchor;
  }

  /**
   * How many later fold events each block has survived. Blocks folded in one call share an
   * anchor, so a fold event is a distinct anchor; age counts distinct anchors newer than the block's.
   */
  foldAges(): Map<string, number> {
    const anchors = [...new Set([...this.blocks.values()].map(foldAnchor))].sort((a, b) => a - b);
    const out = new Map<string, number>();
    for (const b of this.blocks.values()) {
      const a = foldAnchor(b);
      let newer = 0;
      for (let i = anchors.length - 1; i >= 0 && anchors[i]! > a; i--) newer++;
      out.set(b.id, newer);
    }
    return out;
  }

  /** Apply journal ops in order; used by incremental replay. */
  applyOps(ops: readonly JournalOp[]): void {
    for (const op of ops) this.apply(op);
  }

  rebuild(ops: JournalOp[]): void {
    this.blocks.clear();
    this.order = [];
    this._version++;
    for (const op of ops) this.apply(op);
  }
}

/** Newest message ordinal present when the block was folded; legacy blocks fall back to their coverage end. */
function foldAnchor(b: Block): number {
  if (b.anchorRef) return parseRef(b.anchorRef);
  let n = 0;
  for (const r of b.ranges) n = Math.max(n, parseRef(r.end));
  return n;
}