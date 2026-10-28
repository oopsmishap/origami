import { describe, expect, it } from "bun:test";
import { startDashboardServer } from "../src/ui/dashboard-server.ts";
import { SessionRegistry } from "../src/sessions.ts";
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
      status: "unfolded",
      consumed_by: null,
      ranges: "[]",
      children: "[]",
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

    db.archiveMessages([{
      session_id: "dash-session-1",
      ref: "m00042",
      role: "assistant",
      text: "The archived dragonfruit decision uses SQLite FTS.",
      turn: 3,
      tokens: 12,
      captured_at: Date.now(),
    }]);

    const registry = new SessionRegistry();
    registry.register({
      sessionId: "dash-session-1",
      agent: { kind: "main", id: "Main", name: "main", depth: 0, parentId: null },
      runtime,
      config: configFromPreset("balanced"),
      ctx: null,
    });

    // Start dashboard server on ephemeral port (openBrowser false)
    const dashboard = await startDashboardServer({
      port: 3890,
      registry,
      openBrowser: false,
    });

    try {
      expect(dashboard.url).toContain("http://127.0.0.1:");
      expect(dashboard.port).toBeGreaterThanOrEqual(3890);
      expect(dashboard.token).toMatch(/^[0-9a-f]{64}$/);
      expect(dashboard.url).toContain(`?token=${dashboard.token}`);
      const baseUrl = `http://127.0.0.1:${dashboard.port}`;
      const authHeaders = { "X-Origami-Token": dashboard.token };


      // 1. GET / -> HTML
      const htmlRes = await fetch(`${baseUrl}/`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const html = await htmlRes.text();
      expect(html).toContain("Origami Context Dashboard");
      expect(html).toContain("Prompt Cache Read Rate");
      expect(html).toContain("FTS5 Search");
      expect(htmlRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

      const missingTokenRes = await fetch(`${baseUrl}/api/status`);
      expect(missingTokenRes.status).toBe(401);

      const badOriginRes = await fetch(`${baseUrl}/api/status`, {
        headers: { ...authHeaders, Origin: "https://attacker.example" },
      });
      expect(badOriginRes.status).toBe(403);

      const badHostRes = await fetch(`${baseUrl}/api/status`, {
        headers: { ...authHeaders, Host: `attacker.example:${dashboard.port}` },
      });
      expect(badHostRes.status).toBe(403);

      const noContentTypeRes = await fetch(`${baseUrl}/api/fold`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ range: "m00001..m00002", topic: "x", summary: "y" }),
      });
      expect(noContentTypeRes.status).toBe(415);

      const queryOnlyPostRes = await fetch(`${baseUrl}/api/fold?token=${dashboard.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ range: "m00001..m00002", topic: "x", summary: "y" }),
      });
      expect(queryOnlyPostRes.status).toBe(401);

      for (const [path, body, error] of [
        ["fold", "{", "request body must be valid JSON"],
        ["fold", "null", "request body must be a JSON object"],
        ["fold", JSON.stringify({ range: "x", topic: "t", summary: "s", tier: 4 }), "tier must be 1, 2, or 3"],
        ["unfold", JSON.stringify({ id: "b1", mode: "deep" }), "mode must be file or inline"],
        ["unfold", JSON.stringify({}), "id must be a non-empty string"],
      ] as const) {
        const response = await fetch(`${baseUrl}/api/${path}`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
      }

      // 2. GET /api/status -> JSON
      const statusRes = await fetch(`${baseUrl}/api/status`, { headers: authHeaders });
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as { sessionId: string; windowTokens: number; liveTokens: number };
      expect(status.sessionId).toBe("dash-session-1");
      expect(status.windowTokens).toBe(100_000);

      // 3. GET /api/blocks -> JSON array
      const blocksRes = await fetch(`${baseUrl}/api/blocks?session=dash-session-1`, { headers: authHeaders });
      expect(blocksRes.status).toBe(200);
      const blocks = (await blocksRes.json()) as { block_id: string; topic: string }[];
      expect(blocks.length).toBe(1);
      expect(blocks[0]!.block_id).toBe("b1");
      expect(blocks[0]!.topic).toContain("Caching layer");

      // 4. GET /api/rounds -> JSON array
      const roundsRes = await fetch(`${baseUrl}/api/rounds?session=dash-session-1`, { headers: authHeaders });
      expect(roundsRes.status).toBe(200);
      const rounds = (await roundsRes.json()) as { total_in: number; cache_read: number }[];
      expect(rounds.length).toBe(1);
      expect(rounds[0]!.total_in).toBe(10_000);
      expect(rounds[0]!.cache_read).toBe(8_000);

      // 5. GET /api/search -> block and archived-message FTS5 results
      const searchRes = await fetch(`${baseUrl}/api/search?q=caching`, { headers: authHeaders });
      expect(searchRes.status).toBe(200);
      const search = (await searchRes.json()) as { blocks: { blockId: string }[]; messages: { ref: string }[] };
      expect(search.blocks.map((hit) => hit.blockId)).toEqual(["b1"]);
      const messageSearchRes = await fetch(`${baseUrl}/api/search?q=dragonfruit`, { headers: authHeaders });
      const messageSearch = (await messageSearchRes.json()) as { blocks: unknown[]; messages: { ref: string }[] };
      expect(messageSearch.blocks).toEqual([]);
      expect(messageSearch.messages.map((hit) => hit.ref)).toEqual(["m00042"]);

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
          status: "active",
          consumedBy: null,
          anchorRef: null,
          tokensBefore: 5000,
          tokensAfter: 500,
          createdAt: Date.now(),
        },
      });

      const unfoldRes = await fetch(`${baseUrl}/api/unfold`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "b1", mode: "file" }),
      });
      expect(unfoldRes.status).toBe(200);
      const unfoldData = (await unfoldRes.json()) as { ok: boolean; path?: string };
      expect(unfoldData.ok).toBe(true);
      expect(unfoldData.path).toBeDefined();

      // 7. GET /api/events -> SSE connection test
      const eventsRes = await fetch(`${baseUrl}/api/events?token=${dashboard.token}`);
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
