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
  const facts: KernelMessage[] = [];
  for (const m of input.messages) {
    const f = messageFacts(m);
    if (!f) break;
    facts.push(f);
  }
  const aligned = facts.length === input.messages.length;
  const bound = aligned ? context.state.bindOutbound(facts) : context.state.bound;
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
  const projected = input.projectedTokensOverride ?? context.host.projectedTokens();
  let source: readonly T[] = input.messages;
  const elided = new Set<number>();
  if (window > 0 && projected >= window * context.config.elideFillPct && aligned) {
    const candidates: ElideCandidate[] = selectElideCandidates(bound.map((m) => ({
      ref: m.ref, index: m.index, role: m.role, tokens: context.state.ledger.countMessage(m), ephemeral: m.ephemeral, turn: m.turn,
    })));
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
