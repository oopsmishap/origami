import type { BoundMessage, KernelMessage } from "./types.ts";
import { formatRef } from "./types.ts";
import type { RefRegistry } from "./registry.ts";

export const MIN_RESYNC_RUN = 3;

/**
 * Binds live request messages to registry refs. Pure and deterministic: repeated
 * calls on the same message list yield the same refs (occurrence counters are
 * local to the call), so re-sent full histories never churn ref numbers.
 */
export function bindMessages(
  messages: readonly KernelMessage[],
  registry: RefRegistry,
): BoundMessage[] {
  const occurrence = new Map<string, number>();
  const out: BoundMessage[] = [];
  let fresh = registry.nextRef;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const ephemeral = msg.role === "developer" || msg.role === "system";

    if (ephemeral) {
      out.push({ ...msg, index: i, ref: "", ephemeral: true, turn: 0 });
      continue;
    }

    const key = `${msg.role}\u0000${msg.contentHash}`;
    const seen = occurrence.get(key) ?? 0;
    occurrence.set(key, seen + 1);

    const known = registry.refFor(msg, seen);
    const ref = known !== undefined ? formatRef(known) : formatRef(fresh++);
    out.push({ ...msg, index: i, ref, ephemeral: false, turn: 0 });
  }

  assignTurns(out);
  return out;
}

function assignTurns(bound: BoundMessage[]): void {
  let turn = 0;
  for (const m of bound) {
    if (m.ephemeral) {
      m.turn = turn;
      continue;
    }
    if (m.role === "user" || m.role === "custom") {
      turn++;
      m.turn = turn;
    } else if (m.role === "assistant" || m.role === "toolResult") {
      m.turn = turn === 0 ? 1 : turn;
    } else {
      m.turn = turn;
    }
  }
}

export function monotonicCheck(refs: readonly string[]): boolean {
  let prev = -1;
  for (const r of refs) {
    if (!r) continue;
    const n = Number.parseInt(r.slice(1), 10);
    if (n <= prev) return false;
    prev = n;
  }
  return true;
}