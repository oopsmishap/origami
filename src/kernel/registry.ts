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

export interface RegistryEntry {
  entryId: string;
  ref: number;
  facts: KernelMessage;
}

function contentKey(facts: KernelMessage): string {
  return `${facts.role}\u0000${facts.contentHash}`;
}

/**
 * Ref numbers are the ordinal of the message entry among ALL message entries in
 * the journal (never per-branch): monotonic, never reused, and identical shared
 * history carries identical refs across /branch //fork //tree.
 */
export class RefRegistry {
  readonly byEntryId = new Map<string, number>();
  readonly byToolCallId = new Map<string, number>();
  readonly byContent = new Map<string, number[]>();
  readonly entries: RegistryEntry[] = [];
  readonly messageEntryCount: number;

  constructor(entries: readonly SessionEntryLike[]) {
    let ordinal = 0;
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
      this.entries.push({ entryId, ref, facts });
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
