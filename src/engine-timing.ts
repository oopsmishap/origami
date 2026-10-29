import type { EngineContext } from "./engine-types.ts";
import { parseRef } from "./kernel/types.ts";
import { recommendRanges, type NudgeRange } from "./kernel/nudge.ts";
import { assessFoldTiming, type FoldTiming } from "./kernel/fold-timing.ts";
import type { PriceProfile } from "./kernel/cache-report.ts";

const DEFAULT_SUMMARY_RATIO = 0.05;

export function recommendedRanges(context: Readonly<EngineContext>, maxRanges = 8): NudgeRange[] {
  return recommendRanges({
    bound: context.state.bound.map((message) => ({
      ref: message.ref,
      role: message.role,
      ephemeral: message.ephemeral,
      turn: message.turn,
      tokens: context.bookkeepingRefs.has(message.ref) ? 0 : context.state.ledger.countMessage(message),
      tool: message.role === "toolResult",
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      text: message.text,
      isError: message.isError,
    })),
    foldedRefs: context.state.foldedRefs(),
    protectedFromTurn: context.protectedFromTurn,
    pinnedHeadRef: context.pinnedHeadRef,
    maxRanges,
  });
}

export function estimateRewriteSuffix(context: Readonly<EngineContext>, ranges: readonly NudgeRange[]): number {
  const refNo = (ref: string): number | null => (/^m\d{5,}$/.test(ref) ? parseRef(ref) : null);
  const starts = ranges.map((range) => refNo(range.start)).filter((value): value is number => value !== null);
  if (starts.length === 0) return 0;
  const from = Math.min(...starts);
  const folded = context.state.foldedRefs();
  const spans = ranges.map((range) => [refNo(range.start) ?? 0, refNo(range.end) ?? -1] as const);
  let tokens = 0;
  for (const message of context.state.bound) {
    if (message.ephemeral || folded.has(message.ref)) continue;
    const number = refNo(message.ref);
    if (number === null || number < from || spans.some(([start, end]) => number >= start && number <= end)) continue;
    tokens += context.state.ledger.countMessage(message);
  }
  for (const block of context.state.tree.live()) {
    const first = block.ranges[0] ? refNo(block.ranges[0].start) : null;
    if (first !== null && first >= from) tokens += block.tokensAfter;
  }
  return tokens;
}

export interface FoldTimingInput {
  context: Readonly<EngineContext>;
  ranges: readonly NudgeRange[];
  lastRoundAt: number | null;
  turnEndRef: string | null;
  atUserBoundary: boolean;
  newestRef: string | null;
  price: PriceProfile;
}

export function foldTiming(input: FoldTimingInput): FoldTiming {
  const { context, ranges } = input;
  const ratios = context.state.tree.all().filter((block) => block.tier === 1 && block.tokensBefore > 0).map((block) => block.tokensAfter / block.tokensBefore).sort((a, b) => a - b);
  const summaryRatio = ratios.length < 3 ? DEFAULT_SUMMARY_RATIO : ratios.length % 2 === 1 ? ratios[(ratios.length - 1) / 2]! : (ratios[ratios.length / 2 - 1]! + ratios[ratios.length / 2]!) / 2;
  const config = context.config;
  return assessFoldTiming({
    projectedTokens: context.host.projectedTokens(), windowTokens: context.host.windowTokens(), minFoldFillPct: config.minFoldFillPct,
    minFoldFillCapTokens: config.minFoldFillCapTokens,
    boundary: input.turnEndRef !== null && input.turnEndRef === input.newestRef ? "turn-end" : input.atUserBoundary ? "user" : null,
    cacheCold: input.lastRoundAt !== null && config.cacheTtlMs > 0 && context.now() - input.lastRoundAt >= config.cacheTtlMs,
    growthSinceFoldTokens: context.state.growthSinceFold(context.activeTurn, context.bookkeepingRefs), growthStep: config.growthStep,
    candidateTokens: ranges.reduce((sum, range) => sum + range.tokens, 0), estimatedRewriteTokens: estimateRewriteSuffix(context, ranges), summaryRatio,
    telemetry: input.lastRoundAt !== null, price: input.price, paybackHorizonTurns: config.paybackHorizonTurns,
  });
}
