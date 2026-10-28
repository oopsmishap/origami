import type { BoundMessage, KernelMessage, RefRange } from "./types.ts";
import { parseRef } from "./types.ts";
import { BlockTree } from "./blocks.ts";
import type { CountFn } from "./tokens.ts";
import { TokenLedger } from "./tokens.ts";
import { bindMessages } from "./refs.ts";
import type { JournalOp } from "../persist/journal.ts";
import { extractOps } from "../persist/journal.ts";
import type { RefRegistry, SessionEntryLike } from "./registry.ts";
import { RefRegistry as Registry } from "./registry.ts";

export type { SessionEntryLike } from "./registry.ts";

export interface SessionStateOptions {
  sessionId: string;
  modelId: string;
  entries: readonly SessionEntryLike[];
  countFn: CountFn | null;
}

export class SessionState {
  readonly sessionId: string;
  readonly tree: BlockTree;
  readonly ledger: TokenLedger;
  private registry: RefRegistry = new Registry([]);
  private entryCount = 0;
  private messageEntryCount = 0;
  private cachedBound: BoundMessage[] = [];

  constructor(opts: SessionStateOptions) {
    this.sessionId = opts.sessionId;
    this.tree = new BlockTree();
    this.ledger = new TokenLedger(opts.modelId, opts.countFn);
    this.ingestEntries(opts.entries);
  }

  private ingestEntries(entries: readonly SessionEntryLike[]): void {
    this.tree.rebuild(extractOps(entries as readonly { type: string; data?: unknown }[]) as JournalOp[]);
    this.registry = new Registry(entries);
    this.entryCount = entries.length;
    this.messageEntryCount = this.registry.messageEntryCount;
    this.cachedBound = [];
  }

  refresh(entries: readonly SessionEntryLike[]): void {
    if (entries.length === this.entryCount && this.registry.messageEntryCount === this.messageEntryCount) return;
    this.ingestEntries(entries);
  }

  bind(messages: readonly KernelMessage[]): BoundMessage[] {
    this.cachedBound = bindMessages(messages, this.registry);
    return this.cachedBound;
  }

  /**
   * Bind an outbound request array against the journal registry WITHOUT
   * disturbing the journal-derived cache. Render must rewrite the array it is
   * actually given (which may carry ephemeral developer reminders the journal
   * never recorded), so its bound indices line up with that array.
   */
  bindOutbound(messages: readonly KernelMessage[]): BoundMessage[] {
    return bindMessages(messages, this.registry);
  }

  get bound(): BoundMessage[] {
    return this.cachedBound;
  }

  get nextRef(): string {
    return this.registry.formatNext();
  }

  foldedRefs(): Set<string> {
    return this.tree.foldedRefs();
  }

  growthSinceFold(activeTurn: number): number {
    const newest = this.tree.newestLive();
    const anchorRef = newest ? parseRef(this.blockAnchor(newest.ranges)) : 0;
    let total = 0;
    for (const m of this.cachedBound) {
      if (m.ephemeral || m.turn === activeTurn) continue;
      if (parseRef(m.ref) > anchorRef) total += this.ledger.countMessage(m);
    }
    return total;
  }

  compressibleTokens(activeTurn: number): number {
    const folded = this.foldedRefs();
    let total = 0;
    for (const m of this.cachedBound) {
      if (m.ephemeral || folded.has(m.ref) || m.turn === activeTurn) continue;
      total += this.ledger.countMessage(m);
    }
    return total;
  }

  private blockAnchor(ranges: readonly RefRange[]): string {
    let min = Number.MAX_SAFE_INTEGER;
    for (const r of ranges) {
      const s = parseRef(r.start);
      if (s < min) min = s;
    }
    return min === Number.MAX_SAFE_INTEGER ? "" : `m${String(min).padStart(5, "0")}`;
  }

  tokensFor(refs: readonly string[]): number {
    const byRef = new Map(this.cachedBound.map((m) => [m.ref, m]));
    let total = 0;
    for (const ref of refs) {
      const m = byRef.get(ref);
      if (m) total += this.ledger.countMessage(m);
    }
    return total;
  }
}