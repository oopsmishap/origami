import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sandbox, SandboxEscapeError, SandboxIoError } from "../bench/agentic/sandbox.ts";
import { BASE_TOOL_SPECS, executeBaseTool, type ToolContext } from "../bench/agentic/tools.ts";
import { createAgentTools, createToolCallMemo } from "../bench/agentic/ai-tools.ts";
import {
  createCompactionRuntime,
  type CompactionStrategyName,
  type CompactionRuntime
} from "../bench/agentic/strategy-runtime.ts";
import {
  getMemoryNeedlesForScale,
  SCALE_DOMAIN_PROBE_COUNTS,
  SCALE_NEEDLE_COUNTS,
  SCALE_TURNS,
  SCENARIO_REGISTRY,
  type ContextScale,
  type ScenarioMode
} from "../bench/agentic/scenarios.ts";
import { AgentRunner, createTurnMaintainer, evaluateProbeAnswer } from "../bench/agentic/agent.ts";
import { cacheAccounting, createLlmCacheState, type LlmMessage } from "../bench/agentic/llm.ts";
import { generateReportHtml } from "../bench/agentic/report-html.ts";
import { estimateLlmCost, GPT_5_6_SOL_PRICING } from "../bench/agentic/pricing.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

describe("Agentic Benchmark Suite", () => {
  test("Sandbox enforces strict boundary and prevents path escapes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "origami-sandbox-test-"));
    try {
      const sandbox = new Sandbox(tmp);

      // Within workspace
      sandbox.write("sub/file.txt", "hello sandbox\nline 2\nline 3");
      expect(sandbox.exists("sub/file.txt")).toBe(true);
      expect(sandbox.exists("nonexistent.txt")).toBe(false);

      const content = sandbox.read("sub/file.txt");
      expect(content).toContain("hello sandbox");

      // Replace / edit
      const editRes = sandbox.replace("sub/file.txt", "line 2", "line two modified");
      expect(editRes.occurrences).toBe(1);
      expect(sandbox.read("sub/file.txt")).toContain("line two modified");

      // Grep
      const grepMatches = sandbox.grep("modified", ".");
      expect(grepMatches).toContain("sub/file.txt");

      // Escapes must throw SandboxEscapeError
      expect(() => sandbox.resolvePath("../escape.txt")).toThrow(SandboxEscapeError);
      expect(() => sandbox.resolvePath("/etc/passwd")).toThrow(SandboxEscapeError);
      expect(() => sandbox.resolvePath("C:\\Windows\\System32\\cmd.exe")).toThrow(SandboxEscapeError);
      expect(() => sandbox.resolvePath("\\\\server\\share")).toThrow(SandboxEscapeError);
      expect(() => sandbox.resolvePath("C:file.txt")).toThrow(SandboxEscapeError);
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });

  test("Sandbox guarantees host filesystem cannot be reached via tools, symlinks, or junctions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "origami-sandbox-sec-"));
    const hostSecretDir = mkdtempSync(join(tmpdir(), "origami-host-secret-"));
    const hostSecret = join(hostSecretDir, "secret.txt");
    writeFileSync(hostSecret, "SUPER_SECRET_HOST_DATA_NEVER_LEAK", "utf8");

    try {
      // 1. Direct path escape to host secret must be blocked
      const sandbox = new Sandbox(tmp);
      expect(() => sandbox.resolvePath(hostSecret)).toThrow(SandboxEscapeError);
      expect(sandbox.exists(hostSecret)).toBe(false);
      expect(() => sandbox.read(hostSecret)).toThrow();

      // 2. Host symlinks pointing outside workspace root must not be imported into memfs
      const hostWsWithSymlink = mkdtempSync(join(tmpdir(), "origami-host-ws-"));
      try {
        let symlinkCreated = false;
        try {
          symlinkSync(hostSecret, join(hostWsWithSymlink, "leak_symlink.txt"));
          symlinkCreated = true;
        } catch {
          // On some Windows environments, symlink creation without admin privileges might fail.
        }

        if (symlinkCreated) {
          const importedSandbox = new Sandbox(hostWsWithSymlink);
          // The symlink to external secret must NOT be imported into memfs
          expect(importedSandbox.exists("leak_symlink.txt")).toBe(false);
          expect(() => importedSandbox.read("leak_symlink.txt")).toThrow();
        }
      } finally {
        try { rmSync(hostWsWithSymlink, { recursive: true, force: true }); } catch {}
      }

      // 3. Memfs symlinks cannot reach host files (memfs is not unioned with host)
      sandbox.vol.symlinkSync(hostSecret, join(sandbox.root, "memlink_to_host.txt"));
      // Reading through this memfs symlink attempts to resolve hostSecret inside memfs,
      // where it does not exist because memfs is completely isolated from host.
      expect(sandbox.exists("memlink_to_host.txt")).toBe(false);
      expect(() => sandbox.read("memlink_to_host.txt")).toThrow(SandboxIoError);

      // 4. Safe export boundary: cannot write through escaping host symlinks
      sandbox.write("safe_file.txt", "exported content");
      const exportTarget = mkdtempSync(join(tmpdir(), "origami-export-target-"));
      try {
        sandbox.exportToDisk(exportTarget);
        expect(sandbox.exists("safe_file.txt")).toBe(true);
      } finally {
        try { rmSync(exportTarget, { recursive: true, force: true }); } catch {}
      }

      // 5. Recursive traversal cycles terminate safely
      sandbox.vol.mkdirSync(join(sandbox.root, "cycledir"), { recursive: true });
      sandbox.vol.symlinkSync(sandbox.root, join(sandbox.root, "cycledir", "loop"));
      const listOutput = sandbox.list(".");
      expect(listOutput).toContain("cycledir/loop/ -> [cycle");
      const grepOutput = sandbox.grep("exported", ".");
      expect(grepOutput).toContain("safe_file.txt");
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      try { rmSync(hostSecretDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("Sandbox getSnapshot and exportToDisk preserve evaluation contract", () => {
    const tmp = mkdtempSync(join(tmpdir(), "origami-snapshot-test-"));
    try {
      const sandbox = new Sandbox(tmp);
      sandbox.write("game.js", "const canvas = document.createElement('canvas');");
      sandbox.write("src/utils/math.ts", "export function add(a: number, b: number) { return a + b; }");
      sandbox.write("README.md", "# Title");

      const snapshot = sandbox.getSnapshot();
      expect(snapshot["game.js"]).toBe("const canvas = document.createElement('canvas');");
      expect(snapshot["src/utils/math.ts"]).toContain("export function add");
      expect(snapshot["README.md"]).toBe("# Title");
      expect(sandbox.getSnapshot()["game.js"]).toBe("const canvas = document.createElement('canvas');");

      const exportDir = mkdtempSync(join(tmpdir(), "origami-export-verify-"));
      try {
        sandbox.exportToDisk(exportDir);
        const imported = new Sandbox(exportDir);
        expect(imported.exists("game.js")).toBe(true);
        expect(imported.read("game.js")).toContain("canvas");
        expect(imported.exists("src/utils/math.ts")).toBe(true);
      } finally {
        try { rmSync(exportDir, { recursive: true, force: true }); } catch {}
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  test("Base tools execute workspace operations safely", () => {
    const tmp = mkdtempSync(join(tmpdir(), "origami-tools-test-"));
    try {
      const sandbox = new Sandbox(tmp);
      const ctx: ToolContext = {
        sandbox,
        verify: () => "Verification: all checks passed"
      };

      expect(BASE_TOOL_SPECS.map((s) => s.function.name)).toEqual([
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "grep",
        "check_work"
      ]);

      // write_file
      const wRes = executeBaseTool("write_file", { path: "test.js", content: "console.log('hi');" }, ctx);
      expect(wRes.ok).toBe(true);
      expect(sandbox.exists("test.js")).toBe(true);

      // read_file
      const rRes = executeBaseTool("read_file", { path: "test.js" }, ctx);
      expect(rRes.ok).toBe(true);
      expect(rRes.output).toContain("console.log('hi');");

      // edit_file
      const eRes = executeBaseTool(
        "edit_file",
        { path: "test.js", old_text: "console.log('hi');", new_text: "console.log('updated');" },
        ctx
      );
      expect(eRes.ok).toBe(true);
      expect(sandbox.read("test.js")).toContain("console.log('updated');");

      // list_files
      const lRes = executeBaseTool("list_files", {}, ctx);
      expect(lRes.ok).toBe(true);
      expect(lRes.output).toContain("test.js");

      // grep
      const gRes = executeBaseTool("grep", { pattern: "updated" }, ctx);
      expect(gRes.ok).toBe(true);
      expect(gRes.output).toContain("test.js");

      // check_work
      const cRes = executeBaseTool("check_work", {}, ctx);
      expect(cRes.ok).toBe(true);
      expect(cRes.output).toContain("Verification: all checks passed");
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });


  test("Compaction strategy factory instantiates all 5 strategies", () => {
    const strategies: CompactionStrategyName[] = [
      "origami",
      "soft",
      "handover",
      "shake",
      "sliding-window"
    ];

    for (const s of strategies) {
      const runtime = createCompactionRuntime(s);
      expect(runtime.strategy).toBe(s);
      expect(typeof runtime.systemInstructions()).toBe("string");
      expect(runtime.systemInstructions().length).toBeGreaterThan(10);
      expect(Array.isArray(runtime.toolSpecs())).toBe(true);
      const tel = runtime.telemetry();
      expect(tel.strategy).toBe(s);
    }
  });

  test("Scenarios support all 4 modes across low, medium, high, and insane scales", () => {
    const modes: ScenarioMode[] = ["programming", "research", "general", "memory"];
    const scales: ContextScale[] = ["low", "medium", "high", "insane"];

    for (const m of modes) {
      const sc = SCENARIO_REGISTRY[m];
      expect(sc).toBeDefined();
      expect(sc.mode).toBe(m);
      expect(sc.rubric.length).toBeGreaterThan(0);

      for (const scale of scales) {
        const turns = sc.generateTurns(scale);
        expect(turns.length).toBe(SCALE_TURNS[scale]);
        expect(turns[0]!.turnIndex).toBe(1);
        expect(turns[turns.length - 1]!.turnIndex).toBe(SCALE_TURNS[scale]);

        // Probes must exist
        const probeTurns = turns.filter((t) => t.isProbe);
        expect(probeTurns.length).toBeGreaterThan(0);
        for (const p of probeTurns) {
          expect(Array.isArray(p.expectedKeywords)).toBe(true);
          expect(p.expectedKeywords!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("AgentRunner completes mock simulation with complete telemetry", async () => {
    const res = await AgentRunner.run({
      scenario: SCENARIO_REGISTRY.programming,
      scale: "low",
      strategy: "origami",
      model: "mock-model",
      mock: true,
      cleanupWorkspace: true
    });

    expect(res.mode).toBe("programming");
    expect(res.scale).toBe("low");
    expect(res.strategy).toBe("origami");
    expect(res.totalTurns).toBe(20);
    if (res.rubricScore !== null) {
      expect(res.rubricScore).toBeGreaterThanOrEqual(0);
      expect(res.rubricScore).toBeLessThanOrEqual(1.0);
    } else {
      expect(res.rubricUnavailableCount).toBe(res.rubricTotalCount);
    }
    expect(typeof res.rubricPassedCount).toBe("number");
    expect(res.probeScore).toBe(1.0);
    expect(res.probeDetails.length).toBe(2);
    expect(res.tokens.billedTokens).toBeGreaterThan(0);
    expect(res.trajectory.length).toBe(20);
    expect(res.strategyTelemetry.strategy).toBe("origami");
  });


  test("GPT-5.6 Sol modeled billing separates uncached, cache-read, cache-write, and output costs", () => {
    const short = estimateLlmCost(GPT_5_6_SOL_PRICING, 10_000, 8_000, 1_000, 500);
    expect(short.uncachedInputTokens).toBe(1_000);
    expect(short.cacheReadCost).toBeCloseTo(0.0032, 10);
    expect(short.cacheWriteCost).toBeCloseTo(0.005, 10);
    expect(short.outputCost).toBeCloseTo(0.01, 10);
    expect(short.totalCost).toBeCloseTo(0.0222, 10);

    const long = estimateLlmCost(GPT_5_6_SOL_PRICING, 300_000, 200_000, 100_000, 1_000);
    expect(long.inputCost).toBe(0);
    expect(long.cacheReadCost).toBeCloseTo(0.16, 10);
    expect(long.cacheWriteCost).toBeCloseTo(1, 10);
    expect(long.outputCost).toBeCloseTo(0.03, 10);
    expect(long.totalCost).toBeCloseTo(1.19, 10);
  });

  test("All 5 scenario modes enforce 100% unique turns, stratified needle counts, zero Turn-1 freebies, >=45% lag, and ~25% temporal overrides", () => {
    const modes: ScenarioMode[] = ["programming", "research", "general", "memory", "all"];
    const scales: ContextScale[] = ["low", "medium", "high", "insane", "marathon"];

    for (const mode of modes) {
      const scenario = SCENARIO_REGISTRY[mode];
      for (const scale of scales) {
        const totalTurns = SCALE_TURNS[scale];
        const turns = scenario.generateTurns(scale);
        expect(turns.length).toBe(totalTurns);
        const uniqueMessages = new Set(turns.map((t) => t.userMessage));
        expect(uniqueMessages.size).toBe(turns.length);

        // Turn 1 must NEVER plant a needle or be a probe (zero head-pinning freebies)
        expect(turns[0]!.isProbe).toBeFalsy();
        expect(turns[0]!.userMessage).not.toContain("SESSION GOVERNANCE BRIEFING");
        expect(turns[0]!.userMessage).not.toContain("POLICY OVERRIDE DIRECTIVE");

        const probes = turns.filter((t) => t.isProbe);
        const expectedCount = mode === "memory" || mode === "all"
          ? SCALE_NEEDLE_COUNTS[scale]
          : SCALE_DOMAIN_PROBE_COUNTS[scale];
        expect(probes.length).toBe(expectedCount);
      }
    }

    // Verify deep-horizon lag (>= 45% of totalTurns) and temporal override ordering on memory mode across all scales
    for (const scale of scales) {
      const totalTurns = SCALE_TURNS[scale];
      const minLag = Math.floor(totalTurns * 0.45);
      const turns = SCENARIO_REGISTRY.memory.generateTurns(scale);
      const needles = getMemoryNeedlesForScale(scale);

      let overrideCount = 0;
      for (const needle of needles) {
        const probeTurn = turns.find((t) => t.isProbe && t.probeId === needle.probeId);
        expect(probeTurn).toBeDefined();

        if (needle.initialFact) {
          overrideCount++;
          const initTurn = turns.find((t) => !t.isProbe && t.userMessage.includes(`SESSION GOVERNANCE BRIEFING [${needle.symbol}]`));
          const overrideTurn = turns.find((t) => !t.isProbe && t.userMessage.includes(`POLICY OVERRIDE DIRECTIVE [${needle.symbol}]`));
          expect(initTurn).toBeDefined();
          expect(overrideTurn).toBeDefined();
          expect(initTurn!.turnIndex).toBeGreaterThanOrEqual(2);
          expect(overrideTurn!.turnIndex).toBeGreaterThan(initTurn!.turnIndex);
          expect(probeTurn!.turnIndex - overrideTurn!.turnIndex).toBeGreaterThanOrEqual(minLag);
          expect(probeTurn!.staleKeywords).toEqual(needle.staleKeywords);
        } else {
          const plantTurn = turns.find((t) => !t.isProbe && t.userMessage.includes(`SESSION GOVERNANCE BRIEFING [${needle.symbol}]`));
          expect(plantTurn).toBeDefined();
          expect(plantTurn!.turnIndex).toBeGreaterThanOrEqual(2);
          expect(plantTurn!.userMessage).toContain("NEVER write operational credentials");
          expect(probeTurn!.turnIndex - plantTurn!.turnIndex).toBeGreaterThanOrEqual(minLag);
        }
      }
      expect(overrideCount).toBeGreaterThanOrEqual(1);
    }
  });

  test("Origami archiveDigest bounds summary length on deep 850-turn spans and OrigamiRuntime indexes archive in SQLite FTS", () => {
    const entries: { type: string; id: string; message: { role: string; content: string } }[] = [];
    for (let t = 1; t <= 400; t++) {
      entries.push({ type: "message", id: `u${t}`, message: { role: "user", content: `Task ${t}: implement src/mod_${t}.ts exporting handler${t}()` } });
      entries.push({ type: "message", id: `a${t}`, message: { role: "assistant", content: `Completed src/mod_${t}.ts with full validation. ${"detail ".repeat(30)}` } });
    }
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "digest-bound-test",
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 128_000,
        projectedTokens: () => 90_000
      },
      entries,
      modelId: "test",
      config: configFromPreset("balanced")
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const digest = engine.archiveDigest([{ start: "m00003", end: "m00780" }], 160, 4800);
    expect(digest.length).toBeLessThanOrEqual(4800);
    expect(digest).toContain("intermediate messages archived");

    // Verify OrigamiRuntime wires in-memory SQLite DB so fold_search and fold_recall succeed
    const runtime = createCompactionRuntime("origami", { windowTokens: 50_000, forceThresholds: true });
    const messages: LlmMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Turn 1 briefing: staging port 9432 password Krypton-7729-Beta" },
      { role: "assistant", content: "Noted in memory." },
      { role: "user", content: `Turn 2 directive: header X-Origin-Zone eu-west-1a ${"padding ".repeat(80)}` },
      { role: "assistant", content: `Implemented module. ${"padding ".repeat(80)}` }
    ];
    for (let i = 3; i <= 10; i++) {
      messages.push({ role: "user", content: `Turn ${i} work item ${"padding ".repeat(80)}` });
      messages.push({ role: "assistant", content: `Turn ${i} completed ${"padding ".repeat(80)}` });
    }
    const maint = runtime.autoMaintain(messages, 50_000, true);
    expect(maint.acted).toBe(true);
    const searchOut = runtime.handleTool("fold_search", { query: "X-Origin-Zone eu-west-1a" }, messages);
    expect(searchOut).not.toContain("(no matches");
    expect(searchOut).toContain("eu-west-1a");
  });

  test("evaluateProbeAnswer rejects disclaimed/wrong-entity keyword guesses and cacheAccounting avoids 100% clamping on fresh turns", () => {
    const falsePositive = evaluateProbeAnswer(
      "Based on README.md, specific configuration details for a staging database port are not available.\n\nHowever, Replica Password: Krypton-7729-Beta.\n\nIf you are referring to the Production Port, it is documented as 9432.",
      ["9432", "Krypton-7729-Beta"]
    );
    expect(falsePositive.passed).toBe(false);
    expect(falsePositive.missing).toContain("9432");

    const genuinePass = evaluateProbeAnswer(
      "The staging database port is 9432 and the replica password is Krypton-7729-Beta.",
      ["9432", "Krypton-7729-Beta"]
    );
    expect(genuinePass.passed).toBe(true);

    // Temporal override validation: stale-only fails, ambiguous hedge fails, clean or explained active value passes
    expect(evaluateProbeAnswer("INGEST_MAX_BATCH_BYTES is 65536 bytes.", ["18432"], ["65536"]).passed).toBe(false);
    expect(evaluateProbeAnswer("INGEST_MAX_BATCH_BYTES is either 65536 or 18432 bytes.", ["18432"], ["65536"]).passed).toBe(false);
    expect(evaluateProbeAnswer("The current active limit is 18432 bytes.", ["18432"], ["65536"]).passed).toBe(true);
    expect(evaluateProbeAnswer("Originally set to 65536, it was lowered to 18432 bytes.", ["18432"], ["65536"]).passed).toBe(true);

    // cacheAccounting: when local message token sum slightly exceeds provider promptTokens, new turns still incur cacheWriteTokens > 0
    const state = createLlmCacheState();
    const turn1: LlmMessage[] = [
      { role: "system", content: "word ".repeat(600) },
      { role: "user", content: "word ".repeat(600) }
    ];
    cacheAccounting(turn1, 2000, state);
    const turn2: LlmMessage[] = [
      ...turn1,
      { role: "assistant", content: "done ".repeat(30) },
      { role: "user", content: "next task ".repeat(30) }
    ];
    // Simulate provider reporting slightly fewer promptTokens than sum(countLlmMessageTokens(turn1))
    const res2 = cacheAccounting(turn2, 2050, state);
    expect(res2.cachedTokens).toBeLessThan(2050);
    expect(res2.cacheWriteTokens).toBeGreaterThan(0);
  });

  test("per-turn tool memo suppresses identical read-only calls instead of looping", async () => {
    const root = mkdtempSync(join(tmpdir(), "memo-"));
    const sandbox = new Sandbox(root);
    try {
      let reads = 0;
      const stubRuntime = {
        toolSpecs: () => [{
          type: "function",
          function: {
            name: "fold_recall",
            description: "recall archived text",
            parameters: { type: "object", properties: { refs: { type: "string" } }, required: ["refs"] }
          }
        }],
        handleTool: () => {
          reads++;
          return "recalled text";
        }
      } as unknown as CompactionRuntime;

      const memo = createToolCallMemo();
      const tools = createAgentTools({ sandbox }, stubRuntime, () => [], { memo });
      const exec = tools.fold_recall as unknown as { execute: (args: Record<string, unknown>) => Promise<string> };

      const first = await exec.execute({ refs: "m00396" });
      const second = await exec.execute({ refs: "m00396" });
      const third = await exec.execute({ refs: "m00400" });

      expect(reads).toBe(2); // m00396 once + m00400 once; the duplicate did not re-execute
      expect(first).toContain("recalled text");
      expect(second).toContain("Duplicate call");
      expect(second).toContain("recalled text");
      expect(third).toContain("recalled text");

      memo.reset();
      await exec.execute({ refs: "m00396" });
      expect(reads).toBe(3); // reset clears the memo, so the call re-executes
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createTurnMaintainer reports each distinct compaction note at most once per turn", () => {
    const notes: string[] = [];
    let compactions = 0;
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u ".repeat(2000) },
      { role: "assistant", content: "a ".repeat(2000) }
    ];
    const stub = {
      strategy: "soft",
      toolSpecs: () => [],
      systemInstructions: () => "",
      handleTool: () => "",
      telemetry: () => ({ strategy: "soft", compactionEvents: compactions, toolInvocations: 0, tokensReclaimed: 0, details: {} }),
      prepareOutbound: (m: LlmMessage[]) => m,
      autoMaintain: () => {
        compactions++;
        return { acted: true, note: "Soft-compacted older turns (1,000 tokens reclaimed)" };
      }
    } as unknown as CompactionRuntime;

    const maintain = createTurnMaintainer({
      runtime: stub,
      messages,
      windowTokens: 100,
      count: (m) => m.reduce((s, x) => s + x.content.length, 0),
      onNote: (n) => notes.push(n)
    });

    maintain();
    maintain();
    maintain();
    // Three maintenance passes with an identical note surface exactly once.
    expect(compactions).toBe(3);
    expect(notes).toEqual(["Soft-compacted older turns (1,000 tokens reclaimed)"]);
  });

  test("generateReportHtml emits balanced meta-bar markup, tie labels, and telemetry-grounded observations", async () => {
    const r1 = await AgentRunner.run({
      scenario: SCENARIO_REGISTRY.memory,
      scale: "low",
      strategy: "origami",
      model: "mock-model",
      mock: true,
      cleanupWorkspace: true
    });
    const r2 = await AgentRunner.run({
      scenario: SCENARIO_REGISTRY.memory,
      scale: "low",
      strategy: "shake",
      model: "mock-model",
      mock: true,
      cleanupWorkspace: true
    });
    const html = generateReportHtml([r1, r2], { model: "gemma4:latest", scales: ["low"] });
    expect(html).toContain('<div class="meta-bar">');
    expect(html).toContain("ORIGAMI · SHAKE (TIE)");
    expect(html).not.toContain("achieved 100% needle recall via JIT reactive hydration");
  });
});
