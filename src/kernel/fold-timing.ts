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
    if (breakevenTurns === null || breakevenTurns > i.paybackHorizonTurns) return blocked("cost", boundary, breakevenTurns);
  }
  return { allowed: true, blockedBy: null, boundary, fillFloorTokens, breakevenTurns };
}
