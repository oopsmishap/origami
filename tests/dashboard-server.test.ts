import { describe, expect, it } from "bun:test";
import { startDashboardServer } from "../src/ui/dashboard-server.ts";
import { OrigamiRuntime } from "../src/runtime.ts";
import { openDb } from "../src/persist/db.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import { unlinkSync } from "node:fs";

describe("Standalone Web Dashboard Server", () => {
  it("serves HTML dashboard, status, blocks, rounds, search, and action endpoints", async () => {
    const dbFile = `/tmp/origami-dash-${Date.now()}.db`;
    const db = openDb(dbFile);

    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "m0", message: { role: "system", content: "system" } },
      { type: "message", id: "m1", message: { role: "user", content: "Implement caching layer" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "Caching implemented with redis and memory tier" } },
      { type: "message", id: "m3", message: { role: "user", content: "Next step" } },
    ];

    const host = {
      sessionId: () => "dash-session-1",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/art.md",
      windowTokens: () => 100_000,
      projectedTokens: () => 25_000,
      entries: () => entries,
    };

    const runtime = new OrigamiRuntime({
      host,
      modelId: "test-model",
      config: configFromPreset("balanced"),
      countFn: (t) => t.length,
    });
    runtime.attachDb(db);
    runtime.sync();

    // Seed a block into DB
    db.insertBlock({
      session_id: "dash-session-1",
      block_id: "b1",
      tier: 1,
      topic: "Caching layer architecture",
      summary: "Implemented two-tier cache with redis fallback.",
      body: "Caching layer architecture\nImplemented two-tier cache with redis fallback.",
      tokens_before: 5000,
      tokens_after: 500,
      created_at: Date.now(),
    });

    // Seed a round into DB
    db.insertRound({
      session_id: "dash-session-1",
      ts: Date.now(),
      total_in: 10_000,
      cache_read: 8_000,
      cache_write: 2_000,
      fold_event_id: "b1",
    });

    // Start dashboard server on ephemeral port (openBrowser false)
    const dashboard = await startDashboardServer({
      port: 3890,
      getRuntime: () => runtime,
      openBrowser: false,
    });

    try {
      expect(dashboard.url).toContain("http://127.0.0.1:");
      expect(dashboard.port).toBeGreaterThanOrEqual(3890);

      // 1. GET / -> HTML
      const htmlRes = await fetch(`${dashboard.url}/`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const html = await htmlRes.text();
      expect(html).toContain("Origami Context Dashboard");
      expect(html).toContain("Prompt Cache Read Rate");
      expect(html).toContain("FTS5 Search");

      // 2. GET /api/status -> JSON
      const statusRes = await fetch(`${dashboard.url}/api/status`);
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as { sessionId: string; windowTokens: number; liveTokens: number };
      expect(status.sessionId).toBe("dash-session-1");
      expect(status.windowTokens).toBe(100_000);

      // 3. GET /api/blocks -> JSON array
      const blocksRes = await fetch(`${dashboard.url}/api/blocks?session=dash-session-1`);
      expect(blocksRes.status).toBe(200);
      const blocks = (await blocksRes.json()) as { block_id: string; topic: string }[];
      expect(blocks.length).toBe(1);
      expect(blocks[0]!.block_id).toBe("b1");
      expect(blocks[0]!.topic).toContain("Caching layer");

      // 4. GET /api/rounds -> JSON array
      const roundsRes = await fetch(`${dashboard.url}/api/rounds?session=dash-session-1`);
      expect(roundsRes.status).toBe(200);
      const rounds = (await roundsRes.json()) as { total_in: number; cache_read: number }[];
      expect(rounds.length).toBe(1);
      expect(rounds[0]!.total_in).toBe(10_000);
      expect(rounds[0]!.cache_read).toBe(8_000);

      // 5. GET /api/search -> FTS5 search
      const searchRes = await fetch(`${dashboard.url}/api/search?q=caching`);
      expect(searchRes.status).toBe(200);
      const hits = (await searchRes.json()) as { blockId: string; topic: string }[];
      expect(hits.length).toBe(1);
      expect(hits[0]!.blockId).toBe("b1");

      // 6. POST /api/unfold (artifact file mode)
      // First ensure block is registered in engine fold tree for unfold
      runtime.engine.state.tree.apply({
        op: "fold",
        block: {
          id: "b1",
          tier: 1,
          ranges: [{ start: "m00001", end: "m00002" }],
          topic: "Caching layer architecture",
          summary: "Implemented two-tier cache with redis fallback.",
          children: [],
          superseded: false,
          tokensBefore: 5000,
          tokensAfter: 500,
          createdAt: Date.now(),
        },
      });

      const unfoldRes = await fetch(`${dashboard.url}/api/unfold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "b1", mode: "file" }),
      });
      expect(unfoldRes.status).toBe(200);
      const unfoldData = (await unfoldRes.json()) as { ok: boolean; path?: string };
      expect(unfoldData.ok).toBe(true);
      expect(unfoldData.path).toBeDefined();

      // 7. GET /api/events -> SSE connection test
      const eventsRes = await fetch(`${dashboard.url}/api/events`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
      // Read initial connection event
      const reader = eventsRes.body?.getReader();
      expect(reader).toBeDefined();
      if (reader) {
        const chunk = await reader.read();
        const text = new TextDecoder().decode(chunk.value);
        expect(text).toContain("event: connected");
        await reader.cancel();
      }
    } finally {
      dashboard.stop();
      db.close();
      try {
        unlinkSync(dbFile);
      } catch {
        // ignore
      }
    }
  });
});
