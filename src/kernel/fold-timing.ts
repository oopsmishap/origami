/**
 * When an advisory fold is worth doing. Three gates, evaluated in order:
 *
 * 1. Fill floor: below min(pct × window, cap) the context is cheap to carry; folding
 *    only spends cache and summary tokens.
 * 2. Boundary: fold at natural seams — a fresh user turn, an idle (cold) cache whose
 *    prefix is already lost, or after twice the growth step of unfolded work.
 * 3. Cost: with cache telemetry, the fold must break even within the payback horizon.
 *
 * Emergency folds bypass all of this; callers only apply the result to advisory nudges.
 */
import { foldBreakeven, type PriceProfile } from "./cache-report.ts";

export type FoldGateBlock = "fill-floor" | "mid-task" | "cost";
export type FoldBoundary = "user" | "turn-end" | "cold-cache" | "growth";

export interface FoldTimingInput {
  projectedTokens: number;
  windowTokens: number;
  minFoldFillPct: number;
  minFoldFillCapTokens: number;
  boundary: "user" | "turn-end" | null;
  cacheCold: boolean;
  growthSinceFoldTokens: number;
  growthStep: number;
  candidateTokens: number;
  /** Upper-bound suffix tokens rewritten after the earliest candidate, excluding source tokens and summary. */
  estimatedRewriteTokens: number;
  summaryRatio: number;
  telemetry: boolean;
  price: PriceProfile;
  paybackHorizonTurns: number;
}

export interface FoldTiming {
  allowed: boolean;
  blockedBy: FoldGateBlock | null;
  boundary: FoldBoundary | null;
  fillFloorTokens: number;
  breakevenTurns: number | null;
}

export function assessFoldTiming(i: FoldTimingInput): FoldTiming {
  let fillFloorTokens = 0;
  if (i.windowTokens > 0) {
    const pctFloor = Math.round(i.minFoldFillPct * i.windowTokens);
    fillFloorTokens = i.minFoldFillCapTokens > 0 ? Math.min(pctFloor, i.minFoldFillCapTokens) : pctFloor;
  }
  const blocked = (blockedBy: FoldGateBlock, boundary: FoldBoundary | null, breakevenTurns: number | null = null): FoldTiming => ({
    allowed: false,
    blockedBy,
    boundary,
    fillFloorTokens,
    breakevenTurns,
  });
  if (i.projectedTokens < fillFloorTokens) return blocked("fill-floor", null);

  const boundary: FoldBoundary | null = i.boundary
    ? i.boundary
    : i.cacheCold
      ? "cold-cache"
      : i.growthSinceFoldTokens >= 2 * i.growthStep
        ? "growth"
        : null;
  if (boundary === null) return blocked("mid-task", null);

  let breakevenTurns: number | null = null;
  if (i.telemetry && i.paybackHorizonTurns > 0) {
    const S = i.candidateTokens;
    const sigma = Math.round(S * i.summaryRatio);
    // Candidate source tokens are S; sigma replaces them and is added exactly once here.
    const T = i.cacheCold ? 0 : i.estimatedRewriteTokens + sigma;
    breakevenTurns = foldBreakeven(S, sigma, T, i.price).breakevenTurns;
    // A summary that is not smaller than its source can never pay back at any horizon.
    if (sigma >= S) return blocked("cost", boundary, null);
    // Scale payback horizon adaptively when accumulated growth debt is high,
    // preventing the absorbing cost trap where older tasks can never break even.
    const growthOverage = Math.max(0, i.growthSinceFoldTokens - 2 * i.growthStep);
    const growthFactor = 1 + Math.min(3, growthOverage / Math.max(1, i.growthStep));
    const effectiveHorizon = Math.round(i.paybackHorizonTurns * growthFactor);

    // If accumulated growth is massive (>= 4x growthStep), growth debt overrides the suffix
    // rewrite cost to prevent unbounded context bloating.
    const growthOverride = i.growthSinceFoldTokens >= 4 * i.growthStep;
    if (breakevenTurns !== null && breakevenTurns > effectiveHorizon && !growthOverride) {
      return blocked("cost", boundary, breakevenTurns);
    }
    // breakevenTurns === null with sigma < S means the cache-read price is 0: the cost model has
    // no per-turn saving to rank, so the fill floor and boundary carry the gate. Blocking here
    // would suppress every advisory nudge forever even as the window fills.
  }
  return { allowed: true, blockedBy: null, boundary, fillFloorTokens, breakevenTurns };
}
