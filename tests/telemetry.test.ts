import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/persist/db.ts";
import { evaluateStumble, recordToolTelemetry } from "../src/telemetry.ts";
import { OrigamiRuntime, type HostBinding } from "../src/runtime.ts";
import { registerTools } from "../src/tools/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "origami-telemetry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
function mockHost(sessionId = "test-session-tel"): HostBinding {
  return {
    sessionId: () => sessionId,
    appendEvent: () => {},
    saveArtifact: async () => "/tmp/art.md",
    windowTokens: () => 100_000,
    projectedTokens: () => 10_000,
    entries: () => [],
  };
}

describe("Telemetry & Stumble Detection", () => {
  test("evaluateStumble flags single errors and detects frustration loops on consecutive errors", () => {
    const sId = "session-err-loop-" + Date.now();
    const st1 = evaluateStumble(sId, "fold", false, "summary larger than source");
    expect(st1.stumble).toBe(true);
    expect(st1.stumbleReason).toContain("Tool error: summary larger than source");

    // Second consecutive error triggers frustration loop
    const st2 = evaluateStumble(sId, "fold", false, "overlapping range");
    expect(st2.stumble).toBe(true);
    expect(st2.stumbleReason).toContain("Repeated tool failure (2 consecutive errors)");

    // Success resets consecutive error counter
    const st3 = evaluateStumble(sId, "fold_status", true, null);
    expect(st3.stumble).toBe(false);
  });

  test("evaluateStumble flags zero-hit searches and consecutive search misses", () => {
    const sId = "session-search-miss-" + Date.now();
    const st1 = evaluateStumble(sId, "fold_search", true, null, {
      query: "quantum-superposition",
      blockHits: 0,
      messageHits: 0,
    });
    expect(st1.stumble).toBe(true);
    expect(st1.stumbleReason).toContain("Search returned 0 hits (vocabulary mismatch)");

    // Second consecutive miss triggers frustration loop
    const st2 = evaluateStumble(sId, "fold_search", true, null, {
      query: "quantum-entanglement",
      blockHits: 0,
      messageHits: 0,
    });
    expect(st2.stumble).toBe(true);
    expect(st2.stumbleReason).toContain("Frustration loop: 2 consecutive searches returned 0 hits");

    // Repeating the query triggers repeated query warning
    const st3 = evaluateStumble(sId, "fold_search", true, null, {
      query: "quantum-entanglement",
      blockHits: 0,
      messageHits: 0,
    });
    expect(st3.stumble).toBe(true);
    expect(st3.stumbleReason).toContain("Repeated identical search query");
  });

  test("evaluateStumble flags missing refs in fold_recall", () => {
    const sId = "session-recall-miss-" + Date.now();
    const st = evaluateStumble(sId, "fold_recall", true, null, {
      missingRefs: 3,
    });
    expect(st.stumble).toBe(true);
    expect(st.stumbleReason).toContain("Recall missing 3 requested ref(s)");
  });

  test("recordToolTelemetry persists to SQLite and aggregates summary", () => {
    const dir = tempDir();
    const dbPath = join(dir, "origami.db");
    const db = openDb(dbPath);

    const rt = new OrigamiRuntime({
      host: mockHost("session-db-test"),
      modelId: "gpt-4o",
    });
    rt.attachDb(db);

    recordToolTelemetry(rt, {
      tool: "fold_status",
      durationMs: 15,
      ok: true,
      inputSummary: "status check",
      outputSummary: "10% occupancy",
      metrics: { occupancy: 10 },
    });

    recordToolTelemetry(rt, {
      tool: "fold_search",
      durationMs: 45,
      ok: true,
      inputSummary: '"auth token"',
      outputSummary: "0 hits",
      metrics: { query: "auth token", blockHits: 0, messageHits: 0 },
    });

    recordToolTelemetry(rt, {
      tool: "fold",
      durationMs: 120,
      ok: false,
      error: "summary too large",
      inputSummary: "1 range",
      outputSummary: "rejected",
    });

    const calls = db.toolCallsForSession("session-db-test");
    expect(calls.length).toBe(3);
    expect(calls[0]!.tool).toBe("fold"); // latest first
    expect(calls[0]!.ok).toBe(0);
    expect(calls[0]!.error).toBe("summary too large");

    const summary = db.toolTelemetrySummary("session-db-test");
    expect(summary.totalCalls).toBe(3);
    expect(summary.errorCount).toBe(1);
    expect(summary.stumbleCount).toBe(2); // search miss + fold error
    expect(summary.byTool.fold_status?.calls).toBe(1);
    expect(summary.byTool.fold_search?.calls).toBe(1);
    expect(summary.byTool.fold?.calls).toBe(1);
    expect(summary.recentStumbles.length).toBe(2);

    db.close();
  });

  test("all 6 tools record telemetry through execute()", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "origami.db");
    const db = openDb(dbPath);

    const rt = new OrigamiRuntime({
      host: mockHost("session-e2e-tools"),
      modelId: "gpt-4o",
    });
    rt.attachDb(db);

    const pass = (v: unknown) => v;
    const registeredTools = new Map<
      string,
      { execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown> }
    >();
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
      registerTool(def: {
        name: string;
        execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>;
      }) {
        registeredTools.set(def.name, def);
      },
    };

    const mutations: Array<{ event: string; payload: unknown }> = [];
    try {
      registerTools(fakeApi as never, () => rt, (event, payload) => {
        mutations.push({ event, payload });
      });

      expect(registeredTools.size).toBe(6);

      // 1. fold_status
      const statusTool = registeredTools.get("fold_status")!;
      await statusTool.execute("c1", {}, null, null, null);

      // 2. fold_cache
      const cacheTool = registeredTools.get("fold_cache")!;
      await cacheTool.execute("c2", {}, null, null, null);

      // 3. fold_search
      const searchTool = registeredTools.get("fold_search")!;
      await searchTool.execute("c3", { query: "test-query", limit: 5 }, null, null, null);

      // 4. fold_recall (with empty/missing refs)
      const recallTool = registeredTools.get("fold_recall")!;
      await recallTool.execute("c4", { refs: "m00001" }, null, null, null);

      // Check that telemetry mutations were dispatched
      const telemetryMutations = mutations.filter((m) => m.event === "telemetry");
      expect(telemetryMutations.length).toBe(4);

      const calls = db.toolCallsForSession("session-e2e-tools");
      expect(calls.length).toBe(4);
      const toolsCalled = calls.map((c) => c.tool);
      expect(toolsCalled).toContain("fold_status");
      expect(toolsCalled).toContain("fold_cache");
      expect(toolsCalled).toContain("fold_search");
      expect(toolsCalled).toContain("fold_recall");
    } finally {
      db.close();
    }
  });
});
