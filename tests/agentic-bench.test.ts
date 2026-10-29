import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sandbox, SandboxEscapeError } from "../bench/agentic/sandbox.ts";
import { BASE_TOOL_SPECS, executeBaseTool, type ToolContext } from "../bench/agentic/tools.ts";
import { allowedLlmHosts, DEFAULT_LLM_HOSTS } from "../bench/agentic/llm.ts";
import {
  createCompactionRuntime,
  type CompactionStrategyName
} from "../bench/agentic/strategy-runtime.ts";
import {
  SCENARIO_REGISTRY,
  SCALE_TURNS,
  type ContextScale,
  type ScenarioMode
} from "../bench/agentic/scenarios.ts";
import { AgentRunner } from "../bench/agentic/agent.ts";

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
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
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

  test("Egress allowlist restricts LLM endpoints", () => {
    const hosts = allowedLlmHosts();
    for (const h of DEFAULT_LLM_HOSTS) {
      expect(hosts.has(h)).toBe(true);
    }
    expect(hosts.has("malicious-exfiltration-site.com")).toBe(false);
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
    expect(res.completedTurns).toBe(20);
    expect(res.rubricScore).toBe(1.0);
    expect(res.rubricPassedCount).toBe(15);
    expect(res.probeScore).toBe(1.0);
    expect(res.probeDetails.length).toBe(2);
    expect(res.tokens.billedTokens).toBeGreaterThan(0);
    expect(res.trajectory.length).toBe(20);
    expect(res.strategyTelemetry.strategy).toBe("origami");
  });
});
