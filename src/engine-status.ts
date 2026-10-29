import type { EngineContext } from "./engine-types.ts";
import { messageFacts } from "./kernel/message-facts.ts";

export interface OutboundEstimate {
  total: number;
  bound: number;
  injected: number;
  overhead: number;
}

export type OutboundEstimateContext = Pick<EngineContext, "state" | "host">;

export function estimateOutboundTokens(messages: readonly unknown[], context: OutboundEstimateContext): OutboundEstimate {
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
  const overhead = Math.max(0, context.host.projectedTokens() - rendered);
  return { total: rendered + overhead, bound: rendered, injected: 0, overhead };
}
