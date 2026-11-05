import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../bench/agentic/agent.ts";
import { SCENARIO_REGISTRY } from "../bench/agentic/scenarios.ts";
import { createCompactionRuntime, type CompactionStrategyName } from "../bench/agentic/strategy-runtime.ts";
import { countLlmMessageTokens, type LlmMessage } from "../bench/agentic/llm.ts";

describe("Forced Periodic Compaction (every 10 turns)", () => {
  test("strategy-runtime autoMaintain honors force flag for all strategies", async () => {
    const strategies: CompactionStrategyName[] = [
      "origami",
      "soft",
      "handover"
    ];

    for (const strategy of strategies) {
      const runtime = createCompactionRuntime(strategy, { windowTokens: 100_000, forceThresholds: true });
      const messages: LlmMessage[] = [
        { role: "system", content: "You are a software engineer." }
      ];
      for (let i = 1; i <= 8; i++) {
        messages.push({
          role: "user",
          content: `Turn ${i}: implement module ${i} requirements with complete architectural constraints.\n${"const codeLine = 1;\n".repeat(15)}`
        });
        messages.push({
          role: "tool",
          name: "read_file",
          content: `read_file module_${i}.js (lines 1-80 of 80)\n${"function execute() { return true; }\n".repeat(30)}`
        });
        messages.push({
          role: "assistant",
          content: `Answer ${i}: module ${i} completed.\n${"function execute() {}\n".repeat(15)}`
        });
      }

      // Normal call without force should not trigger on small 5-turn history
      const normal = await runtime.autoMaintain(messages, 100_000, false);
      expect(normal.acted).toBe(false);

      // Forced call should trigger compaction / maintenance
      const forced = await runtime.autoMaintain(messages, 100_000, true);
      expect(forced.acted).toBe(true);
      expect(forced.note).toBeDefined();
    }
  });

  test("AgentRunner forces compaction on turn 10 and turn 20 in mock run", async () => {
    const result = await AgentRunner.run({
      scenario: {
        ...SCENARIO_REGISTRY.programming,
        generateTurns: (scale) => SCENARIO_REGISTRY.programming.generateTurns(scale).map((turn) => ({
          ...turn,
          userMessage: `${turn.userMessage}\n${"Implement the requested behavior and preserve prior decisions. ".repeat(30)}`
        }))
      },
      scale: "low", // 20 turns
      strategy: "origami",
      model: "mock-model",
      mock: true,
      compactEvery: 10,
      cleanupWorkspace: true
    });

    expect(result.completedTurns).toBe(20);

    // Verify maintenance notes on Turn 10 and Turn 20
    const turn10 = result.trajectory.find((t) => t.turnIndex === 10);
    const turn20 = result.trajectory.find((t) => t.turnIndex === 20);

    expect(turn10?.maintenanceNote).toBeDefined();
    expect(turn10?.maintenanceNote).toContain("Origami");

    expect(turn20?.maintenanceNote).toBeDefined();
    expect(turn20?.maintenanceNote).toContain("Origami");

    // Strategy telemetry shows compaction events occurred
    expect(result.strategyTelemetry.compactionEvents).toBeGreaterThanOrEqual(1);
    expect(result.tokens.billedTokens).toBeGreaterThan(0);
  }, 30_000);

  test("AgentRunner forces soft compaction on turn 10", async () => {
    const result = await AgentRunner.run({
      scenario: SCENARIO_REGISTRY.memory,
      scale: "low",
      strategy: "soft",
      model: "mock-model",
      mock: true,
      compactEvery: 10,
      cleanupWorkspace: true
    });

    const turn10 = result.trajectory.find((t) => t.turnIndex === 10);
    expect(turn10?.maintenanceNote).toBeDefined();
    expect(turn10?.maintenanceNote).toContain("Soft-compacted");
  }, 30_000);

  test("AgentRunner forces handover on turn 10", async () => {
    const result = await AgentRunner.run({
      scenario: SCENARIO_REGISTRY.memory,
      scale: "low",
      strategy: "handover",
      model: "mock-model",
      mock: true,
      compactEvery: 10,
      cleanupWorkspace: true
    });

    const turn10 = result.trajectory.find((t) => t.turnIndex === 10);
    expect(turn10?.maintenanceNote).toBeDefined();
    expect(turn10?.maintenanceNote).toContain("Auto-handed off");
  }, 30_000);

  test("Origami compacts at 80% and retains messages appended after a fold", async () => {
    const windowTokens = 100_000;
    const runtime = createCompactionRuntime("origami", { windowTokens });
    const messages: LlmMessage[] = [{ role: "system", content: "system" }];
    const appendTurn = (i: number) => {
      messages.push({ role: "user", content: `Task ${i}: ${"requirements and decisions ".repeat(220)}` });
      messages.push({ role: "assistant", content: `Done ${i}: ${"implementation details ".repeat(220)}` });
    };
    for (let i = 0; i < 20; i++) appendTurn(i);
    expect((await runtime.autoMaintain(messages, windowTokens)).acted).toBe(false);
    for (let i = 20; i < 32; i++) appendTurn(i);
    const count = () => runtime.prepareOutbound(messages, windowTokens)
      .reduce((sum, message) => sum + countLlmMessageTokens(message), 0);
    const before = count();
    expect(before).toBeGreaterThanOrEqual(windowTokens * 0.8);
    expect((await runtime.autoMaintain(messages, windowTokens)).acted).toBe(true);
    expect(count()).toBeLessThan(before * 0.5);
    messages.push({ role: "user", content: "New instruction after compaction" });
    messages.push({ role: "assistant", content: "New answer after compaction" });
    const outbound = runtime.prepareOutbound(messages, windowTokens);
    expect(outbound.some((message) => message.content.includes("New instruction after compaction"))).toBe(true);
    expect(outbound.some((message) => message.content.includes("New answer after compaction"))).toBe(true);
    expect((await runtime.autoMaintain(messages, windowTokens)).acted).toBe(false);
  });

  test("hard-bounds outbound history for every strategy and keeps tool pairs valid", () => {
    const strategies: CompactionStrategyName[] = ["origami", "soft", "handover"];
    const messages: LlmMessage[] = [{ role: "system", content: "system" }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `Turn ${i}: ${"requirements ".repeat(120)}` });
      messages.push({
        role: "assistant",
        content: "",
        reasoning: `Reasoning ${i}: ${"decision ".repeat(180)}`,
        tool_calls: [{ id: `call-${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "game.js" }) } }]
      });
      messages.push({ role: "tool", name: "read_file", tool_call_id: `call-${i}`, content: `Output ${i}: ${"source line ".repeat(140)}` });
    }

    for (const strategy of strategies) {
      const runtime = createCompactionRuntime(strategy, { windowTokens: 20_000 });
      const outbound = runtime.prepareOutbound(messages, 20_000);
      const outboundTokens = outbound.reduce((sum, message) => sum + countLlmMessageTokens(message), 0);
      expect(outboundTokens).toBeLessThanOrEqual(12_000);

      const callIds = new Set(
        outbound.flatMap((message) => message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.id) : [])
      );
      for (const message of outbound) {
        if (message.role === "tool") expect(callIds.has(message.tool_call_id ?? "")).toBe(true);
      }
    }
  });
});
