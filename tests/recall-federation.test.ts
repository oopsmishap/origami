import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { openDb } from "../src/persist/db.ts";
import { configFromPreset } from "../src/config.ts";
import { OrigamiRuntime, type HostBinding } from "../src/runtime.ts";
import { extractRecallQuery, formatRecallFederationNotice, handleRecallToolResult } from "../src/federation/recall-hook.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "origami-recall-test-"));
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

function mockHost(sessionId = "sess-alpha"): HostBinding {
  return {
    sessionId: () => sessionId,
    appendEvent: () => {},
    saveArtifact: async () => "/tmp/art.md",
    windowTokens: () => 100_000,
    projectedTokens: () => 10_000,
    entries: () => [],
  };
}

describe("Recall Federation Hook", () => {
  test("extractRecallQuery extracts queries from direct tool calls and xd:// writes", () => {
    expect(extractRecallQuery("recall", { query: "search terms" })).toBe("search terms");
    expect(extractRecallQuery("recall", { text: "text prompt" })).toBe("text prompt");
    expect(extractRecallQuery("xd://recall", { query: "device query" })).toBe("device query");
    expect(extractRecallQuery("write", { path: "xd://recall", content: JSON.stringify({ query: "json query" }) })).toBe("json query");
    expect(extractRecallQuery("write", { path: "xd://recall", content: "raw string query" })).toBe("raw string query");

    // Unrelated tools / paths return null
    expect(extractRecallQuery("bash", { command: "git status" })).toBeNull();
    expect(extractRecallQuery("write", { path: "src/main.ts", content: "code" })).toBeNull();
    expect(extractRecallQuery("fold_search", { query: "terms" })).toBeNull();
  });

  test("handleRecallToolResult augments recall output with matching in-session blocks", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "origami.db"));
    const sessionId = "sess-alpha";
    const rt = new OrigamiRuntime({
      config: {
        ...configFromPreset("balanced"),
        growthStep: 10_000,
        compressibleFloor: 5_000,
        emergencyFillPct: 0.9,
        tier2MassTokens: 20_000,
        tier3MassTokens: 40_000,
        minFoldBenefitTokens: 1_000,
      },
      modelId: "gpt-4",
      host: mockHost(sessionId),
    });
    rt.attachDb(db);

    // Populate active session with a fold block and an archived message
    db.persistFoldBatch({
      blocks: [
        {
          block_id: "b1",
          session_id: sessionId,
          tier: 1,
          topic: "Authentication and OAuth Token Refresh",
          summary: "Implemented refresh token rotation and bearer auth headers.",
          body: "Implemented refresh token rotation and bearer auth headers.",
          ranges: JSON.stringify([{ start: "m00001", end: "m00010" }]),
          children: "[]",
          tokens_before: 5000,
          tokens_after: 200,
          created_at: 1000,
          status: "active",
          consumed_by: null,
        },
      ],
      messages: [
        {
          session_id: sessionId,
          ref: "m00005",
          turn: 2,
          tokens: 50,
          role: "assistant",
          text: "OAuth refresh endpoint returns 401 when token expired",
          captured_at: 1000,
        },
      ],
      statuses: [
        {
          block_id: "b1",
          session_id: sessionId,
          status: "active",
          consumed_by: null,
        },
      ],
    });

    // Populate another session with unrelated content that also matches the word OAuth
    db.persistFoldBatch({
      blocks: [
        {
          block_id: "b99",
          session_id: "sess-other",
          tier: 1,
          topic: "Other session OAuth work",
          summary: "OAuth details from last week.",
          body: "OAuth details from last week.",
          ranges: JSON.stringify([{ start: "m00001", end: "m00005" }]),
          children: "[]",
          tokens_before: 1000,
          tokens_after: 100,
          created_at: 500,
          status: "active",
          consumed_by: null,
        },
      ],
      messages: [],
      statuses: [
        {
          block_id: "b99",
          session_id: "sess-other",
          status: "active",
          consumed_by: null,
        },
      ],
    });

    const event: ToolResultEvent = {
      type: "tool_result",
      toolName: "recall",
      toolCallId: "call_123",
      input: { query: "OAuth token refresh" },
      content: [{ type: "text", text: "Found 1 cross-session memory in mnemopi" }],
      isError: false,
      details: { memoryCount: 1 },
    };

    const result = handleRecallToolResult(event, sessionId, rt);
    expect(result).toBeDefined();
    expect(result?.content).toBeDefined();

    const outputText = (result?.content?.[0] as { type: "text"; text: string }).text;
    expect(outputText).toContain("Found 1 cross-session memory in mnemopi");
    expect(outputText).toContain("[Origami In-Session History · sess-alpha]");
    expect(outputText).toContain("Fold Block b1 (tier 1)");
    expect(outputText).toContain("Authentication and OAuth Token Refresh");
    expect(outputText).toContain("Matching original message refs: m00005");
    // Must NOT leak other sessions into in-session notice
    expect(outputText).not.toContain("b99");
    expect(outputText).not.toContain("sess-other");

    db.close();
  });

  test("handleRecallToolResult returns void when no matches exist in this session", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "origami.db"));
    const sessionId = "sess-empty";
    const rt = new OrigamiRuntime({
      config: {
        ...configFromPreset("balanced"),
        growthStep: 10_000,
        compressibleFloor: 5_000,
        emergencyFillPct: 0.9,
        tier2MassTokens: 20_000,
        tier3MassTokens: 40_000,
        minFoldBenefitTokens: 1_000,
      },
      modelId: "gpt-4",
      host: mockHost(sessionId),
    });
    rt.attachDb(db);

    const event: ToolResultEvent = {
      type: "tool_result",
      toolName: "recall",
      toolCallId: "call_456",
      input: { query: "nonexistent keyword xyz123" },
      content: [{ type: "text", text: "no memories found" }],
      isError: false,
      details: undefined,
    };

    const result = handleRecallToolResult(event, sessionId, rt);
    expect(result).toBeUndefined();

    db.close();
  });

  test("handleRecallToolResult intercepts write to xd://recall and preserves error status", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "origami.db"));
    const sessionId = "sess-beta";
    const rt = new OrigamiRuntime({
      config: {
        ...configFromPreset("balanced"),
        growthStep: 10_000,
        compressibleFloor: 5_000,
        emergencyFillPct: 0.9,
        tier2MassTokens: 20_000,
        tier3MassTokens: 40_000,
        minFoldBenefitTokens: 1_000,
      },
      modelId: "gpt-4",
      host: mockHost(sessionId),
    });
    rt.attachDb(db);

    db.persistFoldBatch({
      blocks: [
        {
          block_id: "b2",
          session_id: sessionId,
          tier: 1,
          topic: "Database Migration 4",
          summary: "Added tool_telemetry table for stumble detection.",
          body: "Added tool_telemetry table for stumble detection.",
          ranges: JSON.stringify([{ start: "m00020", end: "m00030" }]),
          children: "[]",
          tokens_before: 3000,
          tokens_after: 150,
          created_at: 2000,
          status: "active",
          consumed_by: null,
        },
      ],
      messages: [],
      statuses: [
        {
          block_id: "b2",
          session_id: sessionId,
          status: "active",
          consumed_by: null,
        },
      ],
    });

    const event: ToolResultEvent = {
      type: "tool_result",
      toolName: "write",
      toolCallId: "call_789",
      input: { path: "xd://recall", content: JSON.stringify({ query: "migration stumble telemetry" }) },
      content: [{ type: "text", text: "Mnemopi device connection timed out" }],
      isError: true,
      details: { code: "TIMEOUT" },
    };

    const result = handleRecallToolResult(event, sessionId, rt);
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);
    expect(result?.details).toEqual({ code: "TIMEOUT" });

    const outputText = (result?.content?.[0] as { type: "text"; text: string }).text;
    expect(outputText).toContain("Mnemopi device connection timed out");
    expect(outputText).toContain("[Origami In-Session History · sess-beta]");
    expect(outputText).toContain("b2");
    expect(outputText).toContain("Database Migration 4");

    db.close();
  });
});
