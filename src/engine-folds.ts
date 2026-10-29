import type { EngineContext, FoldError, FoldParams, FoldResult, PlannedFold } from "./engine-types.ts";
import type { RefRange } from "./kernel/types.ts";
import { parseRef } from "./kernel/types.ts";

/** Dependencies for fold operations. Callbacks keep façade lifecycle state explicit. */
export interface FoldOperationInput {
  context: Readonly<EngineContext>;
  appendEvent?(event: unknown): void;
  disablePersistence?(error: unknown): void;
  setFoldAttribution?(blockId: string): void;
  resetActiveNudge?(): void;
  setFoldTurn?(turn: number): void;
  updateBackoff?(tier: 1 | 2 | 3): void;
}

export interface FoldOperationDelegate {
  plan(params: FoldParams): { ok: true; planned: PlannedFold[] } | FoldError;
  commit(planned: readonly PlannedFold[]): FoldResult;
}

/** Public operation boundary used by the compatibility façade. */
export function planFoldBatch(_input: FoldOperationInput, params: FoldParams, delegate: FoldOperationDelegate): { ok: true; planned: PlannedFold[] } | FoldError {
  return delegate.plan(params);
}

/** Public operation boundary used by the compatibility façade. */
export function commitFoldBatch(_input: FoldOperationInput, planned: readonly PlannedFold[], delegate: FoldOperationDelegate): FoldResult {
  return delegate.commit(planned);
}

export function archiveDigest(context: Readonly<EngineContext>, ranges: readonly RefRange[], perMessageChars = 160): string {
  const parts: string[] = [];
  for (const message of context.state.bound) {
    if (message.ephemeral) continue;
    const number = parseRef(message.ref);
    if (!ranges.some((range) => number >= parseRef(range.start) && number <= parseRef(range.end))) continue;
    const flat = message.text.replace(/\s+/g, " ").trim();
    const clipped = flat.length > perMessageChars ? `${flat.slice(0, perMessageChars - 1)}…` : flat;
    parts.push(`[#${message.ref}] ${message.role}: ${clipped}`);
  }
  return parts.join("\n");
}
