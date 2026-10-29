import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { renderBlockText } from "../src/kernel/render.ts";
import { makeFoldOp, parseJournalOp, JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

function setup() {
  const entries: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
  for (let k = 1; k <= 6; k++) {
    entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `turn ${k}: work on part ${k}` } });
    entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `done part ${k}: ${"long implementation detail ".repeat(30)}` } });
  }
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "ledger",
      appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
      saveArtifact: async () => "/tmp/x",
      windowTokens: () => 100_000,
      projectedTokens: () => 10_000,
    },
    entries,
    modelId: "test",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    countFn: (t) => t.length,
  });
  const sync = () => {
    engine.refresh(entries);
    engine.ingest(entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null));
  };
  sync();
  return { engine, sync };
}

function foldTwo(engine: OrigamiEngine) {
  const first = engine.executeFold({
    folds: [
      { range: "m00003..m00004", topic: "Part 2", summary: "built part 2", keep: [{ kind: "constraint", text: "must support Node 22", ref: "m00003" }] },
      { range: "m00005..m00006", topic: "Part 3", summary: "built part 3", keep: [{ kind: "objective", text: "ship part 3 docs" }] },
    ],
  });
  expect(first.ok).toBe(true);
}

describe("pinned ledger", () => {
  it("pins user intents and keep records, and carries them verbatim through a merge", () => {
    const { engine, sync } = setup();
    foldTwo(engine);
    sync();
    const b1 = engine.state.tree.get("b1")!;
    expect(b1.ledger).toEqual([
      { id: "b1.L1", kind: "intent", text: "turn 2: work on part 2", ref: "m00003" },
      { id: "b1.L2", kind: "constraint", text: "must support Node 22", ref: "m00003" },
    ]);
    const merged = engine.executeFold({ folds: [{ range: "b1,b2", topic: "Parts 2-3", summary: "parts 2 and 3 built" }], tier: 2 });
    expect(merged.ok).toBe(true);
    const b3 = engine.state.tree.get("b3")!;
    const text = renderBlockText(b3);
    expect(text).toContain("\nPinned:\n");
    expect(text).toContain("- [constraint] must support Node 22 (m00003)");
    expect(text).toContain("- [objective] ship part 3 docs");
    expect(b3.ledger!.map((r) => r.id)).toEqual(["b1.L1", "b1.L2", "b2.L1", "b2.L2"]);
  });

  it("retires objectives on merge but refuses to retire constraints or unknown ids", () => {
    const { engine, sync } = setup();
    foldTwo(engine);
    sync();
    const merge = (retire: string[]) => engine.executeFold({ folds: [{ range: "b1,b2", topic: "Parts", summary: "parts built", retire }], tier: 2 });
    const bad = merge(["b1.L2"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("ledger b1.L2 is a constraint; only objectives and intents can be retired");
    const unknown = merge(["b9.L1"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe("unknown ledger record b9.L1");
    expect(merge(["b2.L2"]).ok).toBe(true);
    expect(engine.state.tree.get("b3")!.ledger!.map((r) => r.text)).not.toContain("ship part 3 docs");
  });

  it("rejects keep refs outside the fold and retire on tier 1", () => {
    const { engine } = setup();
    const outside = engine.executeFold({ folds: [{ range: "m00003..m00004", topic: "P", summary: "s", keep: [{ kind: "decision", text: "use sqlite", ref: "m00009" }] }] });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toBe("keep ref m00009 is outside this fold");
    const retire = engine.executeFold({ folds: [{ range: "m00003..m00004", topic: "P", summary: "s", retire: ["b1.L1"] }] });
    expect(retire.ok).toBe(false);
    if (!retire.ok) expect(retire.error).toBe("retire is only valid when merging blocks");
  });

  it("survives a journal round-trip", () => {
    const { engine } = setup();
    foldTwo(engine);
    const block = engine.state.tree.get("b1")!;
    const parsed = parseJournalOp(JSON.parse(JSON.stringify(makeFoldOp(block))));
    expect(parsed?.op).toBe("fold");
    if (parsed?.op === "fold") expect(parsed.block.ledger).toEqual(block.ledger);
  });
});
