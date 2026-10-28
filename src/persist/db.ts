import { existsSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Block } from "../kernel/types.ts";

export const SCHEMA_VERSION = 3;
export const MAX_SEARCH_HITS = 50;

export interface DbBlockRow {
  session_id: string;
  block_id: string;
  tier: number;
  topic: string;
  summary: string;
  body: string;
  tokens_before: number;
  tokens_after: number;
  created_at: number;
  status: string;
  consumed_by: string | null;
  ranges: string;
  children: string;
}

export interface DbRoundRow {
  session_id: string;
  ts: number;
  total_in: number;
  cache_read: number;
  cache_write: number;
  fold_event_id: string | null;
}

export interface DbMessageRow {
  session_id: string;
  ref: string;
  role: string;
  text: string;
  turn: number;
  tokens: number;
  captured_at: number;
}

export interface DbBlockStatus {
  session_id: string;
  block_id: string;
  status: string;
  consumed_by: string | null;
}

export interface DbFoldBatch {
  messages: DbMessageRow[];
  blocks: DbBlockRow[];
  statuses: DbBlockStatus[];
}

export interface DbBlockHit {
  block_id: string;
  session_id: string;
  tier: number;
  topic: string;
  status: string;
  snippet: string;
  rank: number;
}

export interface DbMessageHit {
  session_id: string;
  ref: string;
  role: string;
  turn: number;
  snippet: string;
  rank: number;
}

export interface OrigamiDb {
  readonly schemaVersion: number;
  readonly recovered: string | null;
  integrity(): { ok: boolean; detail: string };
  persistFoldBatch(batch: DbFoldBatch): void;
  updateBlockStatuses(rows: DbBlockStatus[]): void;
  insertBlock(row: DbBlockRow): void;
  updateBlockStatus(sessionId: string, blockId: string, status: string, consumedBy: string | null): void;
  insertRound(row: DbRoundRow): void;
  archiveMessages(rows: DbMessageRow[]): void;
  messagesForRefs(sessionId: string, refs: readonly string[]): DbMessageRow[];
  /** Ranked search over fold blocks (topic weighted over summary); supports `tier:N` and `session:ID` filters. */
  searchBlocks(query: string, limit: number): DbBlockHit[];
  /** Ranked search over archived original messages; `session:ID` filter; skipped for `tier:` queries. */
  searchMessages(query: string, limit: number): DbMessageHit[];
  roundsForSession(sessionId: string): DbRoundRow[];
  blocksForSession(sessionId: string): DbBlockRow[];
  exportSession(sessionId: string): {
    schemaVersion: number;
    sessionId: string;
    exportedAt: number;
    blocks: DbBlockRow[];
    rounds: DbRoundRow[];
    messages: DbMessageRow[];
  };
  prune(cutoffMs: number): { blocks: number; rounds: number; messages: number };
  close(): void;
}

const MIGRATION_1 = `
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

const MIGRATION_2 = `
ALTER TABLE blocks ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE blocks ADD COLUMN consumed_by TEXT;
ALTER TABLE blocks ADD COLUMN ranges TEXT NOT NULL DEFAULT '[]';
ALTER TABLE blocks ADD COLUMN children TEXT NOT NULL DEFAULT '[]';
DROP TABLE blocks_fts;
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  topic, summary, body, tokenize='unicode61'
);
INSERT INTO blocks_fts(rowid, topic, summary, body)
  SELECT rowid, topic, summary, body FROM blocks;
