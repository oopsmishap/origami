import { describe, expect, it } from "bun:test";
import { fillReplaySummaries } from "../bench/replay-summaries.ts";
import { replaySummaryRequest, type ReplaySummaryRecord } from "../bench/replay-summary.ts";

describe("replay summary filler", () => {
  it("resumes existing output and persists each accepted record", () => {
    const first = replaySummaryRequest(1, "m1..m2", ["m1", "m2"], "one");
    const second = replaySummaryRequest(1, "m3..m4", ["m3", "m4"], "two");
    const existing: ReplaySummaryRecord = { key: first.key, tier: 1, range: first.range, topic: "old", summary: "old summary" };
    const calls: string[] = [];
    const snapshots: ReplaySummaryRecord[][] = [];
    const records = fillReplaySummaries([first, second], new Map([[first.key, existing]]), {
      run(prompt) { calls.push(prompt); return JSON.stringify({ topic: "new", summary: "new summary", keep: [{ kind: "constraint", text: "retain" }] }); },
    }, "model", "/tmp/agent", (next) => snapshots.push([...next]));
    expect(calls).toHaveLength(1);
    expect(records).toHaveLength(2);
    expect(snapshots).toHaveLength(1);
    expect(records[1]!.summary).toBe("new summary");
  });

  it("does not persist invalid runner output", () => {
    const request = replaySummaryRequest(1, "m1..m2", ["m1", "m2"], "one");
    let persisted = false;
    expect(() => fillReplaySummaries([request], new Map(), { run: () => "not json" }, "model", "/tmp/agent", () => { persisted = true; })).toThrow(request.key);
    expect(persisted).toBe(false);
  });
});
