import { describe, expect, test } from "bun:test";
import { extractPlanTerms, planTokenize, rerankHitsWithPlan, scoreBlockPlanOverlap } from "../src/kernel/plan-search.ts";
import type { BoundMessage } from "../src/kernel/types.ts";
import { openDb } from "../src/persist/db.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Plan-Aware Search Re-ranking (#5047)", () => {
  test("planTokenize extracts signal words and removes stopwords and short tokens", () => {
    const tokens = planTokenize("The quick brown fox jumps over the lazy task todo and updates authentication");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
    expect(tokens).toContain("jumps");
    expect(tokens).toContain("lazy");
    expect(tokens).toContain("authentication");

    // Stopwords and short tokens removed
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("over");
    expect(tokens).not.toContain("task");
    expect(tokens).not.toContain("todo");
  });

  test("extractPlanTerms extracts weighted terms from planning tool calls and latest user text", () => {
    const bound: BoundMessage[] = [
      {
        index: 0,
        ref: "m00001",
        role: "user",
        text: "We need to fix the database telemetry regression and audit SQLite indexes",
        bytes: 80,
        turn: 1,
        ephemeral: false,
        contentHash: "h1",
        signedThinking: false,
      },
      {
        index: 1,
        ref: "m00002",
        role: "assistant",
        text: "Updating todos for SQLite telemetry audit",
        bytes: 40,
        turn: 1,
        ephemeral: false,
        contentHash: "h2",
        signedThinking: false,
        toolCalls: [{ id: "call_todo_1", name: "todo" }],
      },
      {
        index: 2,
        ref: "m00003",
        role: "toolResult",
        toolCallId: "call_todo_1",
        text: "Added tasks: SQLite telemetry audit and index optimization",
        bytes: 60,
        turn: 1,
        ephemeral: false,
        contentHash: "h3",
        signedThinking: false,
      },
    ];

    const terms = extractPlanTerms(bound);
    expect(terms).toBeDefined();
    expect(terms).not.toBeNull();

    // "telemetry" and "sqlite" appear in both user text (w=1) and planning tool/result (w=2)
    expect(terms!.get("telemetry")).toBeGreaterThanOrEqual(3);
    expect(terms!.get("sqlite")).toBeGreaterThanOrEqual(3);
    expect(terms!.get("regression")).toBeGreaterThanOrEqual(1);
  });

  test("scoreBlockPlanOverlap computes weighted match counts", () => {
    const terms = new Map<string, number>([
      ["telemetry", 2],
      ["sqlite", 2],
      ["audit", 1],
    ]);

    const scoreMatch = scoreBlockPlanOverlap(
      "SQLite Telemetry Audit",
      "Persisted tool execution latency and stumble detection to SQLite",
      terms,
    );
    // Topic has sqlite (2) + telemetry (2) + audit (1) = 5
    // Summary has sqlite (2) = 2
    // Total = 7
    expect(scoreMatch).toBe(7);

    const scoreNoMatch = scoreBlockPlanOverlap(
      "CSS Variable Theme Harmonization",
      "Updated colors to match oh-my-pi obsidian palette",
      terms,
    );
    expect(scoreNoMatch).toBe(0);
  });

  test("rerankHitsWithPlan boosts plan-matching candidates above non-matching candidates", () => {
    const terms = new Map<string, number>([
      ["telemetry", 2],
      ["sqlite", 2],
    ]);

    const hits = [
      {
        blockId: "b1",
        topic: "CSS Styling and Obsidian Colors",
        snippet: "Theme colors for dashboard",
        status: "active",
        rank: -2.5, // Better BM25 rank initially
      },
      {
        blockId: "b2",
        topic: "Database Migration and Telemetry Persistence",
        snippet: "SQLite telemetry table schema",
        status: "active",
        rank: -1.0, // Weaker BM25 rank initially
      },
    ];

    const reranked = rerankHitsWithPlan(hits, terms);
    // b2 has planScore > 0, so it gets re-ranked to index 0 ahead of b1!
    expect(reranked[0]!.blockId).toBe("b2");
    expect(reranked[0]!.planScore).toBeGreaterThan(0);
    expect(reranked[1]!.blockId).toBe("b1");
    expect(reranked[1]!.planScore).toBe(0);
  });

  test("rerankHitsWithPlan retains active blocks ahead of consumed blocks regardless of plan score", () => {
    const terms = new Map<string, number>([["telemetry", 2]]);

    const hits = [
      {
        blockId: "b_old",
        topic: "Old Telemetry System",
        snippet: "telemetry",
        status: "consumed",
        rank: -5.0,
      },
      {
        blockId: "b_live",
        topic: "General Frontend Architecture",
        snippet: "architecture notes",
        status: "active",
        rank: -1.0,
      },
    ];

    const reranked = rerankHitsWithPlan(hits, terms);
    // Active block b_live must remain ahead of consumed block b_old
    expect(reranked[0]!.blockId).toBe("b_live");
    expect(reranked[1]!.blockId).toBe("b_old");
  });

  test("OrigamiEngine.search applies plan-aware re-ranking end-to-end", () => {
    const dir = mkdtempSync(join(tmpdir(), "origami-plan-engine-"));
    const db = openDb(join(dir, "origami.db"));
    const sessionId = "sess-plan-e2e";

    // Seed SQLite with 2 blocks matching the word "system"
    db.persistFoldBatch({
      blocks: [
        {
          block_id: "b1",
          session_id: sessionId,
          tier: 1,
          topic: "Authentication System and OAuth",
          summary: "OAuth system details.",
          body: "OAuth system details.",
          ranges: "[]",
          children: "[]",
          tokens_before: 2000,
          tokens_after: 100,
          created_at: 1000,
          status: "active",
          consumed_by: null,
        },
        {
          block_id: "b2",
          session_id: sessionId,
          tier: 1,
          topic: "Telemetry Logging System",
          summary: "SQLite telemetry metrics.",
          body: "SQLite telemetry metrics.",
          ranges: "[]",
          children: "[]",
          tokens_before: 2000,
          tokens_after: 100,
          created_at: 2000,
          status: "active",
          consumed_by: null,
        },
      ],
      messages: [],
      statuses: [],
    });

    // Create an engine where user instruction mentions telemetry
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => sessionId,
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/art.md",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries: [
        {
          type: "message",
          message: {
            role: "user",
            content: "Please investigate the telemetry logging metrics and failures",
          },
        },
      ],
      modelId: "gpt-4",
    });

    engine.attachDb(db);
    engine.ingest([
      {
        role: "user",
        text: "Please investigate the telemetry logging metrics and failures",
        bytes: 60,
        contentHash: "h1",
        signedThinking: false,
      },
    ]);

    // Search for common word "system"
    const results = engine.search("system", 10);
    expect(results.length).toBe(2);
    // b2 (Telemetry Logging System) overlaps with active plan terms ("telemetry") and is ranked first!
    expect(results[0]!.blockId).toBe("b2");
    expect(results[1]!.blockId).toBe("b1");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
