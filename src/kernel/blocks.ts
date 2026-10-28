import type { Block, RefRange } from "./types.ts";
import { parseRef } from "./types.ts";

export interface JournalFoldOp {
  op: "fold";
  block: Block;
}

export interface JournalUnfoldOp {
  op: "unfold";
  id: string;
}

export interface JournalTierOp {
  op: "tier";
  id: string;
  tier: 1 | 2 | 3;
  summary: string;
  topic: string;
  tokensBefore: number;
  tokensAfter: number;
}

export type JournalOp = JournalFoldOp | JournalUnfoldOp | JournalTierOp;

export class BlockTree {
  private blocks = new Map<string, Block>();
  private order: string[] = [];

  apply(op: JournalOp): void {
    if (op.op === "fold") {
      this.blocks.set(op.block.id, { ...op.block, children: [...op.block.children] });
      this.order.push(op.block.id);
    } else if (op.op === "unfold") {
      const b = this.blocks.get(op.id);
      if (b) b.superseded = true;
      for (const other of this.blocks.values()) {
        if (other.children.includes(op.id)) {
          other.superseded = true;
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
    return this.order.map((id) => this.blocks.get(id)!).filter((b) => !b.superseded);
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

  nextId(): string {
    return `b${this.order.length + 1}`;
  }

  newestLive(): Block | null {
    const live = this.live();
    return live.length > 0 ? live[live.length - 1]! : null;
  }

  blockRange(block: Block): RefRange | null {
    if (block.ranges.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const r of block.ranges) {
      const a = parseRef(r.start);
      const z = parseRef(r.end);
      if (a < min) min = a;
      if (z > max) max = z;
    }
    return {
      start: `m${String(min).padStart(5, "0")}`,
      end: `m${String(max).padStart(5, "0")}`,
    };
  }

  rebuild(ops: JournalOp[]): void {
    this.blocks.clear();
    this.order = [];
    for (const op of ops) this.apply(op);
  }
}