import type { BoundMessage, KernelMessage } from "./types.ts";
import { formatRef } from "./types.ts";
import type { RefRegistry } from "./registry.ts";

export const MIN_RESYNC_RUN = 3;

/**
 * A user (or custom) message opens a turn; inside one turn, a new foldable segment
 * begins at an assistant step boundary once this many bytes have accumulated.
 *
 * Without segmentation a single-prompt marathon (a subagent, or hours of autonomous
 * work after the last user message) is one giant in-flight turn: nothing in it can
 * ever be folded, while the doctrine still tells the model to fold. Live telemetry
 * showed 43/43 failed folds in one such session. ~24 KB ≈ 6K tokens keeps segments
 * well above the protected tail but small enough to fold long monologues.
 */
export const TURN_SEGMENT_BYTES = 24_000;

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
  let segmentBytes = 0;
  for (const m of bound) {
    if (m.ephemeral) {
      m.turn = turn;
      continue;
    }
    if (m.role === "user" || m.role === "custom") {
      turn++;
      segmentBytes = 0;
      m.turn = turn;
    } else if (m.role === "assistant" || m.role === "toolResult") {
      if (turn === 0) turn = 1;
      // Segment boundaries sit only before an assistant message (the start of a
      // step), so a tool call and its results always share a segment.
      if (m.role === "assistant" && segmentBytes >= TURN_SEGMENT_BYTES) {
        turn++;
        segmentBytes = 0;
      }
      m.turn = turn;
      segmentBytes += m.bytes;
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