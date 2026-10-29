import { describe, expect, it } from "bun:test";
import { linearBranch, parseJournal, replaySession, type JournalEntry } from "../bench/replay-lib.ts";
import { configFromPreset } from "../src/config.ts";

describe("linearBranch", () => {
  it("follows the leaf's parent chain, skipping abandoned forks", () => {
    const entries: JournalEntry[] = [
      { type: "session" },
      { type: "message", id: "a", parentId: null },
      { type: "message", id: "b", parentId: "a" },
      { type: "message", id: "c", parentId: "b" },
      { type: "message", id: "d", parentId: "b" },
    ];
    expect(linearBranch(entries).map((e) => e.id)).toEqual(["a", "b", "d"]);
    expect(linearBranch([{ type: "x", id: "1" }, { type: "y", id: "2" }]).map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("counts malformed journal lines", () => {
    const { entries, malformedLines } = parseJournal('{"type":"message"}\nnot json\n\n[1]\n');
    expect(entries).toHaveLength(1);
    expect(malformedLines).toBe(2);
  });
});

function syntheticJournal(turns: number): JournalEntry[] {
  const out: JournalEntry[] = [];
  let parent: string | null = null;
  let t = Date.parse("2026-01-01T00:00:00Z");
  const add = (message: unknown) => {
    const id = `e${out.length}`;
    out.push({ type: "message", id, parentId: parent, timestamp: new Date((t += 10_000)).toISOString(), message });
    parent = id;
  };
  for (let turn = 1; turn <= turns; turn++) {
    add({ role: "user", content: `Turn ${turn}: inspect module ${turn} and report. ${"context ".repeat(60)}` });
    add({ role: "assistant", content: [{ type: "toolCall", id: `c${turn}`, name: "bash", arguments: { command: `cat src/mod${turn}/index.ts` } }] });
    const body = `${"output line ".repeat(120)}${turn === 2 ? "\nError: ENOENT src/foo/bar.ts missing\n" : ""}${"tail ".repeat(40)}`;
    add({ role: "toolResult", toolCallId: `c${turn}`, toolName: "bash", isError: turn === 2, content: [{ type: "text", text: body }] });
    add({ role: "assistant", content: `Module ${turn} looks fine. ${"analysis ".repeat(40)}` });
  }
  return out;
}

describe("replaySession", () => {
  const config = { ...configFromPreset("lean"), minFoldFillPct: 0, paybackHorizonTurns: 0 };
  const run = (hints: boolean) =>
    replaySession(syntheticJournal(40), { mode: "simulated", policy: "current", summarySource: "extractive", config, windowTokens: 20_000, hints, probeDistanceRefs: 20, checkpointEvery: 200 });

  it("folds a long session and never loses a far fact", () => {
    const r = run(true);
    expect(r.requests).toBe(80);
    expect(r.folds[1]).toBeGreaterThanOrEqual(1);
    expect(r.probes.total).toBeGreaterThanOrEqual(1);
    expect(r.probes.lost).toBe(0);
    expect(r.probes.viaHint + r.probes.inContext).toBe(r.probes.total);
    expect(r.meanContextTokens).toBeLessThan(r.peakContextTokens);
  });

  it("credits no recall to hints when hints are off", () => {
    expect(run(false).probes.viaHint).toBe(0);
  });

  it("runs legacy and current policies from identical immutable input", () => {
    const entries = syntheticJournal(40);
    const before = JSON.stringify(entries);
    const options = { mode: "simulated" as const, summarySource: "extractive" as const, config, windowTokens: 12_000, hints: true, probeDistanceRefs: 20, checkpointEvery: 200 };
    const legacy = replaySession(entries, { ...options, policy: "legacy-0.2" });
    const current = replaySession(entries, { ...options, policy: "current" });
    expect(JSON.stringify(entries)).toBe(before);
    expect(current.requests).toBe(legacy.requests);
    expect(current.baselineBilledUnits).toBe(legacy.baselineBilledUnits);
    expect(current.peakContextTokens).toBeLessThan(12_000);
  });
});