CREATE TABLE messages (
  session_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  turn INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, ref)
);
CREATE INDEX rounds_session_ts ON rounds(session_id, ts);
CREATE INDEX blocks_created_at ON blocks(created_at);
CREATE INDEX messages_captured_at ON messages(captured_at);
`;

// v3: external-content FTS kept in sync by triggers; porter stemming; archived messages become searchable.
const MIGRATION_3 = `
DROP TRIGGER IF EXISTS blocks_fts_ai;
DROP TRIGGER IF EXISTS blocks_fts_ad;
DROP TRIGGER IF EXISTS blocks_fts_au;
DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS blocks_fts;
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  topic, summary, content='blocks', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, topic, summary) VALUES (new.rowid, new.topic, new.summary);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, topic, summary) VALUES ('delete', old.rowid, old.topic, old.summary);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF topic, summary ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, topic, summary) VALUES ('delete', old.rowid, old.topic, old.summary);
  INSERT INTO blocks_fts(rowid, topic, summary) VALUES (new.rowid, new.topic, new.summary);
END;
INSERT INTO blocks_fts(blocks_fts) VALUES ('rebuild');
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
`;

interface ParsedQuery {
  terms: string[];
  tier: number | null;
  session: string | null;
}

function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { terms: [], tier: null, session: null };
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("tier:")) {
      const tier = Number.parseInt(token.slice(5), 10);
      if (!Number.isNaN(tier)) parsed.tier = tier;
    } else if (token.startsWith("session:")) {
      parsed.session = token.slice(8);
    } else parsed.terms.push(token);
  }
  return parsed;
}

function matchExpression(terms: readonly string[], joiner: " " | " OR "): string {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(joiner);
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_SEARCH_HITS, Math.floor(Number.isFinite(limit) ? limit : MAX_SEARCH_HITS)));
}

/** All terms first; when a multi-term query matches nothing, fall back to any term. */
function allThenAny<T>(terms: readonly string[], run: (match: string) => T[]): T[] {
  const strict = run(matchExpression(terms, " "));
  if (strict.length > 0 || terms.length < 2) return strict;
  return run(matchExpression(terms, " OR "));
}

function transaction(sqlite: Database, fn: () => void): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    fn();
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function blockWriter(sqlite: Database): (row: DbBlockRow) => void {
  const statement = sqlite.query(
    `INSERT INTO blocks
       (session_id, block_id, tier, topic, summary, body, tokens_before, tokens_after, created_at, status, consumed_by, ranges, children)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, block_id) DO UPDATE SET
       tier=excluded.tier, topic=excluded.topic, summary=excluded.summary, body=excluded.body,
       tokens_before=excluded.tokens_before, tokens_after=excluded.tokens_after, created_at=excluded.created_at,
       status=excluded.status, consumed_by=excluded.consumed_by, ranges=excluded.ranges, children=excluded.children`,
  );
  return (row) => {
    statement.run(row.session_id, row.block_id, row.tier, row.topic, row.summary, row.body, row.tokens_before, row.tokens_after, row.created_at, row.status, row.consumed_by, row.ranges, row.children);
  };
}

function messageWriter(sqlite: Database): (row: DbMessageRow) => void {
  const statement = sqlite.query(`INSERT INTO messages (session_id, ref, role, text, turn, tokens, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, ref) DO UPDATE SET role=excluded.role, text=excluded.text,
      turn=excluded.turn, tokens=excluded.tokens, captured_at=excluded.captured_at`);
  return (row) => statement.run(row.session_id, row.ref, row.role, row.text, row.turn, row.tokens, row.captured_at);
}

function statusWriter(sqlite: Database): (row: DbBlockStatus) => void {
  const statement = sqlite.query("UPDATE blocks SET status = ?, consumed_by = ? WHERE session_id = ? AND block_id = ?");
  return (row) => statement.run(row.status, row.consumed_by, row.session_id, row.block_id);
}

function integrityResult(sqlite: Database): { ok: boolean; detail: string } {
  try {
    const rows = sqlite.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    const detail = rows.map((row) => row.quick_check).join("\n") || "quick_check returned no result";
    return { ok: rows.length === 1 && rows[0]?.quick_check === "ok", detail };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function isCorruptError(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === "SQLITE_CORRUPT" || value?.code === "SQLITE_NOTADB" || /database disk image is malformed|file is not a database/i.test(value?.message ?? "");
}

function quarantine(path: string): string {
  const quarantined = `${path}.corrupt-${Date.now()}`;
  if (existsSync(path)) renameSync(path, quarantined);
  if (existsSync(`${path}-wal`)) renameSync(`${path}-wal`, `${quarantined}-wal`);
  if (existsSync(`${path}-shm`)) renameSync(`${path}-shm`, `${quarantined}-shm`);
  return quarantined;
}

function openChecked(path: string): { sqlite: Database; recovered: string | null } {
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(path, { create: true });
    const check = integrityResult(sqlite);
    if (!check.ok) throw Object.assign(new Error(check.detail), { code: "SQLITE_CORRUPT" });
    return { sqlite, recovered: null };
  } catch (error) {
    try {
      sqlite?.close();
    } catch {
      // The damaged handle may not close cleanly.
    }
    if (!isCorruptError(error) || path === ":memory:") throw error;
    const recovered = quarantine(path);
    const fresh = new Database(path, { create: true });
    return { sqlite: fresh, recovered };
  }
}

export function openDb(path: string): OrigamiDb {
  const opened = openChecked(path);
  const sqlite = opened.sqlite;
  sqlite.exec("PRAGMA journal_mode=WAL;");

  let version = Number(sqlite.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > SCHEMA_VERSION) {
    sqlite.close();
    throw new Error(`origami.db schema v${version} is newer than supported v${SCHEMA_VERSION}`);
  }

  const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3];
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    transaction(sqlite, () => {
      sqlite.exec(migrations[next - 1]!);
      sqlite.exec(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }

  const db: OrigamiDb = {
    schemaVersion: version,
    recovered: opened.recovered,
    integrity() {
      return integrityResult(sqlite);
    },
    insertBlock(row) {
      const write = blockWriter(sqlite);
      transaction(sqlite, () => write(row));
    },
    updateBlockStatus(sessionId, blockId, status, consumedBy) {
      statusWriter(sqlite)({ session_id: sessionId, block_id: blockId, status, consumed_by: consumedBy });
    },
    persistFoldBatch(batch) {
      const writeMessage = messageWriter(sqlite);
      const writeBlock = blockWriter(sqlite);
      const writeStatus = statusWriter(sqlite);
      transaction(sqlite, () => {
        for (const row of batch.messages) writeMessage(row);
        for (const row of batch.blocks) writeBlock(row);
        for (const row of batch.statuses) writeStatus(row);
      });
    },
    updateBlockStatuses(rows) {
      if (rows.length === 0) return;
      const write = statusWriter(sqlite);
      transaction(sqlite, () => {
        for (const row of rows) write(row);
      });
    },
    insertRound(row) {
      sqlite.query("INSERT INTO rounds (session_id, ts, total_in, cache_read, cache_write, fold_event_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.session_id, row.ts, row.total_in, row.cache_read, row.cache_write, row.fold_event_id);
    },
    archiveMessages(rows) {
      if (rows.length === 0) return;
      const write = messageWriter(sqlite);
      transaction(sqlite, () => {
        for (const row of rows) write(row);
      });
    },
    messagesForRefs(sessionId, refs) {
      if (refs.length === 0) return [];
      const rows: DbMessageRow[] = [];
      const unique = [...new Set(refs)];
      for (let offset = 0; offset < unique.length; offset += 500) {
        const chunk = unique.slice(offset, offset + 500);
        const placeholders = chunk.map(() => "?").join(",");
        rows.push(...sqlite.query<DbMessageRow, string[]>(`SELECT * FROM messages WHERE session_id = ? AND ref IN (${placeholders})`,).all(sessionId, ...chunk));
      }
      return rows.sort((a, b) => a.ref.localeCompare(b.ref));
    },
    searchBlocks(query, limit) {
      const parsed = parseQuery(query);
      const max = clampLimit(limit);
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (parsed.tier !== null) { clauses.push("b.tier = ?"); params.push(parsed.tier); }
      if (parsed.session !== null) { clauses.push("b.session_id = ?"); params.push(parsed.session); }
      if (parsed.terms.length === 0) {
        if (clauses.length === 0) return [];
        return sqlite.query<DbBlockHit, (string | number)[]>(
          `SELECT b.block_id, b.session_id, b.tier, b.topic, b.status, b.summary AS snippet, 0 AS rank
           FROM blocks b WHERE ${clauses.join(" AND ")}
           ORDER BY (b.status = 'active') DESC, b.created_at DESC LIMIT ?`,
        ).all(...params, max);
      }
      const where = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
      return allThenAny(parsed.terms, (match) => sqlite.query<DbBlockHit, (string | number)[]>(
        `SELECT b.block_id, b.session_id, b.tier, b.topic, b.status,
           snippet(blocks_fts, -1, '[', ']', '…', 12) AS snippet, bm25(blocks_fts, 2.0, 1.0) AS rank
         FROM blocks_fts JOIN blocks b ON b.rowid = blocks_fts.rowid
         WHERE blocks_fts MATCH ?${where}
         ORDER BY (b.status = 'active') DESC, rank, b.created_at DESC LIMIT ?`,
      ).all(match, ...params, max));
    },
    searchMessages(query, limit) {
      const parsed = parseQuery(query);
      if (parsed.tier !== null || parsed.terms.length === 0) return [];
      const max = clampLimit(limit);
      const where = parsed.session !== null ? " AND m.session_id = ?" : "";
      const params: (string | number)[] = parsed.session !== null ? [parsed.session] : [];
      return allThenAny(parsed.terms, (match) => sqlite.query<DbMessageHit, (string | number)[]>(
        `SELECT m.session_id, m.ref, m.role, m.turn,
           snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet, bm25(messages_fts) AS rank
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?${where}
         ORDER BY rank, m.captured_at DESC LIMIT ?`,
      ).all(match, ...params, max));
    },
    roundsForSession(sessionId) {
      return sqlite.query<DbRoundRow, [string]>("SELECT * FROM rounds WHERE session_id = ? ORDER BY ts").all(sessionId);
    },
    blocksForSession(sessionId) {
      return sqlite.query<DbBlockRow, [string]>("SELECT * FROM blocks WHERE session_id = ? ORDER BY created_at").all(sessionId);
    },
    exportSession(sessionId) {
      return {
        schemaVersion: version,
        sessionId,
        exportedAt: Date.now(),
        blocks: db.blocksForSession(sessionId),
        rounds: db.roundsForSession(sessionId),
        messages: sqlite.query<DbMessageRow, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY ref").all(sessionId),
      };
    },
    prune(cutoffMs) {
      let blocks = 0;
      let rounds = 0;
      let messages = 0;
      // `.changes` also counts FTS trigger writes, so count the doomed rows first.
      const count = (sql: string): number => sqlite.query<{ n: number }, [number]>(sql).get(cutoffMs)?.n ?? 0;
      transaction(sqlite, () => {
        blocks = count("SELECT COUNT(*) AS n FROM blocks WHERE created_at < ?");
        rounds = count("SELECT COUNT(*) AS n FROM rounds WHERE ts < ?");
        messages = count("SELECT COUNT(*) AS n FROM messages WHERE captured_at < ?");
        sqlite.query("DELETE FROM blocks WHERE created_at < ?").run(cutoffMs);
        sqlite.query("DELETE FROM rounds WHERE ts < ?").run(cutoffMs);
        sqlite.query("DELETE FROM messages WHERE captured_at < ?").run(cutoffMs);
      });
      return { blocks, rounds, messages };
    },
    close() {
      sqlite.close();
    },
  };
  return db;
}

export function blockBodyForIndex(block: Block): string {
  return `${block.topic}\n${block.summary}`;
}
