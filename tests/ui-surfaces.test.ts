import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ExtensionAPI, RegisteredCommand } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { TspChartProps } from "@oh-my-pi/pi-wire";
import origamiExtension from "../src/index.ts";
import { configFromPreset } from "../src/config.ts";
import { openDb } from "../src/persist/db.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import { OrigamiRuntime } from "../src/runtime.ts";
import { SessionRegistry } from "../src/sessions.ts";
import { OrigamiFoldMessageComponent } from "../src/tools/display.ts";
import { registerTools } from "../src/tools/index.ts";
import { startDashboardServer } from "../src/ui/dashboard-server.ts";
import {
  buildTrajectoryData,
  classifyLineCauses,
  describeNativeTrajectory,
  renderAnsiTrajectory,
  renderHitRateSvg,
  renderTrajectorySvg,
} from "../src/ui/trajectory.ts";
import { buildWorkbenchModel } from "../src/ui/workbench-model.ts";
import { WorkbenchComponent } from "../src/ui/workbench.ts";


initThemeSync();
const nativeCx: DescribeContext = {
  cols: 120,
  reduceMotion: false,
  dark: true,
  supports: () => true,
  feature: () => true,
};

describe("Occupancy telemetry & /api/status regression", () => {
  it("reports 0..100 occupancyPct and projected usedTokens instead of raw bound message subset", async () => {
    const dbFile = `/tmp/origami-occ-${Date.now()}.db`;
    const db = openDb(dbFile);
    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "m0", message: { role: "system", content: "sys" } },
      { type: "message", id: "m1", message: { role: "user", content: "x".repeat(237) } },
    ];

    // Reproduces the exact scenario where projectedTokens is ~90K on a 1.0M window
    // while journal message bytes are only 237 tokens.
    const runtime = new OrigamiRuntime({
      host: {
        sessionId: () => "occ-session",
        appendEvent: (op) => journal.push(op),
        saveArtifact: async () => "/tmp/art.md",
        windowTokens: () => 1_000_000,
        projectedTokens: () => 90_000,
        entries: () => entries,
      },
      modelId: "test-model",
      config: configFromPreset("balanced"),
      countFn: (t) => t.length,
    });
    runtime.attachDb(db);
    runtime.sync();

    const st = runtime.engine.status();
    expect(st.occupancyPct).toBe(9);
    expect(st.usedTokens).toBe(90_000);
    expect(st.windowTokens).toBe(1_000_000);
    expect(st.tokenSplit.conversation).toBe(241);
    expect(st.tokenSplit.overhead + st.tokenSplit.system + st.tokenSplit.live + st.tokenSplit.summaries).toBe(90_000);

    const registry = new SessionRegistry();
    registry.register({
      sessionId: "occ-session",
      agent: { kind: "main", id: "Main", name: "main", depth: 0, parentId: null },
      runtime,
      config: configFromPreset("balanced"),
      ctx: null,
    });
    const dashboard = await startDashboardServer({
      port: 3910,
      registry,
      openBrowser: false,
    });

    try {
      const apiUrl = new URL("/api/status", dashboard.url);
      const res = await fetch(apiUrl, {
        headers: { Host: `127.0.0.1:${dashboard.port}`, "X-Origami-Token": dashboard.token },
      });
      const body = (await res.json()) as {
        occupancyPct: number;
        liveTokens: number;
        usedTokens: number;
        windowTokens: number;
      };
      expect(body.occupancyPct).toBe(9);
      expect(body.liveTokens).toBe(90_000);
      expect(body.usedTokens).toBe(90_000);
      expect(body.windowTokens).toBe(1_000_000);

      const html = await (await fetch(`${dashboard.url}/`)).text();
      // Ensure client never multiplies occupancyPct by 100 again
      expect(html).not.toContain("st.occupancyPct * 100");
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

describe("billion-context Trajectory & Cache Hit Rate", () => {
  const baseTs = 1_760_000_000_000;
  const sampleRounds = [
    { ts: baseTs, totalIn: 50_000, cacheRead: 0, cacheWrite: 50_000, foldEventId: null },
    { ts: baseTs + 10_000, totalIn: 62_000, cacheRead: 49_500, cacheWrite: 12_500, foldEventId: null },
    { ts: baseTs + 20_000, totalIn: 78_000, cacheRead: 61_500, cacheWrite: 16_500, foldEventId: null },
    // Fold happens here: input drops from 78K -> 42K, cache rebuilds
    { ts: baseTs + 30_000, totalIn: 42_000, cacheRead: 18_000, cacheWrite: 24_000, foldEventId: "b1" },
    { ts: baseTs + 40_000, totalIn: 48_000, cacheRead: 25_000, cacheWrite: 23_000, foldEventId: null },
    { ts: baseTs + 50_000, totalIn: 55_000, cacheRead: 49_500, cacheWrite: 5_500, foldEventId: null },
    // 15 minute idle TTL gap
    { ts: baseTs + 980_000, totalIn: 60_000, cacheRead: 12_000, cacheWrite: 48_000, foldEventId: null },
  ];

  const sampleBlocks = [
    {
      id: "b1",
      tier: 1,
      coverage: "m00002..m00018",
      tokens: 40_000,
      tokensBefore: 40_000,
      tokensAfter: 1_200,
      reclaimed: 38_800,
      topic: "Auth session refactor",
      summary: "Refactored token validation.",
      children: [],
      status: "active" as const,
      consumedBy: null,
      survivedFolds: 0,
      generation: "young" as const,
      createdAt: baseTs + 28_000,
    },
  ];

  it("classifies cold start, post-fold rebuild continuation, warm recovery, and TTL expiry", () => {
    const data = buildTrajectoryData({
      rounds: sampleRounds,
      blocks: sampleBlocks,
      windowTokens: 200_000,
      baselineTokens: 14_000,
    });

    const causes = classifyLineCauses(data.lines, data.folds);
    expect(causes[0]).toBe("cold");
    expect(causes[1]).toBe("new");
    expect(causes[3]).toBe("comp"); // fold opener
    expect(causes[4]).toBe("comp"); // cold continuation tail (<85% hit)
    expect(causes[5]).toBe("new");  // warm (>=85% hit) closes tail
    expect(causes[6]).toBe("rest"); // >10m gap with cache miss
  });

  it("renders full and zoomed SVG charts, ANSI multi-row chart, and Tern TSP chart nodes", () => {
    const data = buildTrajectoryData({
      rounds: sampleRounds,
      blocks: sampleBlocks,
      windowTokens: 200_000,
      baselineTokens: 14_000,
    });

    const trajSvg = renderTrajectorySvg(data);
    expect(trajSvg).toContain('<svg viewBox="0 0 960 260"');
    expect(trajSvg).toContain("context window 200.0K");
    expect(trajSvg).toContain("baseline (sys+tools) 14.0K");
    expect(trajSvg).toContain("post-fold rebuild");
    expect(trajSvg).toContain("fold b1");

    const zoomedSvg = renderTrajectorySvg(data, [2, 5]);
    expect(zoomedSvg).toContain("#3 ·");
    expect(zoomedSvg).not.toContain("#1 ·");

    const hitSvg = renderHitRateSvg(data);
    expect(hitSvg).toContain('<svg viewBox="0 0 960 260"');
    expect(hitSvg).toContain("100%");

    const ansi = renderAnsiTrajectory(data, 96, 8);
    expect(ansi.length).toBeGreaterThanOrEqual(11);
    expect(ansi.join("\n")).toContain("Context Trajectory");
    expect(ansi.join("\n")).toContain("b1(-38.8K)");

    const native = describeNativeTrajectory(data);
    expect(native[0]?.k).toBe("chart");
    expect((native[0]?.p as TspChartProps | undefined)?.kind).toBe("bars");
    expect(native[1]?.k).toBe("chart");
    expect((native[1]?.p as TspChartProps | undefined)?.kind).toBe("bars");
    expect(native[2]?.k).toBe("table");

    // Ensure large trajectory (e.g. 268 rounds from long sessions) uses responsive spark charts
    const bigData = {
      ...data,
      lines: Array.from({ length: 268 }, (_, i) => ({
        seq: i + 1,
        at: Date.now() - (268 - i) * 7000,
        input: 100_000 + i * 500,
        cached: 90_000 + i * 490,
        cacheWrite: 0,
        missed: 10_000 + i * 10,
        hitPct: 90 + (i % 10),
        foldEventId: null,
        cause: "new" as const,
      })),
    };
    const bigNative = describeNativeTrajectory(bigData);
    const trajChart = bigNative[0]?.p as TspChartProps | undefined;
    const hitChart = bigNative[1]?.p as TspChartProps | undefined;
    expect(trajChart?.kind).toBe("bars");
    expect(hitChart?.kind).toBe("bars");
    // Time-bounded to most recent rounds (default 50) so it never overflows the overlay card
    expect(trajChart?.series?.length).toBe(50);
    expect(hitChart?.series?.length).toBe(50);
    // Height scales to recent peak for granularity (not squashed by windowTokens ceiling)
    expect(trajChart?.max).toBeLessThan(300_000);
    expect(trajChart?.max).toBeGreaterThan(200_000);

    // Custom bar limit respected
    const narrowNative = describeNativeTrajectory(bigData, 35);
    const narrowTraj = narrowNative[0]?.p as TspChartProps | undefined;
    expect(narrowTraj?.series?.length).toBe(35);
  });
});

describe("First-party Transcript Banner, Inline Tools & Workbench", () => {
  it("renders origami:fold as an omp.compaction section in Tern and horizontal divider in ANSI", () => {
    const comp = new OrigamiFoldMessageComponent(
      "[#m00002] [Compressed conversation section] — Auth & session tokens\n### Decisions\n- Used Ed25519 keys",
      {
        blockId: "b1",
        tier: 1,
        topic: "Auth & session tokens",
        coverage: "m00002..m00018",
        tokensBefore: 24_000,
        tokensAfter: 850,
      },
    );

    const collapsedLines = comp.render(100);
    expect(collapsedLines.join("\n")).toContain("b1 (T1)");
    expect(collapsedLines.join("\n")).toContain("24.0K");

    const nodeCollapsed = comp.describe();
    expect(nodeCollapsed.k).toBe("section");
    if (nodeCollapsed.k === "section") {
      expect(nodeCollapsed.p?.role).toBe("omp.compaction");
      expect(nodeCollapsed.p?.collapsed).toBe(true);
    }

    comp.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
    const nodeExpanded = comp.describe();
    if (nodeExpanded.k === "section") {
      expect(nodeExpanded.p?.collapsed).toBe(false);
    }
    const expandedLines = comp.render(100);
    expect(expandedLines.join("\n")).toContain("Ed25519");
    comp.dispose();
  });

  it("advertises /fold subcommands, including before any argument is typed", () => {
    const commands = new Map<string, RegisteredCommand>();
    const fakeApi = {
      typebox: {
        Type: {
          Object: (value: unknown) => value,
          Array: (value: unknown) => value,
          String: (value: unknown) => value,
          Optional: (value: unknown) => value,
          Union: (value: unknown) => value,
          Literal: (value: unknown) => value,
          Integer: (value: unknown) => value,
          Boolean: (value: unknown) => value,
        },
      },
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
      registerShortcut: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;

    origamiExtension(fakeApi);
    const complete = commands.get("fold")?.getArgumentCompletions;
    expect(complete?.("")?.map((item) => item.value)).toEqual(["trajectory", "blocks", "zones", "web", "export"]);
    expect(complete?.("bl")?.map((item) => item.value)).toEqual(["blocks"]);
    expect(complete?.("blocks ")).toBeNull();
  });

  it("marks all 5 tools as inline + mergeCallAndResult with both describeCall and describeResult", () => {
    const tools = new Map<string, ToolDefinition & { inline?: boolean; mergeCallAndResult?: boolean }>();
    const pass = <T>(v: T) => v;
    const fakeApi = {
      typebox: {
        Type: { Object: pass, Array: pass, String: pass, Optional: pass, Union: pass, Literal: pass, Integer: pass, Boolean: pass },
      },
      registerTool: (t: ToolDefinition) => tools.set(t.name, t),
    } as unknown as Parameters<typeof registerTools>[0];

    registerTools(fakeApi, () => {
      throw new Error("not executed");
    });

    for (const name of ["fold", "unfold", "fold_recall", "fold_search", "fold_status", "fold_cache"]) {
      const tool = tools.get(name)!;
      expect(tool).toBeDefined();
      expect(tool.inline).toBe(true);
      expect(tool.mergeCallAndResult).toBe(true);
      expect(typeof tool.describeCall).toBe("function");
      expect(typeof tool.describeResult).toBe("function");
      const callView = tool.describeCall!({} as never, { expanded: false, isPartial: false });
      expect(callView?.inline).toBe(true);
    }
  });

  it("supports Trajectory tab, in-overlay block drilldown, and live unfold in ANSI & Tern Workbench", async () => {
    let unfoldedCalls: Array<{ id: string; mode?: string }> = [];
    const block = {
      id: "b1",
      tier: 1,
      coverage: "m00002..m00010",
      tokens: 18_000,
      tokensBefore: 18_000,
      tokensAfter: 600,
      reclaimed: 17_400,
      topic: "Query planner optimization",
      summary: "### Summary\n- Eliminated N+1 joins",
      children: [],
      status: "active" as const,
      consumedBy: null,
      survivedFolds: 0,
      generation: "young" as const,
      createdAt: Date.now() - 5000,
    };

    const report = {
      occupancyPct: 14,
      windowTokens: 200_000,
      usedTokens: 28_000,
      projectedTokens: 28_000,
      tokenSplit: {
        overhead: 12_000,
        system: 1_000,
        conversation: 10_400,
        tools: 4_000,
        summaries: 600,
        live: 14_400,
        foldedSavings: 17_400,
      },
      growthSinceFold: 9_200,
      growthStep: 50_000,
      compressibleTokens: 8_000,
      compressibleFloor: 15_000,
      blocks: [block],
      zones: [
        { kind: "protected", start: "m00001", end: "m00001", tokens: 1_000, messages: 1 },
        { kind: "folded", start: "m00002", end: "m00010", tokens: 600, messages: 9 },
        { kind: "compressible", start: "m00011", end: "m00016", tokens: 13_400, messages: 6 },
      ],
      folded: 9,
      live: 7,
      nudgeKind: "none",
      protectedFromTurn: 3,
      invariantViolations: [],
    };

    const rounds = [
      { ts: Date.now() - 10_000, totalIn: 42_000, cacheRead: 36_000, cacheWrite: 6_000, foldEventId: null },
      { ts: Date.now() - 4_000, totalIn: 28_000, cacheRead: 16_000, cacheWrite: 12_000, foldEventId: "b1" },
    ];

    const model = buildWorkbenchModel(report, rounds, 200_000);
    let renderRequests = 0;
    const unfoldSettled = Promise.withResolvers<void>();
    let closeOutcomes = 0;
    const wb = new WorkbenchComponent({
      model,
      actions: {
        model: () => model,
        refresh: () => buildWorkbenchModel({ ...report, blocks: [{ ...block, status: "unfolded" as const }] }, rounds, 200_000),
        previewFold: () => ["m00011..m00016 (13.4K)"],
        unfoldSelected: async (id, mode) => {
          unfoldedCalls.push({ id, mode });
          return `Unfolded ${id} (${mode})`;
        },
        drill: (id) => [`${id}`],
      },
      tui: {
        requestRender: () => {
          renderRequests++;
          if (unfoldedCalls.length > 0 && model.statusMessage) unfoldSettled.resolve();
        },
      } as never,
      onOutcome: (outcome) => {
        if (outcome.close) closeOutcomes++;
      },
    });

    // Overview render & native describe
    expect(wb.render(100).join("\n")).toContain("System & Tool Schemas");
    const rootOverview = wb.describe(nativeCx);
    expect(rootOverview?.k).toBe("card");

    // Switch to Trajectory tab via Tern native tab select
    wb.handleNativeEvent({ type: "select", key: "tabs", item: "trajectory" });
    expect(model.tab).toBe(1);
    expect(wb.render(100).join("\n")).toContain("Context Trajectory");
    const rootTraj = wb.describe(nativeCx);
    expect(JSON.stringify(rootTraj)).toContain('"k":"chart"');

    // Switch to Blocks tab and press Enter -> opens in-overlay drilldown (NOT close/toast)
    wb.handleInput("3");
    expect(model.tab).toBe(2);
    wb.handleInput("\r");
    expect(model.drillBlockId).toBe("b1");
    expect(wb.render(100).join("\n")).toContain("Eliminated N+1 joins");

    // Press 'u' inside drilldown -> actually invokes unfoldSelected("b1", "file") and refreshes model
    wb.handleInput("u");
    await unfoldSettled.promise;
    expect(unfoldedCalls).toEqual([{ id: "b1", mode: "file" }]);
    expect(model.statusMessage).toContain("Unfolded b1");
    expect(renderRequests).toBeGreaterThan(0);

    // Esc exits drilldown back to Blocks list without closing the overlay
    wb.handleInput("\x1b");
    expect(model.drillBlockId).toBeNull();

    // Kitty keyboard protocol Escape closes the popup in Tern as well as legacy ANSI Escape.
    wb.handleInput("\x1b[27u");
    expect(closeOutcomes).toBe(1);
    expect(theme).toBeDefined();
    wb.dispose();
  });
});
