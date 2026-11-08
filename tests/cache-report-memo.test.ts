import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type OrigamiDb } from "../src/persist/db.ts";
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
      /* Windows may hold the sqlite handle briefly. */
    }
  }
});

function countingDb(db: OrigamiDb): { db: OrigamiDb; counts: { rounds: number; blocks: number } } {
  const counts = { rounds: 0, blocks: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "roundsForSession") counts.rounds++;
      if (prop === "blocksForSession") counts.blocks++;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, counts };
}

function engineWithDb(db: OrigamiDb) {
  const journal: JournalOp[] = [];
  const M = (role: string, content: string) => ({ type: "message", message: { role, content } });
  const entries = [
    M("user", "task one"),
    M("assistant", "working one"),
    M("user", "task two"),
    M("assistant", "working two"),
    M("toolResult", "big output\n" + "X".repeat(4_000)),
    M("assistant", "done two"),
    M("user", "task three"),
    M("assistant", "working three"),
  ];
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "sess-memo",
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

describe("telemetry memoization", () => {
  it("reads rounds and blocks once per data version, not once per status call", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-memo-"));
    dirs.push(dir);
    const { db, counts } = countingDb(openDb(join(dir, "origami.db")));
    const engine = engineWithDb(db);
    engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "turn two", summary: "did the second task" }],
      tier: 1,
      force: true,
    });

    counts.rounds = 0;
    counts.blocks = 0;
    engine.status();
    // No provider round yet, so only the round list is read and the report is not built.
    expect(counts).toEqual({ rounds: 1, blocks: 0 });

    engine.status();
    expect(counts).toEqual({ rounds: 1, blocks: 0 });
  });

  it("invalidates the memo when a provider round is recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-memo-"));
    dirs.push(dir);
    const { db, counts } = countingDb(openDb(join(dir, "origami.db")));
    const engine = engineWithDb(db);
    engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "turn two", summary: "did the second task" }],
      tier: 1,
      force: true,
    });
    counts.rounds = 0;
    counts.blocks = 0;
    engine.status();
    expect(counts).toEqual({ rounds: 1, blocks: 0 });

    engine.recordRound({ ts: 1, totalIn: 1_000, cacheRead: 900, cacheWrite: 0, foldEventId: null, hostRewrite: false });
    engine.status();

    // One fresh round read plus the first report build over the merged block set.
    expect(counts.rounds).toBe(2);
    expect(counts.blocks).toBe(1);
  });
});
