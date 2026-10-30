import type { EngineContext } from "./engine-types.ts";
import { messageFacts } from "./kernel/message-facts.ts";

export interface OutboundEstimate {
  total: number;
  bound: number;
  injected: number;
  overhead: number;
}

export type OutboundEstimateContext = Pick<EngineContext, "state" | "host">;

/**
 * The host's projected tokens are anchored on the last provider round. Folds committed since
 * then are still inside that anchor, so they are subtracted before deriving the non-message
 * overhead; otherwise the first request after a fold double-counts the folded history and can
 * trip the context-limit abort right after a successful fold.
 */
export function estimateOutboundTokens(messages: readonly unknown[], context: OutboundEstimateContext, reclaimedSinceRound = 0): OutboundEstimate {
  let rendered = 0;
  for (const message of messages) {
    const facts = messageFacts(message);
    if (facts) rendered += context.state.ledger.countMessage(facts);
    else {
      let text: string;
      try { text = JSON.stringify(message) ?? "null"; } catch { text = String(message); }
      rendered += context.state.ledger.countText(text);
    }
  }
  const overhead = Math.max(0, context.host.projectedTokens() - reclaimedSinceRound - rendered);
  return { total: rendered + overhead, bound: rendered, injected: 0, overhead };
}
