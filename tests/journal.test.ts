import { describe, expect, it } from "bun:test";
import { JOURNAL_ENTRY_TYPE, extractOps, makeFoldOp, makeUnfoldOp, parseJournalOp } from "../src/persist/journal.ts";
import { BlockTree } from "../src/kernel/blocks.ts";
import type { Block } from "../src/kernel/types.ts";

function block(id: string, ranges: Block["ranges"], tier: 1 | 2 | 3 = 1): Block {
  return { id, tier, ranges, topic: `topic-${id}`, summary: `summary-${id}`, children: [], status: "active", consumedBy: null, anchorRef: null, tokensBefore: 100, tokensAfter: 10, createdAt: 5 };
}

function entry(data: unknown): { type: string; customType: string; data: unknown } {
  return { type: "custom", customType: JOURNAL_ENTRY_TYPE, data };
}

describe("journal ops", () => {
  it("round-trips a fold op", () => {
    const op = makeFoldOp(block("b1", [{ start: "m00001", end: "m00003" }]));
    const parsed = parseJournalOp(JSON.parse(JSON.stringify(op)));
    expect(parsed).toEqual(op);
  });

  it("round-trips an unfold op", () => {
    const op = makeUnfoldOp("b1");
    expect(parseJournalOp({ ...op })).toEqual(op);
  });

  it("rejects malformed ops", () => {
    expect(parseJournalOp(null)).toBeNull();
    expect(parseJournalOp({ v: 2, op: "fold" })).toBeNull();
    expect(parseJournalOp({ v: 1, op: "fold" })).toBeNull();
    expect(parseJournalOp({ v: 1, op: "unfold" })).toBeNull();
    expect(parseJournalOp({ v: 1, op: "nope" })).toBeNull();
  });

  it("extracts only origami:event custom entries", () => {
    const entries = [
      entry(makeFoldOp(block("b1", [{ start: "m00001", end: "m00002" }]))),
      { type: "message", data: {} },
      { type: "custom", customType: "other", data: makeUnfoldOp("b1") },
      entry(makeUnfoldOp("b1")),
    ];
    const ops = extractOps(entries);
    expect(ops.map((o) => o.op)).toEqual(["fold", "unfold"]);
  });
});

describe("BlockTree rebuild", () => {
  it("rebuilds live state from a synthetic journal sequence", () => {
    const ops = [
      makeFoldOp(block("b1", [{ start: "m00001", end: "m00003" }])),
      makeFoldOp(block("b2", [{ start: "m00004", end: "m00006" }])),
    ];
    const live = new BlockTree();
    live.rebuild(ops);
    expect(live.live().map((b) => b.id)).toEqual(["b1", "b2"]);
    expect([...live.foldedRefs()]).toEqual(["m00001", "m00002", "m00003", "m00004", "m00005", "m00006"]);

    const rebuilt = new BlockTree();
    rebuilt.rebuild(JSON.parse(JSON.stringify(ops)));
    expect(rebuilt.live().map((b) => b.id)).toEqual(live.live().map((b) => b.id));
    expect([...rebuilt.foldedRefs()]).toEqual([...live.foldedRefs()]);
  });

  it("unfold reactivates refs and marks the block unfolded", () => {
    const tree = new BlockTree();
    tree.rebuild([makeFoldOp(block("b1", [{ start: "m00001", end: "m00003" }])), makeUnfoldOp("b1")]);
    expect(tree.live().length).toBe(0);
    expect(tree.foldedRefs().size).toBe(0);
    expect(tree.get("b1")!.status).toBe("unfolded");
  });

  it("a parent fold consumes its children and unfolding it restores them", () => {
    const parent = block("b3", [{ start: "m00001", end: "m00004" }], 2);
    parent.children = ["b1", "b2"];
    const ops = [
      makeFoldOp(block("b1", [{ start: "m00001", end: "m00002" }])),
      makeFoldOp(block("b2", [{ start: "m00003", end: "m00004" }])),
      makeFoldOp(parent),
    ];
    const tree = new BlockTree();
    tree.rebuild(ops);
    expect(tree.live().map((b) => b.id)).toEqual(["b3"]);
    expect(tree.get("b1")!.consumedBy).toBe("b3");

    // A consumed child cannot be unfolded out from under its parent.
    tree.apply(makeUnfoldOp("b1"));
    expect(tree.get("b1")!.status).toBe("consumed");

    tree.apply(makeUnfoldOp("b3"));
    expect(tree.live().map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(tree.get("b1")!.consumedBy).toBeNull();
    expect(tree.get("b3")!.status).toBe("unfolded");
  });
});