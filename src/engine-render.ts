import type { EngineContext } from "./engine-types.ts";
import type { KernelMessage } from "./kernel/types.ts";
import { messageFacts } from "./kernel/message-facts.ts";
import { planElision, selectElideCandidates, elideLabel, type ElideCandidate } from "./kernel/guard.ts";
import { renderableBlocks } from "./kernel/invariants.ts";
import { applyRender, planRender, withRefTag } from "./kernel/render.ts";

export interface RenderOutboundInput<T> {
  context: Readonly<EngineContext>;
  messages: readonly T[];
  makeFoldMessage: (text: string, blockId: string, refTag?: string) => T;
  seenHashes: Map<string, string>;
  pendingHostRewrite: boolean;
  projectedTokensOverride?: number;
}

export function renderOutbound<T>(input: RenderOutboundInput<T>): { messages: T[]; hostRewrite: boolean } {
  const { context } = input;
  const { aligned, bound } = context.state.bindRequest(input.messages);
  let hostRewrite = input.pendingHostRewrite;
  if (aligned) {
    for (const m of bound) {
      if (m.ephemeral) continue;
      const seen = input.seenHashes.get(m.ref);
      if (seen !== undefined && seen !== m.contentHash) hostRewrite = true;
      input.seenHashes.set(m.ref, m.contentHash);
    }
  }
  const headIndex = bound.findIndex((m) => !m.ephemeral);
  const pinnedHeadIndex = headIndex < 0 ? 0 : headIndex;
  const initialUserIndex = bound.findIndex((m) => !m.ephemeral && m.role === "user");
  const window = context.host.windowTokens();
  // The host anchor is still anchored on the last provider round, so it contains history that
  // was folded since. Gate on the corrected fill, or the first request after a fold elides
  // live work while real occupancy is far below the threshold.
  const projected = input.projectedTokensOverride ?? Math.max(0, context.host.projectedTokens() - context.reclaimedSinceRound);
  let source: readonly T[] = input.messages;
  const elided = new Set<number>();
  if (window > 0 && projected >= window * context.config.elideFillPct && aligned) {
    const candidates: ElideCandidate[] = selectElideCandidates(bound.map((m) => ({
      ref: m.ref, index: m.index, role: m.role, tokens: context.state.ledger.countMessage(m), ephemeral: m.ephemeral, turn: m.turn,
    })), {
      foldedRefs: context.state.foldedRefs(),
      bookkeepingRefs: context.bookkeepingRefs,
      protectedFromTurn: context.protectedFromTurn,
      activeTurn: context.activeTurn,
    });
    const plan = planElision({ projectedTokens: projected, windowTokens: window, candidates, thresholds: { elideFillPct: context.config.elideFillPct, targetFillPct: 0.7 } });
    if (plan.elided.length > 0) {
      const elideAt = new Map(plan.elided.map((e) => [e.index, e]));
      for (const i of elideAt.keys()) elided.add(i);
      source = input.messages.map((m, i) => {
        const hit = elideAt.get(i);
        if (!hit) return m;
        const raw = m as { content?: unknown };
        const label = elideLabel(hit.ref, hit.tokens);
        const content = typeof raw.content === "string" ? label : [{ type: "text", text: label }];
        return { ...(m as object), content } as T;
      });
    }
  }
  const ops = planRender({ bound, blocks: renderableBlocks(context.state.tree.live()), pinnedHeadIndex });
  if (aligned && context.config.refTags) {
    const removed = new Set(ops.filter((o) => o.kind === "remove").map((o) => o.index));
    source = source.map((m, i) => {
      const b = bound[i];
      if (!b || b.ephemeral || removed.has(i) || elided.has(i)) return m;
      if ((b.role !== "user" && b.role !== "toolResult") || i === initialUserIndex) return m;
      return withRefTag(m, b.ref) as T;
    });
  }
  return { messages: applyRender(source, ops, input.makeFoldMessage) as T[], hostRewrite };
}
