import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, type DbBlockRow, type DbMessageRow } from "../src/persist/db.ts";

const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  session_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tokens_before INTEGER NOT NULL DEFAULT 0,
  tokens_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, block_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  topic, summary, body, content='', tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS rounds (
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  total_in INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  fold_event_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  model TEXT,
  folds INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0
);
`;

const dirs: string[] = [];
function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "origami-db-"));
  dirs.push(dir);
  return { dir, path: join(dir, "origami.db") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function block(overrides: Partial<DbBlockRow> = {}): DbBlockRow {
  return {
    session_id: "session-1",
    block_id: "b1",
    tier: 1,
    topic: "Migration topic",
    summary: "A searchable summary containing dragonfruit",
    body: "Original body",
    tokens_before: 100,
    tokens_after: 20,
    created_at: 1000,
    status: "active",
    consumed_by: null,
    ranges: '["m1..m2"]',
    children: "[]",
    ...overrides,
  };
}

describe("OrigamiDb", () => {
  test("fresh open migrates to the current schema", () => {
    const { path } = tempDb();
    const db = openDb(path);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.recovered).toBeNull();
    expect(db.integrity()).toEqual({ ok: true, detail: "ok" });
    db.close();
  });

  test("migrates an old user_version 0 database and rebuilds searchable content", () => {
    const { path } = tempDb();
    const old = new Database(path, { create: true });
    old.exec(OLD_SCHEMA);
    old.query(`INSERT INTO blocks
      (session_id, block_id, tier, topic, summary, body, tokens_before, tokens_after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy", "b1", 2, "Legacy", "dragonfruit survives migration", "legacy body", 90, 15, 123);
    old.close();

    const db = openDb(path);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.blocksForSession("legacy")).toEqual([{
      session_id: "legacy",
      block_id: "b1",
      tier: 2,
      topic: "Legacy",
      summary: "dragonfruit survives migration",
      body: "legacy body",
      tokens_before: 90,
      tokens_after: 15,
      created_at: 123,
      status: "active",
      consumed_by: null,
      ranges: "[]",
      children: "[]",
    }]);
    const hits = db.searchBlocks("dragonfruit", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain("dragonfruit");
    db.close();
  });

  test("re-applies v3 after a database is downgraded to v2", () => {
    const { path } = tempDb();
    const current = openDb(path);
    current.insertBlock(block());
    current.archiveMessages([{ session_id: "session-1", ref: "m1", role: "user", text: "searchable archive", turn: 1, tokens: 2, captured_at: 10 }]);
    current.close();

    const downgraded = new Database(path);
    downgraded.exec(`
      DROP TABLE blocks_fts;
      DROP TABLE messages_fts;
      CREATE VIRTUAL TABLE blocks_fts USING fts5(topic, summary, body, content='', tokenize='unicode61');
      PRAGMA user_version = 2;
    `);
    downgraded.close();

    const upgraded = openDb(path);
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(upgraded.searchBlocks("dragonfruit", 10).map((hit) => hit.block_id)).toEqual(["b1"]);
    expect(upgraded.searchMessages("archive", 10).map((hit) => hit.ref)).toEqual(["m1"]);
    expect(upgraded.integrity()).toEqual({ ok: true, detail: "ok" });
    upgraded.close();
  });

  test("upserts a block without duplicate or stale full-text rows", () => {
    const { path } = tempDb();
    const db = openDb(path);
    db.insertBlock(block());
    db.insertBlock(block({ summary: "Updated summary with kumquat", body: "updated" }));
    expect(db.searchBlocks("dragonfruit", 10)).toHaveLength(0);
    const hits = db.searchBlocks("kumquat", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.block_id).toBe("b1");
    db.close();
  });

  test("refuses a schema newer than supported", () => {
    const { path } = tempDb();
    const sqlite = new Database(path, { create: true });
    sqlite.exec("PRAGMA user_version = 99");
    sqlite.close();
    expect(() => openDb(path)).toThrow(`origami.db schema v99 is newer than supported v${SCHEMA_VERSION}`);
  });

  test("quarantines a corrupt database and opens a fresh one", () => {
    const { dir, path } = tempDb();
    writeFileSync(path, "this is not sqlite");
    const db = openDb(path);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.recovered).not.toBeNull();
    expect(db.recovered).toStartWith(`${path}.corrupt-`);
    expect(readdirSync(dir).some((name) => name.startsWith("origami.db.corrupt-"))).toBe(true);
    expect(db.integrity().ok).toBe(true);
    db.close();
  });

  test("archives messages in chunks and latest values win", () => {
    const { path } = tempDb();
    const db = openDb(path);
    const rows: DbMessageRow[] = Array.from({ length: 505 }, (_, index) => ({
      session_id: "session-1",
      ref: `m${String(index).padStart(3, "0")}`,
      role: "user",
      text: `message ${index}`,
      turn: index,
      tokens: index + 1,
      captured_at: 1000 + index,
    }));
    db.archiveMessages(rows);
    db.archiveMessages([{ ...rows[0]!, text: "latest", tokens: 999 }]);
    const refs = [...rows].reverse().map((row) => row.ref);
    const restored = db.messagesForRefs("session-1", refs);
    expect(restored).toHaveLength(505);
    expect(restored[0]!.ref).toBe("m000");
    expect(restored[0]!.text).toBe("latest");
    expect(restored[0]!.tokens).toBe(999);
    expect(db.messagesForRefs("other", refs)).toEqual([]);
    db.close();
  });

  test("exports one session and prunes old records with their search rows", () => {
    const { path } = tempDb();
    const db = openDb(path);
    db.insertBlock(block({ block_id: "old", summary: "oldneedle", created_at: 10 }));
    db.insertBlock(block({ block_id: "new", summary: "newneedle", created_at: 100 }));
    db.updateBlockStatus("session-1", "new", "consumed", "b-parent");
    db.insertRound({ session_id: "session-1", ts: 10, total_in: 1, cache_read: 2, cache_write: 3, fold_event_id: null });
    db.insertRound({ session_id: "session-1", ts: 100, total_in: 4, cache_read: 5, cache_write: 6, fold_event_id: "f1" });
    db.archiveMessages([
      { session_id: "session-1", ref: "m1", role: "user", text: "old", turn: 1, tokens: 1, captured_at: 10 },
      { session_id: "session-1", ref: "m2", role: "assistant", text: "new", turn: 2, tokens: 2, captured_at: 100 },
      { session_id: "other", ref: "m3", role: "user", text: "hidden", turn: 1, tokens: 1, captured_at: 100 },
    ]);

    const exported = db.exportSession("session-1");
    expect(exported.schemaVersion).toBe(SCHEMA_VERSION);
    expect(exported.sessionId).toBe("session-1");
    expect(exported.exportedAt).toBeGreaterThan(0);
    expect(exported.blocks).toHaveLength(2);
    expect(exported.blocks.find((row) => row.block_id === "new")).toMatchObject({ status: "consumed", consumed_by: "b-parent" });
    expect(exported.rounds).toHaveLength(2);
    expect(exported.messages.map((row) => row.ref)).toEqual(["m1", "m2"]);

    expect(db.prune(50)).toEqual({ blocks: 1, rounds: 1, messages: 1 });
    expect(db.searchBlocks("oldneedle", 10)).toEqual([]);
    expect(db.searchBlocks("newneedle", 10)).toHaveLength(1);
    expect(db.blocksForSession("session-1").map((row) => row.block_id)).toEqual(["new"]);
    expect(db.roundsForSession("session-1").map((row) => row.ts)).toEqual([100]);
    expect(db.messagesForRefs("session-1", ["m1", "m2"]).map((row) => row.ref)).toEqual(["m2"]);
    expect(db.searchMessages("old", 10)).toEqual([]);
    db.close();
  });

  test("ranks active blocks first, stems terms, and falls back to any term", () => {
    const { path } = tempDb();
    const db = openDb(path);
    db.insertBlock(block({ block_id: "b1", topic: "Cache layer", summary: "migrated caching to redis", status: "unfolded", created_at: 1 }));
    db.insertBlock(block({ block_id: "b2", topic: "Auth", summary: "token refresh caches sessions", created_at: 2 }));
    expect(db.searchBlocks("cache", 10).map((hit) => [hit.block_id, hit.status])).toEqual([["b2", "active"], ["b1", "unfolded"]]);
    expect(db.searchBlocks("redis kafka", 10).map((hit) => hit.block_id)).toEqual(["b1"]);
    expect(db.searchBlocks("tier:1 session:session-1", 1)).toHaveLength(1);
    expect(db.searchBlocks("tier:1", 0)).toHaveLength(1);
    db.close();
  });

  test("searches archived messages with session filter and keeps the index in sync", () => {
    const { path } = tempDb();
    const db = openDb(path);
    db.archiveMessages([
      { session_id: "s1", ref: "m00003", role: "toolResult", text: "ENOSPC while copying onnxruntime", turn: 2, tokens: 9, captured_at: 10 },
      { session_id: "s2", ref: "m00004", role: "user", text: "disk full: ENOSPC again", turn: 1, tokens: 6, captured_at: 20 },
    ]);
    const all = db.searchMessages("enospc", 10);
    expect(all.map((hit) => `${hit.session_id}:${hit.ref}`).sort()).toEqual(["s1:m00003", "s2:m00004"]);
    expect(all.find((hit) => hit.ref === "m00003")!.snippet).toContain("[ENOSPC]");
    expect(db.searchMessages("enospc session:s1", 10).map((hit) => hit.ref)).toEqual(["m00003"]);
    expect(db.searchMessages("enospc tier:1", 10)).toEqual([]);
    expect(db.searchMessages("copied", 10).map((hit) => hit.ref)).toEqual(["m00003"]);
    db.archiveMessages([{ session_id: "s1", ref: "m00003", role: "toolResult", text: "replaced text", turn: 2, tokens: 2, captured_at: 30 }]);
    expect(db.searchMessages("onnxruntime", 10)).toEqual([]);
    expect(db.searchMessages("replaced", 10).map((hit) => hit.ref)).toEqual(["m00003"]);
    db.close();
  });

  test("persists a fold batch atomically", () => {
    const { path } = tempDb();
    const db = openDb(path);
    const row = block({ block_id: "atomic" });
    expect(() => db.persistFoldBatch({
      messages: [{ session_id: "session-1", ref: "m1", role: "user", text: "atomic archive", turn: 1, tokens: 2, captured_at: 1 }],
      blocks: [row, { ...row, block_id: null as unknown as string }],
      statuses: [],
    })).toThrow();
    expect(db.blocksForSession("session-1")).toEqual([]);
    expect(db.messagesForRefs("session-1", ["m1"])).toEqual([]);

    db.persistFoldBatch({ messages: [], blocks: [row], statuses: [] });
    expect(db.blocksForSession("session-1").map((b) => b.block_id)).toEqual(["atomic"]);
    db.close();
  });
});
