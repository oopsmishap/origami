import { describe, expect, it } from "bun:test";
import { applyRender, planRender, renderBlockText, TIER_HEADERS, parseRefTag, expandRefRange } from "../src/kernel/render.ts";
import type { Block, BoundMessage } from "../src/kernel/types.ts";

function msg(ref: string, turn: number, role: BoundMessage["role"] = "user", extra: Partial<BoundMessage> = {}): BoundMessage {
  return {
    ref,
    turn,
    role,
    index: 0,
    contentHash: `h${ref}`,
    text: `text-${ref}`,
    bytes: ref.length,
    signedThinking: false,
    ephemeral: false,
    ...extra,
  };
}

function makeBound(): BoundMessage[] {
  return [
    msg("m00001", 1, "user"),
    msg("m00002", 1, "assistant"),
    msg("m00003", 1, "toolResult"),
    msg("m00004", 2, "user"),
    msg("m00005", 2, "assistant"),
    msg("m00006", 2, "toolResult"),
  ].map((m, i) => ({ ...m, index: i }));
}

function block(id: string, ranges: Block["ranges"], tier: 1 | 2 | 3 = 1): Block {
  return { id, tier, ranges, topic: "topic", summary: "summary", children: [], status: "active", consumedBy: null, anchorRef: null, tokensBefore: 0, tokensAfter: 0, createdAt: 0 };
}

const makeFold = (text: string, blockId: string) => ({ role: "custom", customType: "origami:fold", text, blockId });

describe("renderBlockText", () => {
  it("emits byte-exact tier headers", () => {
    expect(renderBlockText(block("b1", [{ start: "m00004", end: "m00009" }], 1))).toBe("[Compressed conversation section] b1 (m00004..m00009) — topic\nsummary");
    expect(renderBlockText(block("b2", [{ start: "m00004", end: "m00004" }, { start: "m00007", end: "m00008" }], 2))).toBe("[Distilled conversation summary] b2 (m00004,m00007..m00008) — topic\nsummary");
    expect(renderBlockText(block("b3", [], 3))).toBe("[Ultra-condensed conversation summary] b3 — topic\nsummary");
    expect(TIER_HEADERS[1]).toBe("[Compressed conversation section]");
    expect(TIER_HEADERS[2]).toBe("[Distilled conversation summary]");
    expect(TIER_HEADERS[3]).toBe("[Ultra-condensed conversation summary]");
  });
});

describe("planRender + applyRender", () => {
  it("replaces the covered span at the earliest covered index", () => {
    const bound = makeBound();
    const ops = planRender({ bound, blocks: [block("b1", [{ start: "m00004", end: "m00006" }])], pinnedHeadIndex: 0 });
    const out = applyRender(bound, ops, makeFold);
    expect(out.map((m: { ref?: string; blockId?: string }) => m.ref ?? m.blockId)).toEqual(["m00001", "m00002", "m00003", "b1"]);
  });

  it("never places the fold message before the pinned head", () => {
    const bound = makeBound();
    const ops = planRender({ bound, blocks: [block("b1", [{ start: "m00001", end: "m00002" }])], pinnedHeadIndex: 1 });
    const out = applyRender(bound, ops, makeFold);
    expect(out.map((m: { ref?: string; blockId?: string }) => m.ref ?? m.blockId)).toEqual(["m00001", "b1", "m00003", "m00004", "m00005", "m00006"]);
  });

  it("preserves surviving assistant messages byte-identical", () => {
    const bound = makeBound();
    bound[4] = msg("m00005", 2, "assistant", { signedThinking: true, text: "signed-bytes" });
    const ops = planRender({ bound, blocks: [block("b1", [{ start: "m00004", end: "m00004" }])], pinnedHeadIndex: 0 });
    const out = applyRender(bound, ops, makeFold);
    const survivor = out.find((m: { ref?: string; text?: string }) => m.ref === "m00005") as BoundMessage;
    expect(survivor).toBeDefined();
    expect(survivor.text).toBe("signed-bytes");
    expect(survivor.signedThinking).toBe(true);
  });

  it("carries ref tags only in render output", () => {
    const bound = makeBound();
    const ops = planRender({ bound, blocks: [block("b1", [{ start: "m00002", end: "m00003" }])], pinnedHeadIndex: 0 });
    const insert = ops.find((o) => o.kind === "insert")!;
    expect(insert.refTag).toBe("[#m00002]");
    const out = applyRender(bound, ops, makeFold);
    for (const m of out) {
      const rec = m as { ref?: string; text?: string };
      if (rec.ref) expect(rec.text ?? "").not.toContain("[#m");
    }
    const fold = out.find((m) => (m as { blockId?: string }).blockId === "b1") as { text: string };
    expect(fold.text).not.toContain("[#m");
  });

  it("collapses disjoint block ranges into one anchor with live gaps preserved", () => {
    const bound = makeBound();
    const ops = planRender({
      bound,
      blocks: [block("b1", [{ start: "m00002", end: "m00003" }, { start: "m00006", end: "m00006" }])],
      pinnedHeadIndex: 0,
    });
    const out = applyRender(bound, ops, makeFold);
    expect(out.map((m: { ref?: string; blockId?: string }) => m.ref ?? m.blockId)).toEqual(["m00001", "b1", "m00004", "m00005"]);
  });
});

describe("ref tags", () => {
  it("round-trips bracket tags", () => {
    expect(parseRefTag("[#m00012]")).toBe("m00012");
    expect(parseRefTag("[#m12]")).toBeNull();
  });

  it("expands ref ranges", () => {
    expect(expandRefRange("m00001", "m00003")).toEqual(["m00001", "m00002", "m00003"]);
  });
});