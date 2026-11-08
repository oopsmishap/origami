import type { BoundMessage, KernelMessage } from "./types.ts";
import { parseRef } from "./types.ts";
import { BlockTree } from "./blocks.ts";
import type { CountFn } from "./tokens.ts";
import { TokenLedger } from "./tokens.ts";
import { bindMessages } from "./refs.ts";
import { messageFacts } from "./message-facts.ts";
import { extractOps } from "./journal.ts";
import type { RefRegistry, SessionEntryLike } from "./registry.ts";
import { RefRegistry as Registry } from "./registry.ts";

export type { SessionEntryLike } from "./registry.ts";

export interface SessionStateOptions {
  sessionId: string;
  modelId: string;
  entries: readonly SessionEntryLike[];
  countFn: CountFn | null;
}

/**
 * Journal-derived session state. `refresh` is incremental: appending one entry costs one
 * message hash and one journal op, not a full replay. A shortened or rewritten entry list
 * (host compaction, branch switch) falls back to a full rebuild.
 */
export class SessionState {
  readonly sessionId: string;
  readonly tree: BlockTree;
  readonly ledger: TokenLedger;
  private registry: RefRegistry = new Registry([]);
  private appliedEntries = 0;
  private lastEntryId: string | null = null;
  private cachedBound: BoundMessage[] = [];
  private requestCache = new WeakMap<readonly unknown[], { version: number; facts: KernelMessage[]; aligned: boolean; bound: BoundMessage[] }>();
  private foldedRefsCache: { treeVersion: number; refs: Set<string> } | null = null;
  private _version = 0;
  /** What the last `refresh` did; diagnostics and test seam. */
  refreshStats: { appended: number; rebuilt: boolean } = { appended: 0, rebuilt: false };

  constructor(opts: SessionStateOptions) {
    this.sessionId = opts.sessionId;
    this.tree = new BlockTree();
    this.ledger = new TokenLedger(opts.modelId, opts.countFn);
    this.rebuild(opts.entries);
    this.refreshStats = { appended: opts.entries.length, rebuilt: true };
  }

  /** Monotonic: increments whenever the journal-derived state changes. */
  get version(): number {
    return this._version;
  }

  /** Facts for every message entry, in journal order: the single derived copy of the history. */
  get messages(): readonly KernelMessage[] {
    return this.registry.messages;
  }

  private rebuild(entries: readonly SessionEntryLike[]): void {
    this.tree.rebuild(extractOps(entries));
    this.registry = new Registry(entries);
    this.appliedEntries = entries.length;
    this.lastEntryId = entries.length > 0 ? entries[entries.length - 1]?.id ?? null : null;
    this.cachedBound = [];
    this.requestCache = new WeakMap();
    this._version++;
  }

  refresh(entries: readonly SessionEntryLike[], verify = false): void {
    if (verify) {
      // Rare path (candidate acceptance): the host may have rewritten history in place while
      // keeping entry ids, which the O(1) boundary check cannot see.
      this.rebuild(entries);
      this.refreshStats = { appended: 0, rebuilt: true };
      return;
    }
    const lastId = entries.length > 0 ? entries[entries.length - 1]?.id ?? null : null;
    if (entries.length === this.appliedEntries && lastId === this.lastEntryId) return;

    // Append-only is the norm (the host only ever appends). Anything else — a shorter list,
    // or a prefix whose last applied entry no longer matches — needs a full replay.
    const prefixIntact =
      this.appliedEntries === 0 || (entries[this.appliedEntries - 1]?.id ?? null) === this.lastEntryId;
    if (entries.length <= this.appliedEntries || !prefixIntact) {
      this.rebuild(entries);
      this.refreshStats = { appended: 0, rebuilt: true };
      return;
    }

    const delta = entries.slice(this.appliedEntries);
    this.registry.append(delta);
    this.tree.applyOps(extractOps(delta));
    this.appliedEntries = entries.length;
    this.lastEntryId = lastId;
    this.cachedBound = [];
    this.requestCache = new WeakMap();
    this._version++;
    this.refreshStats = { appended: delta.length, rebuilt: false };
  }

  bind(messages: readonly KernelMessage[] = this.registry.messages): BoundMessage[] {
    this.cachedBound = bindMessages(messages, this.registry);
    return this.cachedBound;
  }

  /**
   * Derive facts for a host request array and bind it against the journal registry.
   *
   * The host reuses one array across the several render passes of a single request, so both
   * the derivation and the bind are cached by array identity and invalidated by journal version.
   */
  bindRequest(messages: readonly unknown[]): { facts: KernelMessage[]; aligned: boolean; bound: BoundMessage[] } {
    const hit = this.requestCache.get(messages);
    if (hit && hit.version === this._version) return hit;
    const facts: KernelMessage[] = [];
    for (const message of messages) {
      const derived = messageFacts(message);
      if (!derived) break;
      facts.push(derived);
    }
    const aligned = facts.length === messages.length;
    const bound = aligned ? bindMessages(facts, this.registry) : this.cachedBound;
    const value = { version: this._version, facts, aligned, bound };
    this.requestCache.set(messages, value);
    return value;
  }

  get bound(): BoundMessage[] {
    return this.cachedBound;
  }

  get nextRef(): string {
    return this.registry.formatNext();
  }

  /** Folded refs, memoized on the block tree version: rebuilt on every fold, not every read. */
  foldedRefs(): Set<string> {
    if (this.foldedRefsCache?.treeVersion === this.tree.version) return this.foldedRefsCache.refs;
    const refs = this.tree.foldedRefs();
    this.foldedRefsCache = { treeVersion: this.tree.version, refs };
    return refs;
  }

  /** Live (unfolded, not hidden) tokens that arrived after the most recent fold event. */
  growthSinceFold(activeTurn: number, hidden: ReadonlySet<string> = NO_REFS): number {
    const anchor = this.tree.latestFoldAnchor();
    const folded = this.foldedRefs();
    let total = 0;
    for (const m of this.cachedBound) {
      if (m.ephemeral || m.turn === activeTurn || folded.has(m.ref) || hidden.has(m.ref)) continue;
      if (parseRef(m.ref) > anchor) total += this.ledger.countMessage(m);
    }
    return total;
  }

  /** Live tokens eligible for folding: everything older than the protected recent tail. */
  compressibleTokens(protectedFromTurn: number, hidden: ReadonlySet<string> = NO_REFS): number {
    const folded = this.foldedRefs();
    let total = 0;
    for (const m of this.cachedBound) {
      if (m.ephemeral || folded.has(m.ref) || hidden.has(m.ref) || m.turn >= protectedFromTurn) continue;
      total += this.ledger.countMessage(m);
    }
    return total;
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

const NO_REFS: ReadonlySet<string> = new Set();
