import { CandidateStore } from "./candidates.ts";
import { OrigamiEngine } from "./engine.ts";
import type { HostPort } from "./engine.ts";
import { messageFacts } from "./kernel/message-facts.ts";
import type { KernelMessage } from "./kernel/types.ts";
import { entryMessage } from "./kernel/registry.ts";
import type { SessionEntryLike } from "./kernel/registry.ts";
import type { OrigamiConfig } from "./config.ts";
import type { OrigamiDb } from "./persist/db.ts";
import type { JournalOp } from "./kernel/journal.ts";

export type { SessionEntryLike };

/** Derive bindable kernel messages (journal order) from session entries. */
export function kernelMessagesFromEntries(entries: readonly SessionEntryLike[]): KernelMessage[] {
  const out: KernelMessage[] = [];
  for (const e of entries) {
    const message = entryMessage(e);
    if (message === undefined) continue;
    const facts = messageFacts(message);
    if (facts) out.push(facts);
  }
  return out;
}

export interface HostBinding {
  sessionId(): string;
  appendEvent(op: JournalOp): void;
  saveArtifact(content: string, toolType: string): Promise<string | undefined>;
  windowTokens(): number;
  projectedTokens(): number;
  modelCost?(): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  entries(): readonly SessionEntryLike[];
}

/**
 * Owns the per-session engine + db and refreshes bound state from the journal
 * before each tool/hook operation. One instance per omp session.
 */
export class OrigamiRuntime {
  readonly engine: OrigamiEngine;
  db: OrigamiDb | null = null;
  /** Background fold candidate state (speculativeFolds). */
  readonly candidates = new CandidateStore();
  private host: HostBinding;

  constructor(opts: { host: HostBinding; modelId: string; config?: OrigamiConfig; countFn?: (input: string, encoding?: string) => number }) {
    this.host = opts.host;
    this.engine = new OrigamiEngine({
      host: opts.host,
      entries: opts.host.entries(),
      modelId: opts.modelId,
      config: opts.config,
      countFn: opts.countFn,
    });
  }
  get sessionId(): string {
    return this.host.sessionId();
  }


  attachDb(db: OrigamiDb | null, onPersistenceError?: (error: unknown) => void): void {
    this.db = db;
    this.engine.attachDb(db, (error) => {
      this.db = null;
      onPersistenceError?.(error);
    });
  }

  /** Refresh journal-derived state. The engine re-binds only when the journal changed. */
  sync(verify = false): void {
    this.engine.refresh(this.host.entries(), verify);
  }
}
