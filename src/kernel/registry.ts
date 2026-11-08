import type { KernelMessage } from "./types.ts";
import { formatRef } from "./types.ts";
import { messageFacts } from "./message-facts.ts";

export interface SessionEntryLike {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
  content?: unknown;
}

export function entryMessage(entry: SessionEntryLike): unknown {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") return { role: "custom", content: entry.content };
  return undefined;
}

function contentKey(facts: KernelMessage): string {
  return `${facts.role}\u0000${facts.contentHash}`;
}

/**
 * Ref numbers are the ordinal of the message entry among ALL message entries in
 * the journal (never per-branch): monotonic, never reused, and identical shared
 * history carries identical refs across /branch //fork //tree.
 *
 * `messages` is the single derived copy of the history: appended entries are
 * registered incrementally, so a new journal entry costs O(1) hashing.
 */
export class RefRegistry {
  readonly byEntryId = new Map<string, number>();
  readonly byToolCallId = new Map<string, number>();
  readonly byContent = new Map<string, number[]>();
  readonly messages: KernelMessage[] = [];
  messageEntryCount = 0;

  constructor(entries: readonly SessionEntryLike[]) {
    this.append(entries);
  }

  /** Register newly appended journal entries; refs continue from the current ordinal. */
  append(entries: readonly SessionEntryLike[]): void {
    let ordinal = this.messageEntryCount;
    for (const entry of entries) {
      const message = entryMessage(entry);
      if (message === undefined) continue;
      const facts = messageFacts(message);
      if (!facts) continue;
      ordinal++;
      const ref = ordinal;
      const entryId = entry.id ?? `#${ordinal}`;
      this.byEntryId.set(entryId, ref);
      if (facts.toolCallId) this.byToolCallId.set(facts.toolCallId, ref);
      const key = contentKey(facts);
      const queue = this.byContent.get(key);
      if (queue) queue.push(ref);
      else this.byContent.set(key, [ref]);
      this.messages.push(facts);
    }
    this.messageEntryCount = ordinal;
  }

  get nextRef(): number {
    return this.messageEntryCount + 1;
  }

  refFor(facts: KernelMessage, occurrence: number): number | undefined {
    if (facts.toolCallId) {
      const ref = this.byToolCallId.get(facts.toolCallId);
      if (ref !== undefined) return ref;
    }
    const queue = this.byContent.get(contentKey(facts));
    return queue ? queue[occurrence] : undefined;
  }

  formatNext(): string {
    return formatRef(this.nextRef);
  }
}
