import { describe, expect, it } from "bun:test";
import { promotionCandidates } from "../src/kernel/nudge.ts";

const block = (id: string, start: number, end: number, tokensAfter = 100, tier: 1 | 2 | 3 = 1) => ({
  id,
  tier,
  tokensAfter,
  ranges: [{ start: `m${String(start).padStart(5, "0")}`, end: `m${String(end).padStart(5, "0")}` }],
});

describe("due-ordered promotion", () => {
  it("merges the oldest blocks until half the tier mass, keeping recent detail", () => {
    const live = [block("b1", 2, 11), block("b2", 12, 21), block("b3", 22, 31), block("b4", 32, 41)];
    const ages = new Map(live.map((b) => [b.id, 3]));
    const [p] = promotionCandidates(live, ages, 1, 50);
    expect(p).toEqual({ fromTier: 1, blockIds: ["b1", "b2"], tokens: 200, totalTokens: 400 });
  });

  it("measures age in a block's own size: a small block that ended a while ago is due before a large one", () => {
    // b1 covers 100 refs and ended 9 refs ago (due 0.09); b2 covers 2 refs and ended 7 ago (due 3.5).
    const live = [block("b1", 2, 101, 100), block("b2", 102, 103, 100), block("b3", 104, 105, 100), block("b4", 106, 107, 100)];
    const ages = new Map(live.map((b) => [b.id, 3]));
    const [p] = promotionCandidates(live, ages, 1, 110);
    expect(p!.blockIds).toEqual(["b2", "b3"]);
  });

  it("never selects young blocks but counts them toward the tier mass", () => {
    const live = [block("b1", 2, 11), block("b2", 12, 21), block("b3", 22, 31)];
    const ages = new Map([["b1", 2], ["b2", 2], ["b3", 0]]);
    const [p] = promotionCandidates(live, ages, 1, 40);
    expect(p).toEqual({ fromTier: 1, blockIds: ["b1", "b2"], tokens: 200, totalTokens: 300 });
  });
});
