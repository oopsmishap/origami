/**
 * Test suite for the benchmark-only agentic evaluation engine.
 *
 * Covers:
 * 1. Keyword-only Pac-Man files MUST NOT pass.
 * 2. Missing container / Docker prerequisite handling (explicit "unavailable" status, not fake pass/fail).
 * 3. Real functional Pac-Man evaluation inside network-isolated Docker container.
 * 4. check_work / verifyWorkspace safety (zero rubric answers / secret leakage).
 * 5. Research scenario audit report validation (rejects shallow keywords, validates flaw + fix).
 * 6. Promptfoo offline assertion engine (offline, no remote LLM calls, no telemetry).
 * 7. Memory scenario needle recall evaluation.
 * 8. Nullable rubricScore calculation across evaluable items only.
 */

import { describe, expect, test } from "bun:test";
import { Sandbox } from "../bench/agentic/sandbox.ts";
import {
  evaluateScenario,
  getSandboxFileSnapshot,
  type RubricOutcome,
  type ScenarioEvaluationResult
} from "../bench/agentic/evaluation.ts";
import {
  checkDockerPrerequisite,
  evaluatePacmanInContainer,
  generatePacmanEvalRunnerScript
} from "../bench/agentic/eval/playwright-eval.ts";
import {
  buildAuditReportTestCases,
  evaluateAssertion,
  runPromptfooOfflineAssertions
} from "../bench/agentic/eval/promptfoo-eval.ts";
import {
  MEMORY_NEEDLES,
  PACMAN_FEATURES,
  PLANTED_VULNS,
  SCENARIO_REGISTRY
} from "../bench/agentic/scenarios.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestSandbox(): { sandbox: Sandbox; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "origami-eval-test-"));
  const sandbox = new Sandbox(dir);
  return {
    sandbox,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

describe("Benchmark Evaluation Engine", () => {
  test("PACMAN_FEATURES exposes all 15 named criteria", () => {
    expect(PACMAN_FEATURES.length).toBe(15);
    const ids = PACMAN_FEATURES.map((f) => f.id);
    expect(ids).toContain("canvas");
    expect(ids).toContain("maze");
    expect(ids).toContain("pacman");
    expect(ids).toContain("pellets");
    expect(ids).toContain("power-pellets");
    expect(ids).toContain("ghost-blinky");
    expect(ids).toContain("ghost-pinky");
    expect(ids).toContain("ghost-inky");
    expect(ids).toContain("ghost-clyde");
    expect(ids).toContain("lives");
    expect(ids).toContain("levels");
    expect(ids).toContain("high-score");
    expect(ids).toContain("audio");
    expect(ids).toContain("controls");
    expect(ids).toContain("game-over");
  });

  test("A keyword-only file MUST NOT pass the Pac-Man evaluation", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      // Create a keyword-stuffed file that would have tricked the old regex/keyword rubric
      sandbox.write(
        "index.html",
        `<!DOCTYPE html>
<html>
<head><title>Fake Pacman</title></head>
<body>
  <!-- canvas requestAnimationFrame maze grid wall map pacman move speed pellet dot score -->
  <script src="game.js"></script>
</body>
</html>`
      );

      sandbox.write(
        "game.js",
        `// canvas requestAnimationFrame
// maze grid wall map
// pacman direction move speed
// pellet dot score
// power energizer frightened blue
// blinky red target chase
// pinky pink ambush ahead
// inky cyan flank vector
// clyde orange distance scatter
// lives death respawn reset
// level nextLevel difficulty clear
// localStorage highScore best
// AudioContext sound beep sfx
// ArrowUp ArrowDown KeyW KeyA addEventListener
// game over win victory restart
const fakeCanvas = "canvas";
const fakeAudio = "AudioContext";
`
      );

      // Hermetic invariant: without container verification, unverifiable criteria
      // must report "unavailable" and must NEVER credit keyword stuffing as "passed".
      // (Functional rejection by a real container lives in the e2e-gated test below.)
      const res = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.programming,
        sandbox,
        skipContainer: true
      });

      expect(res.rubricTotalCount).toBe(15);
      expect(res.rubricPassedCount).toBe(0);
      for (const item of res.rubricDetails) {
        expect(item.status).toBe("unavailable");
        expect(item.passed).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test.skipIf(!process.env.ORIGAMI_PACMAN_CONTAINER_E2E)(
    "e2e: keyword-only Pac-Man file is functionally rejected by the container evaluator",
    async () => {
      const { sandbox, cleanup } = createTestSandbox();
      try {
        sandbox.write("index.html", `<!DOCTYPE html><html><body><!-- canvas requestAnimationFrame maze grid wall map pacman pellet dot score --><script src="game.js"></script></body></html>`);
        sandbox.write("game.js", `// canvas requestAnimationFrame maze grid wall map pacman direction move speed pellet dot score power energizer frightened blue blinky pinky inky clyde lives death respawn reset level nextLevel difficulty clear localStorage highScore best AudioContext sound beep sfx ArrowUp ArrowDown KeyW KeyA addEventListener game over win victory restart\nconst fakeCanvas = "canvas";`);

        const res = await evaluateScenario({
          scenario: SCENARIO_REGISTRY.programming,
          sandbox
        });

        // Crucial acceptance invariant: a real functional run must not credit keyword stuffing.
        expect(res.rubricPassedCount).toBe(0);
        if (res.rubricScore !== null) {
          expect(res.rubricScore).toBe(0);
        }
        for (const item of res.rubricDetails) {
          expect(item.passed).toBe(false);
        }
      } finally {
        cleanup();
      }
    },
    300_000
  );

  test("Docker prerequisite check correctly detects availability or reports missing daemon", async () => {
    const prereq = await checkDockerPrerequisite(4000);
    expect(typeof prereq.available).toBe("boolean");
    if (!prereq.available) {
      expect(prereq.error).toBeDefined();
      expect(typeof prereq.error).toBe("string");
    }
  });

  test("When container prerequisite is missing, items are marked 'unavailable' and not fake-passed", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      sandbox.write("index.html", "<h1>Hello</h1>");

      // Test with an invalid/unreachable docker command simulation
      const results = await evaluatePacmanInContainer({
        files: { "index.html": "<h1>Hello</h1>" },
        dockerImage: "non-existent-image-xyz:invalid",
        timeoutMs: 2000
      });

      // All items must exist in results
      expect(Object.keys(results).length).toBe(15);
      for (const feat of PACMAN_FEATURES) {
        const item = results[feat.id]!;
        expect(item.passed).toBe(false);
        expect(["unavailable", "error"]).toContain(item.status);
        expect(item.reason).toBeDefined();
      }
    } finally {
      cleanup();
    }
  });

  test("getSandboxFileSnapshot strictly requires getSnapshot() and fails closed on invalid paths", () => {
    const validObj = {
      getSnapshot: () => ({
        "index.html": "<html></html>",
        "src/game.js": "console.log(1);"
      })
    };
    const validSnap = getSandboxFileSnapshot(validObj as any);
    expect(validSnap["index.html"]).toBe("<html></html>");
    expect(validSnap["src/game.js"]).toBe("console.log(1);");

    // Missing getSnapshot() throws error
    const missingObj = {};
    expect(() => getSandboxFileSnapshot(missingObj as any)).toThrow("getSnapshot");

    // Path traversal with ../ throws error
    const traversalObj = {
      getSnapshot: () => ({ "../escaped.txt": "evil" })
    };
    expect(() => getSandboxFileSnapshot(traversalObj as any)).toThrow("Path traversal");

    // Absolute path throws error
    const absObj = {
      getSnapshot: () => ({ "/etc/passwd": "root" })
    };
    expect(() => getSandboxFileSnapshot(absObj as any)).toThrow("absolute path violation");

    // Null byte throws error
    const nullByteObj = {
      getSnapshot: () => ({ "index.html\0evil": "bad" })
    };
    expect(() => getSandboxFileSnapshot(nullByteObj as any)).toThrow("null byte");
  });

  test("evaluateProgrammingScenario surfaces 'unavailable' status for unverified or missing features", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      sandbox.write("index.html", "<html><body>Pac-Man</body></html>");

      // Without running live Docker, evaluateScenario cleanly catches unavailable container prerequisite
      const res = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.programming,
        sandbox,
        timeoutMs: 1000
      });

      expect(res.rubricTotalCount).toBe(15);
      for (const item of res.rubricDetails) {
        expect(["unavailable", "failed", "error"]).toContain(item.status);
        expect(item.passed).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test("check_work / verifyWorkspace does NOT reveal rubric answers or planted vulnerability secrets", () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      // 1. Programming verifyWorkspace check
      const progChecklist = SCENARIO_REGISTRY.programming.verifyWorkspace(sandbox);
      expect(progChecklist).not.toContain("requestAnimationFrame");
      expect(progChecklist).not.toContain("blinky");
      expect(progChecklist).not.toContain("pinky");
      expect(progChecklist).not.toContain("inky");
      expect(progChecklist).not.toContain("clyde");
      expect(progChecklist).toContain("Pac-Man Workspace Status:");

      // 2. Research verifyWorkspace check
      const resChecklist = SCENARIO_REGISTRY.research.verifyWorkspace(sandbox);
      for (const vuln of PLANTED_VULNS) {
        // Must NOT leak the exact planted vulnerability titles
        expect(resChecklist).not.toContain(vuln.name);
      }
      expect(resChecklist).toContain("Security Audit");

      // 3. Memory verifyWorkspace check
      const memChecklist = SCENARIO_REGISTRY.memory.verifyWorkspace(sandbox);
      for (const needle of MEMORY_NEEDLES) {
        for (const ans of needle.answer) {
          expect(memChecklist).not.toContain(ans);
        }
      }
    } finally {
      cleanup();
    }
  });

  test("Research mode evaluation rejects shallow keyword reports and accepts thorough reports", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      // A shallow report with just the word 'sql' but no explanation or remediation
      sandbox.write(
        "AUDIT_REPORT.md",
        `# Security Report\nWe noticed sql somewhere in the code.\n`
      );

      const shallowRes = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.research,
        sandbox
      });
      // Should reject shallow findings
      expect(shallowRes.rubricPassedCount).toBe(0);

      // Now write a comprehensive audit report covering the planted vulnerabilities
      sandbox.write(
        "AUDIT_REPORT.md",
        `# Application Security Audit Report
## Executive Summary
Thorough security review conducted across all microservice endpoints.

## 1. SQL Injection in src/db/users.js
- File: src/db/users.js
- Root Cause: searchUsers performs raw string concatenation of unsanitized input term into SQL query.
- Severity: High
- Remediation: Implement parameterized query with prepared statement placeholders.

## 2. Path Traversal in src/api/files.js
- File: src/api/files.js
- Root Cause: downloadFile calls path.join with req.query.name allowing traversal via ../ outside the uploads directory.
- Severity: Critical
- Remediation: Sanitize filename with path.basename and validate normalized path with path.resolve against whitelist.

## 3. Command Injection in src/utils/media.js
- File: src/utils/media.js
- Root Cause: convertImage passes unsanitized user-controlled inputPath directly to child_process.exec string.
- Severity: Critical
- Remediation: Replace exec with execFile passing arguments array to avoid shell interpolation.

## 4. Hardcoded Secrets in src/config/auth.js
- File: src/config/auth.js
- Root Cause: Committed JWT_SECRET and AWS credentials in version control.
- Severity: High
- Remediation: Store secrets in environment variables and inject via secrets manager.

## 5. Stored XSS in src/api/comments.js
- File: src/api/comments.js
- Root Cause: renderComment interpolates comment.body directly into HTML markup without escaping.
- Severity: Medium
- Remediation: Sanitize dynamic input and HTML entity encode output before rendering.

## 6. Broken Object Level Authorization (BOLA) in src/api/orders.js
- File: src/api/orders.js
- Root Cause: getOrder retrieves order by id without verifying that the order belongs to the requesting user.
- Severity: High
- Remediation: Verify authenticated user ownership before returning order JSON payload.
`
      );

      const thoroughRes = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.research,
        sandbox
      });

      expect(thoroughRes.rubricPassedCount).toBe(6);
      expect(thoroughRes.rubricScore).toBe(1.0);
      for (const item of thoroughRes.rubricDetails) {
        expect(item.passed).toBe(true);
        expect(item.status).toBe("passed");
      }
    } finally {
      cleanup();
    }
  });

  test("Promptfoo offline assertion engine executes offline assertions cleanly", async () => {
    const testCases = [
      {
        description: "Test contains-all",
        output: "The staging database port is 9432 with replica password Krypton-7729-Beta.",
        assert: [
          { type: "contains-all" as const, value: ["9432", "Krypton-7729-Beta"] }
        ]
      },
      {
        description: "Test icontains-all and regex",
        output: "All API responses include header X-Origin-Zone: eu-west-1a.",
        assert: [
          { type: "icontains-all" as const, value: ["x-origin-zone", "eu-west-1a"] },
          { type: "regex" as const, value: "eu-west-1[a-z]" }
        ]
      },
      {
        description: "Test javascript predicate",
        output: "Deprecation sunset date: 2027-04-15",
        assert: [
          { type: "javascript" as const, value: (out: string) => out.includes("2027-04-15") }
        ]
      }
    ];

    const result = await runPromptfooOfflineAssertions(testCases);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.passedAssertions).toBe(4);
    expect(result.totalAssertions).toBe(4);
  });

  test("Memory task rubric scores shipped workspace deliverables, not recall", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      for (const n of ["a", "b", "c"]) {
        sandbox.write(`src/routing/radix-${n}.ts`, `export class Router${n} {}\n`);
        sandbox.write(`tests/routing/radix-${n}.test.ts`, `import { test } from "bun:test";\ntest("${n}", () => {});\n`);
        sandbox.write(`src/routing/${n}/index.ts`, `export { Router${n} } from "../radix-${n}";\n`);
        sandbox.write(`docs/runbooks/RB-${n}.md`, `# Runbook ${n}\nFailure modes and recovery steps.\n`);
      }

      const res = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.memory,
        sandbox,
        scale: "low"
      });

      // Four deliverable kinds + one secret-hygiene item; all pass on a clean, populated workspace.
      expect(res.rubricTotalCount).toBe(5);
      expect(res.rubricPassedCount).toBe(5);
      expect(res.rubricScore).toBe(1.0);
    } finally {
      cleanup();
    }
  });

  test("Memory rubric fails secret hygiene even when every needle probe would pass", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      for (const n of ["a", "b", "c"]) {
        sandbox.write(`src/routing/radix-${n}.ts`, `export class Router${n} {}\n`);
        sandbox.write(`tests/routing/radix-${n}.test.ts`, `import { test } from "bun:test";\ntest("${n}", () => {});\n`);
        sandbox.write(`src/routing/${n}/index.ts`, `export { Router${n} } from "../radix-${n}";\n`);
        sandbox.write(`docs/runbooks/RB-${n}.md`, `# Runbook ${n}\nFailure modes and recovery steps.\n`);
      }
      // Leak a session-only needle value into the workspace: hygiene must fail.
      sandbox.write("src/routing/config.ts", `export const dbPassword = "Krypton-7729-Beta";\n`);

      const res = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.memory,
        sandbox,
        scale: "low"
      });

      const hygiene = res.rubricDetails.find((r) => r.id === "memory-no-secret-leak");
      expect(hygiene?.status).toBe("failed");
      expect(hygiene?.reason?.toLowerCase()).toContain("krypton-7729-beta");
      expect(res.rubricPassedCount).toBeLessThan(res.rubricTotalCount);
    } finally {
      cleanup();
    }
  });

  test("rubricScore correctly handles nullable contract across evaluable items", async () => {
    const { sandbox, cleanup } = createTestSandbox();
    try {
      // General scenario test
      sandbox.write(
        "src/matrix.ts",
        `export function matrixAdd(a, b) { return a; }\nexport function matrixMultiply(a, b) { return b; }`
      );
      sandbox.write(
        "docs/ARCHITECTURE.md",
        `# Architecture Documentation\nThis system implements a comprehensive high-performance matrix math engine supporting dense and sparse matrix representation with multiplication and addition algorithms.`
      );
      sandbox.write(
        "tests/matrix.test.ts",
        `import { test, expect } from "bun:test";\ntest("matrix add", () => { expect(1).toBe(1); });`
      );

      const res = await evaluateScenario({
        scenario: SCENARIO_REGISTRY.general,
        sandbox
      });

      expect(res.evaluableCount).toBe(3);
      expect(res.rubricPassedCount).toBe(3);
      expect(res.rubricScore).toBe(1.0);
    } finally {
      cleanup();
    }
  });
});
