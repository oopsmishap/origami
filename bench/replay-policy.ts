/** Replay-only historical comparison. `legacy-0.2` copies v0.2.3 (`3b038b3`) nudge ordering and gates. */
import type { OrigamiConfig } from "../src/config.ts";
import type { NudgeDecision, NudgeRange } from "../src/kernel/nudge.ts";

export type ReplayPolicy = "legacy-0.2" | "current";

export interface ReplayPolicyEngineView {
  config: OrigamiConfig;
  windowTokens: number;
  state: { tree: { live(): { id: string; tier: 1 | 2 | 3; tokensAfter: number }[]; foldAges(): Map<string, number> } };
  recommendedRanges(maxRanges?: number): NudgeRange[];
  decideNudge(): NudgeDecision;
  growthSinceFold(): number;
  status(): { compressibleTokens: number; projectedTokens: number };
}

export interface ReplayPolicyState {
  lastEfficiencyAtGrowth: number | null;
  lastPromotionAtMass: { 1: number | null; 2: number | null };
}

export function createReplayPolicyState(): ReplayPolicyState {
  return { lastEfficiencyAtGrowth: null, lastPromotionAtMass: { 1: null, 2: null } };
}

export function decideReplayPolicy(policy: ReplayPolicy, engine: ReplayPolicyEngineView, state: ReplayPolicyState): NudgeDecision {
  if (policy === "current") return engine.decideNudge();
  const ranges = engine.recommendedRanges();
  const total = ranges.reduce((sum, range) => sum + range.tokens, 0);
  const status = engine.status();
  const fill = engine.windowTokens > 0 ? status.projectedTokens / engine.windowTokens : 0;
  if (fill >= engine.config.emergencyFillPct && ranges.length > 0) return { kind: "emergency", text: "legacy emergency" };
  const growth = engine.growthSinceFold();
  const growthFloor = state.lastEfficiencyAtGrowth === null ? engine.config.growthStep : state.lastEfficiencyAtGrowth + Math.ceil(engine.config.growthStep / 2);
  const minBenefit = Math.max(engine.config.minFoldBenefitTokens, Math.round(engine.config.minFoldBenefitWindowPct * engine.windowTokens));
  if (ranges.length > 0 && total >= minBenefit && status.compressibleTokens >= engine.config.compressibleFloor && growth >= growthFloor) {
    state.lastEfficiencyAtGrowth = growth;
    return { kind: "efficiency", text: "legacy efficiency" };
  }
  for (const fromTier of [1, 2] as const) {
    const blocks = engine.state.tree.live().filter((block) => block.tier === fromTier);
    const tokens = blocks.reduce((sum, block) => sum + block.tokensAfter, 0);
    const mass = fromTier === 1 ? engine.config.tier2MassTokens : engine.config.tier3MassTokens;
    const last = state.lastPromotionAtMass[fromTier];
    const floor = last === null ? mass : last + Math.ceil(mass / 2);
    if (blocks.length < 2 || tokens < floor) continue;
    state.lastPromotionAtMass[fromTier] = tokens;
    return { kind: "promotion", text: "legacy promotion", promotion: { fromTier, tokens } };
  }
  return { kind: null, text: null };
}
