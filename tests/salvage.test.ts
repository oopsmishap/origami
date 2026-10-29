import { describe, expect, it } from "bun:test";
import { salvageFoldParams } from "../src/tools/salvage.ts";

describe("salvageFoldParams (Billion-Context #2580, #1502)", () => {
  it("passes through valid standard { folds: [...] } payload byte-intact", () => {
    const valid = {
      folds: [
        { range: "m00010..m00020", topic: "Authentication fix", summary: "Fixed token expiry issue." },
      ],
      tier: 1,
    };
    const res = salvageFoldParams(valid);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.folds).toEqual(valid.folds);
      expect(res.params.tier).toBe(1);
    }
  });

  it("salvages shorthand top-level { range, topic, summary }", () => {
    const shorthand = {
      range: "m00012..m00048",
      topic: "Refactor database query",
      summary: "Combined multiple queries into a single batch.",
      tier: 1,
    };
    const res = salvageFoldParams(shorthand);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.folds).toEqual([
        {
          range: "m00012..m00048",
          topic: "Refactor database query",
          summary: "Combined multiple queries into a single batch.",
        },
      ]);
      expect(res.params.tier).toBe(1);
    }
  });

  it("coerces string tier ('1', '2', '3') to number", () => {
    const withStringTier = {
      range: "m00010..m00020",
      summary: "Some summary",
      tier: "2",
    };
    const res = salvageFoldParams(withStringTier);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.tier).toBe(2);
    }
  });

  it("strips accidental outer backticks or quotes from range specs", () => {
    const quoted = {
      range: "`m00010..m00020`",
      summary: "Some summary",
    };
    const res = salvageFoldParams(quoted);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.folds[0]?.range).toBe("m00010..m00020");
    }
  });

  it("infers tier 2 when block ranges are targeted without explicit tier", () => {
    const blockFold = {
      folds: [{ range: "b1,b2", topic: "Distillation", summary: "Merged early blocks." }],
    };
    const res = salvageFoldParams(blockFold);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.tier).toBe(2);
    }
  });

  it("salvages JSON-stringified folds array", () => {
    const stringified = {
      folds: JSON.stringify([
        { range: "m00001..m00005", topic: "Setup", summary: "Project initialization." },
      ]),
    };
    const res = salvageFoldParams(stringified);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.folds).toHaveLength(1);
      expect(res.params.folds[0]?.range).toBe("m00001..m00005");
    }
  });

  it("rejects non-object garbage or missing ranges with clear error", () => {
    expect(salvageFoldParams(null).ok).toBe(false);
    expect(salvageFoldParams("not an object").ok).toBe(false);
    expect(salvageFoldParams({}).ok).toBe(false);
    expect(salvageFoldParams({ folds: [] }).ok).toBe(false);
    expect(salvageFoldParams({ tier: 99 }).ok).toBe(false);
  });

  it("parses stringified keep/retire and rejects malformed ledger fields", () => {
    const res = salvageFoldParams({
      folds: [{ range: "b1,b2", topic: "t", summary: "s", keep: '[{"kind":"decision","text":"use sqlite","ref":"m00004"}]', retire: '["b1.L1"]' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.folds[0]!.keep).toEqual([{ kind: "decision", text: "use sqlite", ref: "m00004" }]);
      expect(res.params.folds[0]!.retire).toEqual(["b1.L1"]);
    }
    expect(salvageFoldParams({ range: "m00001..m00002", summary: "s", keep: [{ kind: "intent", text: "x" }] })).toEqual({
      ok: false,
      error: "keep must be an array of {kind,text,ref?}",
    });
    expect(salvageFoldParams({ range: "b1,b2", summary: "s", retire: "b1.L1" })).toEqual({ ok: false, error: "retire must be an array of ledger ids" });
  });
});
