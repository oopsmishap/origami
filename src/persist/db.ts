import { Database } from "bun:sqlite";
import type { Block } from "../kernel/types.ts";

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
}

export interface DbRoundRow {
  session_id: string;
  ts: number;
  total_in: number;
  cache_read: number;
  cache_write: number;
  fold_event_id: string | null;
}

export interface OrigamiDb {
  insertBlock(row: DbBlockRow): void;
  insertRound(row: DbRoundRow): void;
  searchBlocks(query: string, limit: number): { block_id: string; session_id: string; tier: number; topic: string; snippet: string; rank: number }[];
  roundsForSession(sessionId: string): DbRoundRow[];
  blocksForSession(sessionId: string): DbBlockRow[];
  close(): void;
}

const SCHEMA = `
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

export function openDb(path: string): OrigamiDb {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec(SCHEMA);

  return {
    insertBlock(row) {
      sqlite
        .query(
          "INSERT OR REPLACE INTO blocks (session_id, block_id, tier, topic, summary, body, tokens_before, tokens_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(row.session_id, row.block_id, row.tier, row.topic, row.summary, row.body, row.tokens_before, row.tokens_after, row.created_at);
      sqlite.query("INSERT INTO blocks_fts (rowid, topic, summary, body) VALUES ((SELECT rowid FROM blocks WHERE session_id = ? AND block_id = ?), ?, ?, ?)").run(
        row.session_id,
        row.block_id,
        row.topic,
        row.summary,
        row.body,
      );
    },
    insertRound(row) {
      sqlite
        .query("INSERT INTO rounds (session_id, ts, total_in, cache_read, cache_write, fold_event_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.session_id, row.ts, row.total_in, row.cache_read, row.cache_write, row.fold_event_id);
    },
    searchBlocks(query, limit) {
      let tierFilter: number | null = null;
      let sessionFilter: string | null = null;
      const terms: string[] = [];

      for (const token of query.split(/\s+/).filter(Boolean)) {
        if (token.startsWith("tier:")) {
          const t = Number.parseInt(token.slice(5), 10);
          if (!Number.isNaN(t)) tierFilter = t;
        } else if (token.startsWith("session:")) {
          sessionFilter = token.slice(8);
        } else {
          terms.push(token);
        }
      }

      const q = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
      const clauses: string[] = [];
      const params: (string | number)[] = [];

      if (q) {
        clauses.push("blocks_fts MATCH ?");
        params.push(q);
      }
      if (tierFilter !== null) {
        clauses.push("b.tier = ?");
        params.push(tierFilter);
      }
      if (sessionFilter !== null) {
        clauses.push("b.session_id = ?");
        params.push(sessionFilter);
      }

      if (clauses.length === 0) return [];
      const whereSql = clauses.join(" AND ");
      params.push(limit);

      const sql = q
        ? `SELECT b.block_id, b.session_id, b.tier, b.topic,
                  snippet(blocks_fts, 1, '[', ']', '…', 12) AS snippet,
                  bm25(blocks_fts) AS rank
           FROM blocks_fts f JOIN blocks b ON b.rowid = f.rowid
           WHERE ${whereSql}
           ORDER BY rank LIMIT ?`
        : `SELECT b.block_id, b.session_id, b.tier, b.topic,
                  b.summary AS snippet,
                  0 AS rank
           FROM blocks b
           WHERE ${whereSql}
           ORDER BY b.created_at DESC LIMIT ?`;

      return sqlite
        .query<{ block_id: string; session_id: string; tier: number; topic: string; snippet: string; rank: number }, (string | number)[]>(sql)
        .all(...params);
    },
    roundsForSession(sessionId) {
      return sqlite.query<DbRoundRow, [string]>("SELECT * FROM rounds WHERE session_id = ? ORDER BY ts").all(sessionId);
    },
    blocksForSession(sessionId) {
      return sqlite.query<DbBlockRow, [string]>("SELECT * FROM blocks WHERE session_id = ? ORDER BY created_at").all(sessionId);
    },
    close() {
      sqlite.close();
    },
  };
}

export function blockBodyForIndex(block: Block): string {
  return `${block.topic}\n${block.summary}`;
}
