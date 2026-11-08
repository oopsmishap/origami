import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { JournalOp } from "../src/kernel/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

function fixture(throwOnAppendCall?: number) {
  const journal: JournalOp[] = [];
  const entries: { type: "message"; message: { role: string; content: string } }[] = [];
  for (let k = 1; k <= 8; k++) {
    entries.push({ type: "message", message: { role: "user", content: `task ${k}` } });
    entries.push({ type: "message", message: { role: "assistant", content: `working ${k}` } });
    entries.push({ type: "message", message: { role: "toolResult", content: `output ${k} ${"x".repeat(200)}` } });
  }

  let appends = 0;
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "sess-atomic",
      appendEvent: (op: JournalOp) => {
        appends++;
        if (throwOnAppendCall !== undefined && appends >= throwOnAppendCall) throw new Error("journal write failed (simulated host I/O)");
        journal.push(op);
      },
      saveArtifact: async () => "/tmp/unused.md",
      windowTokens: () => 1_000_000,
      projectedTokens: () => 100_000,
    },
    entries,
    modelId: "test",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 2, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
  });

  engine.refresh(entries);
  engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
  return { engine, journal, appends: () => appends };
}

const BATCH = {
  folds: [
    { range: "m00004..m00006", topic: "turn two", summary: "did the second task" },
    { range: "m00007..m00009", topic: "turn three", summary: "did the third task" },
  ],
  tier: 1 as const,
};

describe("commitFoldBatch host-failure atomicity", () => {
  it("commits nothing when the first journal append fails", () => {
    const { engine, journal } = fixture(1);
    const result = engine.executeFold(BATCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("0/2");
    expect(result.committed).toBeUndefined();
    expect(engine.state.tree.all().length).toBe(0);
    expect(journal.length).toBe(0);
  });

  it("applies and reports exactly the folds whose op reached the journal", () => {
    const { engine, journal } = fixture(2);
    const result = engine.executeFold(BATCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain("1/2");
    expect(result.committed).toEqual(["b1"]);
    expect(journal.length).toBe(1);
    expect(engine.state.tree.all().map((b) => b.id)).toEqual(["b1"]);
    expect(engine.state.tree.get("b1")?.status).toBe("active");
  });

  it("keeps the journal and the tree in sync after a partial batch", () => {
    const { engine, journal } = fixture(2);
    engine.executeFold(BATCH);
    const folded = journal.flatMap((op) => (op.op === "fold" ? [op.block.id] : []));
    expect(engine.state.tree.all().map((b) => b.id)).toEqual(folded);
  });

  it("reports an already-folded range by its covering block, not as missing messages", () => {
    const { engine } = fixture(2);
    engine.executeFold(BATCH);
    const retry = engine.executeFold(BATCH);
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error).toContain("already covered by block b1");
    expect(retry.error).not.toContain("matches no messages");
  });

  it("commits the whole batch when every append succeeds", () => {
    const { engine, journal } = fixture();
    const result = engine.executeFold(BATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(journal.length).toBe(2);
    expect(engine.state.tree.all().length).toBe(2);
  });
});
