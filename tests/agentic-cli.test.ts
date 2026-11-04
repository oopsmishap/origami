import { describe, expect, it } from "bun:test";
import {
  parseCliArgs,
  createCliCommand,
  printHelp,
  mapConcurrent,
  formatRubricDisplay,
  RunnerCliArgsSchema,
  ALL_STRATEGIES,
  ALL_MODES,
  type RunnerCliArgs
} from "../bench/agentic/runner.ts";

describe("Agentic Benchmark CLI & Orchestrator Suite", () => {
  describe("Default CLI Configurations", () => {
    it("returns standard defaults when called with an empty argument list", () => {
      const args = parseCliArgs([]);
      expect(args.modes).toEqual(["programming"]);
      expect(args.scales).toEqual(["low"]);
      expect(args.strategies).toEqual([
        "origami",
        "soft",
        "handover"
      ]);
      expect(args.model).toBe("gemma4:latest");
      expect(args.pricingModel).toBe("gpt-5.6-sol");
      expect(args.mock).toBe(false);
      expect(args.web).toBe(false);
      expect(args.port).toBe(4143);
      expect(args.outDir).toBe("bench/results");
      expect(args.parallel).toBe(false);
      expect(args.concurrency).toBeUndefined();
      expect(args.turns).toBeUndefined();
      expect(args.prefill).toBeUndefined();
      expect(args.maxTokens).toBeUndefined();
      expect(args.windowTokens).toBeUndefined();
      expect(args.compactEvery).toBeUndefined();
    });

    it("handles node/bun process.argv style argv vectors", () => {
      const args = parseCliArgs(["bun", "bench/agentic/runner.ts"]);
      expect(args.modes).toEqual(["programming"]);
      expect(args.scales).toEqual(["low"]);
      expect(args.model).toBe("gemma4:latest");

      const withFlags = parseCliArgs(["node", "/path/to/runner.js", "--mock", "--web"]);
      expect(withFlags.mock).toBe(true);
      expect(withFlags.web).toBe(true);
    });
  });

  describe("Mode and Scenario Option Parsing", () => {
    it("parses individual valid modes", () => {
      expect(parseCliArgs(["--mode", "programming"]).modes).toEqual(["programming"]);
      expect(parseCliArgs(["-m", "research"]).modes).toEqual(["research"]);
      expect(parseCliArgs(["-m", "general"]).modes).toEqual(["general"]);
      expect(parseCliArgs(["--mode", "memory"]).modes).toEqual(["memory"]);
    });

    it("expands --mode all to all available modes", () => {
      const args = parseCliArgs(["--mode", "all"]);
      expect(args.modes).toEqual(["programming", "research", "general", "memory"]);
    });

    it("parses comma-separated mode lists", () => {
      const args = parseCliArgs(["--mode", "research,memory"]);
      expect(args.modes).toEqual(["research", "memory"]);
    });
  });

  describe("Scale Option Parsing", () => {
    it("parses individual scale options", () => {
      expect(parseCliArgs(["--scale", "low"]).scales).toEqual(["low"]);
      expect(parseCliArgs(["-s", "medium"]).scales).toEqual(["medium"]);
      expect(parseCliArgs(["--scale", "high"]).scales).toEqual(["high"]);
      expect(parseCliArgs(["-s", "insane"]).scales).toEqual(["insane"]);
      expect(parseCliArgs(["--scale", "marathon"]).scales).toEqual(["marathon"]);
    });

    it("parses comma-separated scale lists", () => {
      const args = parseCliArgs(["-s", "low,medium,marathon"]);
      expect(args.scales).toEqual(["low", "medium", "marathon"]);
    });
  });

  describe("Strategy Option Parsing", () => {
    it("parses individual compaction strategies", () => {
      for (const strat of ALL_STRATEGIES) {
        expect(parseCliArgs(["--strategy", strat]).strategies).toEqual([strat]);
      }
    });

    it("expands --strategy all to all supported strategies", () => {
      const args = parseCliArgs(["--strategy", "all"]);
      expect(args.strategies).toEqual([
        "origami",
        "soft",
        "handover"
      ]);
    });

    it("parses comma-separated strategy lists", () => {
      const args = parseCliArgs(["--strategy", "origami,handover"]);
      expect(args.strategies).toEqual(["origami", "handover"]);
    });
  });

  describe("Model Aliases and Target Model Resolution", () => {
    it("maps lfm3 aliases to lfm3:256k", () => {
      expect(parseCliArgs(["--model", "lfm3"]).model).toBe("lfm3:256k");
      expect(parseCliArgs(["--model", "ollama/lfm3"]).model).toBe("lfm3:256k");
      expect(parseCliArgs(["--model", "lfm3:latest"]).model).toBe("lfm3:256k");
      expect(parseCliArgs(["--model", "lfm3:256k"]).model).toBe("lfm3:256k");
    });

    it("preserves explicit model identifiers", () => {
      expect(parseCliArgs(["--model", "gemma4:latest"]).model).toBe("gemma4:latest");
      expect(parseCliArgs(["--model", "custom-org/special-model:v2"]).model).toBe("custom-org/special-model:v2");
    });
  });

  describe("Parallelism and Concurrency Option Interaction", () => {
    it("sets parallel flag via -p or --parallel", () => {
      expect(parseCliArgs(["-p"]).parallel).toBe(true);
      expect(parseCliArgs(["--parallel"]).parallel).toBe(true);
      expect(parseCliArgs([]).parallel).toBe(false);
    });

    it("automatically sets parallel = true when concurrency is specified", () => {
      const args = parseCliArgs(["--concurrency", "4"]);
      expect(args.parallel).toBe(true);
      expect(args.concurrency).toBe(4);

      const shortArgs = parseCliArgs(["-c", "8"]);
      expect(shortArgs.parallel).toBe(true);
      expect(shortArgs.concurrency).toBe(8);
    });
  });

  describe("Prefill Parsing with Unit Multipliers", () => {
    it("parses kilotoken unit 'k' (case-insensitive)", () => {
      expect(parseCliArgs(["--prefill", "50k"]).prefill).toBe(50000);
      expect(parseCliArgs(["--prefill", "100K"]).prefill).toBe(100000);
      expect(parseCliArgs(["--prefill", "12.5k"]).prefill).toBe(12500);
    });

    it("parses megatoken unit 'm' (case-insensitive)", () => {
      expect(parseCliArgs(["--prefill", "1m"]).prefill).toBe(1000000);
      expect(parseCliArgs(["--prefill", "1.5M"]).prefill).toBe(1500000);
    });

    it("parses raw numeric token counts", () => {
      expect(parseCliArgs(["--prefill", "25000"]).prefill).toBe(25000);
      expect(parseCliArgs(["--prefill", "0"]).prefill).toBe(0);
    });
  });

  describe("Numeric Flags and Range Overrides", () => {
    it("parses valid positive integer flags", () => {
      const args = parseCliArgs([
        "-t", "100",
        "-M", "2048",
        "--window", "131072",
        "--compact-every", "10",
        "--port", "8080",
        "--out", "custom/artifacts"
      ]);
      expect(args.turns).toBe(100);
      expect(args.maxTokens).toBe(2048);
      expect(args.windowTokens).toBe(131072);
      expect(args.compactEvery).toBe(10);
      expect(args.port).toBe(8080);
      expect(args.outDir).toBe("custom/artifacts");
    });
  });

  describe("Flag Combinations and Complex Invocations", () => {
    it("parses multiple combined flags without collision or mutation", () => {
      const args = parseCliArgs([
        "-m", "research",
        "-s", "medium,high",
        "--strategy", "origami",
        "--model", "lfm3",
        "--pricing-model", "gpt-5.6-sol",
        "--mock",
        "--web",
        "--port", "5050",
        "--out", "output/bench",
        "-p",
        "-c", "4",
        "-t", "30",
        "--prefill", "100k",
        "-M", "4096",
        "--window", "200000",
        "--compact-every", "5"
      ]);

      expect(args).toEqual({
        modes: ["research"],
        scales: ["medium", "high"],
        strategies: ["origami"],
        model: "lfm3:256k",
        pricingModel: "gpt-5.6-sol",
        mock: true,
        web: true,
        port: 5050,
        outDir: "output/bench",
        parallel: true,
        concurrency: 4,
        turns: 30,
        prefill: 100000,
        maxTokens: 4096,
        windowTokens: 200000,
        compactEvery: 5
      });
    });
  });

  describe("Rejection of Unknown Flags and Missing Values", () => {
    it("rejects unknown long flags", () => {
      expect(() => parseCliArgs(["--unknown-flag"])).toThrow();
      expect(() => parseCliArgs(["--foo"])).toThrow();
    });

    it("rejects unknown short flags", () => {
      expect(() => parseCliArgs(["-z"])).toThrow();
      expect(() => parseCliArgs(["-x"])).toThrow();
    });

    it("rejects missing values for options requiring arguments", () => {
      expect(() => parseCliArgs(["--port"])).toThrow();
      expect(() => parseCliArgs(["--mode"])).toThrow();
      expect(() => parseCliArgs(["--scale"])).toThrow();
      expect(() => parseCliArgs(["--strategy"])).toThrow();
      expect(() => parseCliArgs(["--concurrency"])).toThrow();
      expect(() => parseCliArgs(["--turns"])).toThrow();
      expect(() => parseCliArgs(["--prefill"])).toThrow();
      expect(() => parseCliArgs(["--max-tokens"])).toThrow();
      expect(() => parseCliArgs(["--compact-every"])).toThrow();
      expect(() => parseCliArgs(["--window"])).toThrow();
      expect(() => parseCliArgs(["--pricing-model"])).toThrow();
      expect(() => parseCliArgs(["--out"])).toThrow();
      expect(() => parseCliArgs(["--model"])).toThrow();
    });
  });

  describe("Rejection of Invalid Numeric and Out-of-Range Values", () => {
    it("rejects non-numeric NaN values for integer options", () => {
      expect(() => parseCliArgs(["--port", "not-a-number"])).toThrow();
      expect(() => parseCliArgs(["--concurrency", "abc"])).toThrow();
      expect(() => parseCliArgs(["--turns", "xyz"])).toThrow();
      expect(() => parseCliArgs(["--prefill", "bad-unit"])).toThrow();
      expect(() => parseCliArgs(["--max-tokens", "foo"])).toThrow();
      expect(() => parseCliArgs(["--window", "bar"])).toThrow();
      expect(() => parseCliArgs(["--compact-every", "baz"])).toThrow();
    });

    it("rejects out-of-range port numbers", () => {
      expect(() => parseCliArgs(["--port", "0"])).toThrow();
      expect(() => parseCliArgs(["--port", "-80"])).toThrow();
      expect(() => parseCliArgs(["--port", "65536"])).toThrow();
      expect(() => parseCliArgs(["--port", "100000"])).toThrow();
      expect(() => parseCliArgs(["--port", "80.5"])).toThrow();
    });

    it("rejects non-positive concurrency, turns, and token counts", () => {
      expect(() => parseCliArgs(["--concurrency", "0"])).toThrow();
      expect(() => parseCliArgs(["--concurrency", "-1"])).toThrow();
      expect(() => parseCliArgs(["--concurrency", "2.5"])).toThrow();

      expect(() => parseCliArgs(["--turns", "0"])).toThrow();
      expect(() => parseCliArgs(["--turns", "-5"])).toThrow();
      expect(() => parseCliArgs(["--turns", "10.5"])).toThrow();

      expect(() => parseCliArgs(["--max-tokens", "0"])).toThrow();
      expect(() => parseCliArgs(["--max-tokens", "-512"])).toThrow();

      expect(() => parseCliArgs(["--window", "0"])).toThrow();
      expect(() => parseCliArgs(["--window", "-1000"])).toThrow();

      expect(() => parseCliArgs(["--compact-every", "0"])).toThrow();
      expect(() => parseCliArgs(["--compact-every", "-3"])).toThrow();
    });

    it("rejects negative prefill numbers", () => {
      expect(() => parseCliArgs(["--prefill", "-10"])).toThrow();
      expect(() => parseCliArgs(["--prefill", "-50k"])).toThrow();
    });
  });

  describe("Rejection of Invalid Enums and Strategies", () => {
    it("rejects unknown scenario modes", () => {
      expect(() => parseCliArgs(["--mode", "quantum"])).toThrow();
      expect(() => parseCliArgs(["--mode", "programming,nonexistent"])).toThrow();
    });

    it("rejects unknown context scales", () => {
      expect(() => parseCliArgs(["--scale", "giga"])).toThrow();
      expect(() => parseCliArgs(["--scale", "low,ultra"])).toThrow();
    });

    it("rejects unknown compaction strategies", () => {
      expect(() => parseCliArgs(["--strategy", "hypothetical"])).toThrow();
      expect(() => parseCliArgs(["--strategy", "origami,telepathy"])).toThrow();
    });

    it("rejects unsupported pricing models", () => {
      expect(() => parseCliArgs(["--pricing-model", "gpt-4"])).toThrow();
      expect(() => parseCliArgs(["--pricing-model", "claude-3-5"])).toThrow();
    });
  });

  describe("Help and Command Introspection", () => {
    it("creates a Commander command with allowUnknownOption disabled", () => {
      const command = createCliCommand();
      expect(command.name()).toBe("bun bench/agentic/runner.ts");
    });

    it("prints help text cleanly via printHelp()", () => {
      let output = "";
      const originalLog = console.log;
      try {
        console.log = (msg: string) => { output += msg; };
        printHelp();
        expect(output).toContain("Origami Agentic Context Benchmark Runner");
        expect(output).toContain("--mode, -m <mode>");
        expect(output).toContain("--strategy <strat>");
        expect(output).toContain("--scale, -s <scale>");
      } finally {
        console.log = originalLog;
      }
    });

    it("validates valid arguments using RunnerCliArgsSchema", () => {
      const valid: RunnerCliArgs = {
        modes: ["programming"],
        scales: ["low"],
        strategies: ["origami"],
        model: "gemma4:latest",
        pricingModel: "gpt-5.6-sol",
        mock: false,
        web: false,
        port: 4143,
        outDir: "bench/results",
        parallel: false
      };
      const result = RunnerCliArgsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });

  describe("Concurrency Orchestration (mapConcurrent via p-limit)", () => {
    it("preserves exact array ordering regardless of item resolution timing", async () => {
      const r0 = Promise.withResolvers<number>();
      const r1 = Promise.withResolvers<number>();
      const r2 = Promise.withResolvers<number>();
      const r3 = Promise.withResolvers<number>();
      const resolvers = [r0, r1, r2, r3];

      const promise = mapConcurrent([0, 1, 2, 3], 4, async (item) => {
        const val = await resolvers[item]!.promise;
        return val * val;
      });

      // Resolve in scrambled order: 2, 0, 3, 1
      resolvers[2]!.resolve(2);
      resolvers[0]!.resolve(0);
      resolvers[3]!.resolve(3);
      resolvers[1]!.resolve(1);

      const results = await promise;
      expect(results).toEqual([0, 1, 4, 9]);
    });

    it("strictly limits concurrent executions to the concurrency limit", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const drainMicrotasks = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };
      const concurrencyLimit = 2;
      const gates = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>()
      ];

      const promise = mapConcurrent([0, 1, 2, 3], concurrencyLimit, async (item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gates[item]!.promise;
        inFlight--;
        return item * 10;
      });

      // Microtask tick: items 0 and 1 start
      await drainMicrotasks();
      expect(inFlight).toBe(2);
      expect(maxInFlight).toBe(2);

      // Resolve item 0: allows item 2 to enter
      gates[0]!.resolve();
      await drainMicrotasks();
      expect(inFlight).toBe(2);
      expect(maxInFlight).toBe(2);

      // Resolve item 1: allows item 3 to enter
      gates[1]!.resolve();
      await drainMicrotasks();
      expect(inFlight).toBe(2);
      expect(maxInFlight).toBe(2);
      // Resolve items 2 and 3: completes all
      gates[2]!.resolve();
      gates[3]!.resolve();

      const results = await promise;
      expect(results).toEqual([0, 10, 20, 30]);
      expect(maxInFlight).toBe(concurrencyLimit);
    });

    it("propagates worker failures and rejects cleanly", async () => {
      const items = [1, 2, 3, 4];
      const promise = mapConcurrent(items, 2, async (item) => {
        if (item === 3) {
          throw new Error("Worker failed on item 3");
        }
        return item;
      });

      await expect(promise).rejects.toThrow("Worker failed on item 3");
    });

    it("handles an empty input array", async () => {
      const results = await mapConcurrent([], 4, async (item) => item);
      expect(results).toEqual([]);
    });

    it("handles concurrencyLimit of 1 by processing sequentially", async () => {
      const drainMicrotasks = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };
      let inFlight = 0;
      let maxInFlight = 0;
      const executionOrder: number[] = [];
      const gates = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>()
      ];

      const promise = mapConcurrent([0, 1, 2], 1, async (item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        executionOrder.push(item);
        await gates[item]!.promise;
        inFlight--;
        return item;
      });

      await drainMicrotasks();
      expect(executionOrder).toEqual([0]);
      expect(maxInFlight).toBe(1);

      gates[0]!.resolve();
      await drainMicrotasks();
      expect(executionOrder).toEqual([0, 1]);
      expect(maxInFlight).toBe(1);

      gates[1]!.resolve();
      await drainMicrotasks();
      expect(executionOrder).toEqual([0, 1, 2]);
      expect(maxInFlight).toBe(1);
      gates[2]!.resolve();
      const results = await promise;
      expect(results).toEqual([0, 1, 2]);
    });
  });

  describe("Rubric Evaluation Formatting (formatRubricDisplay)", () => {
    it("renders 'N/A' (not 0% or NaN) when rubricScore is null", () => {
      const formatted = formatRubricDisplay({
        rubricScore: null,
        rubricPassedCount: 0,
        rubricTotalCount: 15,
        rubricEvaluatedCount: 0,
        rubricUnavailableCount: 15,
        rubricErrorCount: 0
      });
      expect(formatted.scoreStr).toBe("N/A");
      expect(formatted.scoreStr).not.toContain("0%");
      expect(formatted.scoreStr).not.toContain("NaN");
      expect(formatted.countStr).toContain("0/0 eval (15 tot)");
      expect(formatted.countStr).toContain("15 unavail");
      expect(formatted.fullStr).toBe("N/A (0/0 eval (15 tot) [15 unavail])");
    });

    it("displays evaluated vs total plus unavailable and error counts", () => {
      const formatted = formatRubricDisplay({
        rubricScore: 0.8,
        rubricPassedCount: 8,
        rubricTotalCount: 15,
        rubricEvaluatedCount: 10,
        rubricUnavailableCount: 3,
        rubricErrorCount: 2
      });
      expect(formatted.scoreStr).toBe("80%");
      expect(formatted.countStr).toBe("8/10 eval (15 tot) [3 unavail, 2 err]");
      expect(formatted.fullStr).toBe("80% (8/10 eval (15 tot) [3 unavail, 2 err])");
    });

    it("displays standard counts when all criteria are evaluated without unavail/error", () => {
      const formatted = formatRubricDisplay({
        rubricScore: 1.0,
        rubricPassedCount: 12,
        rubricTotalCount: 12,
        rubricEvaluatedCount: 12,
        rubricUnavailableCount: 0,
        rubricErrorCount: 0
      });
      expect(formatted.scoreStr).toBe("100%");
      expect(formatted.countStr).toBe("12/12");
      expect(formatted.fullStr).toBe("100% (12/12)");
    });

    it("handles legacy/simplified outcome structures where counts default to total", () => {
      const formatted = formatRubricDisplay({
        rubricScore: 0.5,
        rubricPassedCount: 3,
        rubricTotalCount: 6
      });
      expect(formatted.scoreStr).toBe("50%");
      expect(formatted.countStr).toBe("3/6");
      expect(formatted.fullStr).toBe("50% (3/6)");
    });

    it("renders 'N/A' for null rubricScore even if evaluatedCount is omitted", () => {
      const formatted = formatRubricDisplay({
        rubricScore: null,
        rubricPassedCount: 0,
        rubricTotalCount: 10
      });
      expect(formatted.scoreStr).toBe("N/A");
      expect(formatted.countStr).toBe("0/10");
      expect(formatted.fullStr).toBe("N/A (0/10)");
    });
  });
});
