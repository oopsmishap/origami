import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { OrigamiRuntime } from "../src/runtime.ts";
import { openDb } from "../src/persist/db.ts";
import { configFromPreset } from "../src/config.ts";
import { registerTools } from "../src/tools/index.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

describe("Real-session smoke (tools + SQLite)", () => {
  it("exercises fold, fold_status, fold_search, fold_cache tools and verifies SQLite persistence", async () => {
    const dbFile = `/tmp/origami-smoke-${Date.now()}.db`;
    const db = openDb(dbFile);

    const journal: JournalOp[] = [];
    const entries: { type: string; id: string; message: { role: string; content: string } }[] = [
      { type: "message", id: "m0", message: { role: "system", content: "system prompt" } },
      { type: "message", id: "m1", message: { role: "user", content: "Let us design the database schema for user auth" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "We need users table with id, email, password_hash, created_at" } },
      { type: "message", id: "m3", message: { role: "user", content: "Also add sessions table with token, user_id, expires_at; index the token column, cascade deletes from users, and keep expired rows for a week of audit." } },
      { type: "message", id: "m4", message: { role: "assistant", content: "Sessions table added with foreign key to users, a unique index on token, ON DELETE CASCADE, and a nightly purge of rows expired for more than seven days. Migration 0042 creates the table, backfills existing tokens from the legacy cookie store, and the repository layer now exposes createSession, findSessionByToken and revokeSession with tests for expiry and cascade behaviour." } },
      { type: "message", id: "m5", message: { role: "user", content: "Now let us implement login endpoint" } },
    ];

    const artifacts = new Map<string, string>();
    const host = {
      sessionId: () => "smoke-session-1",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async (content: string, toolType: string) => {
        const path = `/tmp/artifact-${toolType}-${artifacts.size + 1}.md`;
        artifacts.set(path, content);
        return path;
      },
      windowTokens: () => 100_000,
      projectedTokens: () => 20_000,
      entries: () => entries,
    };

    // Recent-tail protection off: the fixture is too short to have an unprotected middle.
    const config = { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 };
    const runtime = new OrigamiRuntime({
      host,
      modelId: "test-model",
      config,
      countFn: (t) => t.length,
    });
    runtime.attachDb(db);
    runtime.sync();

    // Collect registered tools
    const tools = new Map<string, ToolDefinition>();
    const pass = <T>(v: T) => v;
    const fakeApi = {
      typebox: {
        Type: {
          Object: pass,
          Array: pass,
          String: pass,
          Optional: pass,
          Union: pass,
          Literal: pass,
          Integer: pass,
          Boolean: pass,
        },
      },
      registerTool: (t: ToolDefinition) => tools.set(t.name, t),
    } as unknown as Parameters<typeof registerTools>[0];

    registerTools(fakeApi, () => runtime);

    expect(tools.has("fold")).toBe(true);
    expect(tools.has("unfold")).toBe(true);
    expect(tools.has("fold_status")).toBe(true);
    expect(tools.has("fold_search")).toBe(true);
    expect(tools.has("fold_cache")).toBe(true);

    const emptyCtx = {} as Parameters<ToolDefinition["execute"]>[4];
    // 1. Test fold_status before fold
    const statusTool = tools.get("fold_status")!;
    const statusRes = await statusTool.execute("call-1", {}, new AbortController().signal, () => {}, emptyCtx);
    expect(statusRes.isError).toBeFalsy();
    const statusText = (statusRes.content[0] as { text: string }).text;
    expect(statusText).toContain("occupancy");
    expect(statusText).toContain("compressible");

    // 2. Test fold tool: fold turns 2..4 (m00002..m00004)
    const foldTool = tools.get("fold")!;
    const foldRes = await foldTool.execute(
      "call-2",
      {
        folds: [
          {
            range: "m00004..m00005",
            topic: "Database schema design for user auth",
            summary: "Designed users and sessions tables with foreign keys and expiration.",
          },
        ],
        tier: 1,
      },
      new AbortController().signal,
      () => {},
      emptyCtx,
    );
    expect(foldRes.isError).toBeFalsy();
    const foldText = (foldRes.content[0] as { text: string }).text;
    expect(foldText).toContain("b1");
    expect(foldText).toContain("Database schema design for user auth");

    // Verify DB insert happened
    const blocksInDb = db.blocksForSession("smoke-session-1");
    expect(blocksInDb.length).toBe(1);
    expect(blocksInDb[0]!.block_id).toBe("b1");
    expect(blocksInDb[0]!.topic).toBe("Database schema design for user auth");

    // 3. Test fold_search tool
    const searchTool = tools.get("fold_search")!;
    const searchRes = await searchTool.execute(
      "call-3",
      { query: "database schema" },
      new AbortController().signal,
      () => {},
      emptyCtx,
    );
    expect(searchRes.isError).toBeFalsy();
    const searchText = (searchRes.content[0] as { text: string }).text;
    expect(searchText).toContain("b1");
    expect(searchText).toContain("Database schema design");

    // Test tier prefix search
    const searchTierRes = await searchTool.execute(
      "call-4",
      { query: "tier:1 schema" },
      new AbortController().signal,
      () => {},
      emptyCtx,
    );
    expect(searchTierRes.isError).toBeFalsy();
    const searchTierText = (searchTierRes.content[0] as { text: string }).text;
    expect(searchTierText).toContain("b1");

    // 4. Test fold_cache tool
    runtime.engine.recordRound({
      ts: Date.now(),
      totalIn: 5000,
      cacheRead: 4000,
      cacheWrite: 1000,
      foldEventId: "b1",
      hostRewrite: false,
    });

    const cacheTool = tools.get("fold_cache")!;
    const cacheRes = await cacheTool.execute("call-5", {}, new AbortController().signal, () => {}, emptyCtx);
    expect(cacheRes.isError).toBeFalsy();
    const cacheText = (cacheRes.content[0] as { text: string }).text;
    expect(cacheText).toContain("5000");
    expect(cacheText).toContain("b1");

    // Cleanup
    db.close();
    try {
      unlinkSync(dbFile);
    } catch {
      // ignore cleanup
    }
  });
});
