import { describe, expect, it } from "bun:test";
import { cachedFoldSpec, parseReplaySummaryCache, replaySummaryKey, replaySummaryRequest } from "../bench/replay-summary.ts";

describe("replay summary cache", () => {
  it("builds deterministic keys and bounded requests", () => {
    expect(replaySummaryKey(1, ["m1", "m2"], ["a"])).toBe(replaySummaryKey(1, ["m1", "m2"], ["a"]));
    expect(replaySummaryKey(1, ["m2", "m1"], ["a"])).not.toBe(replaySummaryKey(1, ["m1", "m2"], ["a"]));
    const request = replaySummaryRequest(1, "m1..m2", ["m1", "m2"], "x".repeat(130_000));
    expect(request.source.length).toBeLessThanOrEqual(120_030);
    expect(request.source).toContain("[...middle omitted...]");
  });

  it("rejects malformed and conflicting duplicate cache records", () => {
    expect(() => parseReplaySummaryCache("not json\n")).toThrow("invalid summary cache line 1");
    expect(() => parseReplaySummaryCache('{"key":"k"}\n')).toThrow("missing required fields");
    const a = '{"key":"k","tier":1,"range":"m1","topic":"a","summary":"s"}';
    const b = '{"key":"k","tier":1,"range":"m1","topic":"b","summary":"s"}';
    expect(() => parseReplaySummaryCache(`${a}\n${b}\n`)).toThrow("duplicate summary key k");
    expect(parseReplaySummaryCache(`${a}\n${a}\n`).size).toBe(1);
  });

  it("fails visibly on a missing or mismatched cache record", () => {
    const request = replaySummaryRequest(1, "m1..m2", ["m1", "m2"], "source");
    expect(() => cachedFoldSpec(request, new Map())).toThrow(`missing replay summary ${request.key}`);
    const cache = new Map([[request.key, { key: request.key, tier: 2 as const, range: "b1,b2", topic: "x", summary: "y" }]]);
    expect(() => cachedFoldSpec(request, cache)).toThrow("does not match requested tier/range");
  });
});
