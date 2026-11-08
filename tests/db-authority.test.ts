import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbBlockRow, type OrigamiDb } from "../src/persist/db.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { JournalOp } from "../src/kernel/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the sqlite handle briefly; the OS temp dir is disposable. */
    }
  }
});

function blockRow(overrides: Partial<DbBlockRow> = {}): DbBlockRow {
  return {
    session_id: "sess-authority",
    block_id: "phantom",
    tier: 1,
    topic: "phantom block",
    summary: "not in the journal",
    body: "",
    tokens_before: 500,
    tokens_after: 50,
    created_at: 5000,
    status: "active",
    consumed_by: null,
    ranges: "[]",
    children: "[]",
    ...overrides,
  };
}

function engineWithDb(db: OrigamiDb) {
  const journal: JournalOp[] = [];
  const M = (role: string, content: string) => ({ type: "message", message: { role, content } });
  const entries = [
    M("user", "task one"),
    M("assistant", "working one"),
    M("user", "task two"),
    M("assistant", "working two"),
    M("toolResult", "big output\n" + "X".repeat(4000)),
    M("assistant", "done two"),
    M("user", "task three"),
    M("assistant", "working three"),
  ];
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "sess-authority",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/unused.md",
      windowTokens: () => 1_000_000,
      projectedTokens: () => 100_000,
    },
    entries,
    modelId: "test",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 2, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
  });
  engine.attachDb(db);
  engine.refresh(entries);
  engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
  return engine;
}

describe("block source authority", () => {
  it("merges the DB mirror with the journal tree instead of preferring one", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-auth-"));
    dirs.push(dir);
    const db = openDb(join(dir, "origami.db"));
    const engine = engineWithDb(db);

    const folded = engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "turn two", summary: "did the second task" }],
      tier: 1,
      force: true,
    });
    expect(folded.ok).toBe(true);
    db.insertBlock(blockRow());

    const report = engine.cacheReport();
    expect(report.folds.map((f) => f.id)).toContain("b1");
    expect(report.folds.map((f) => f.id)).toContain("phantom");
    expect(engine.status().blockMirrorMismatch).toBe(true);
    db.close();
  });

  it("keeps the journal tree authoritative when the mirror disagrees on the same block", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-auth-"));
    dirs.push(dir);
    const db = openDb(join(dir, "origami.db"));
    const engine = engineWithDb(db);

    engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "turn two", summary: "did the second task" }],
      tier: 1,
      force: true,
    });
    const treeBlock = engine.state.tree.get("b1")!;
    db.insertBlock(blockRow({ block_id: "b1", tokens_before: 7, tokens_after: 1 }));

    const fold = engine.cacheReport().folds.find((f) => f.id === "b1")!;
    expect(fold.S).toBe(treeBlock.tokensBefore);
    expect(fold.S).not.toBe(7);
    expect(engine.status().blockMirrorMismatch).toBeUndefined();
    db.close();
  });

  it("reports no mismatch when the mirror matches the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-auth-"));
    dirs.push(dir);
    const db = openDb(join(dir, "origami.db"));
    const engine = engineWithDb(db);
    engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "turn two", summary: "did the second task" }],
      tier: 1,
      force: true,
    });

    engine.cacheReport();
    expect(engine.status().blockMirrorMismatch).toBeUndefined();
    db.close();
  });
});
