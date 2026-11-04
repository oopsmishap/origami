/**
 * Benchmark-only async evaluation engine.
 *
 * Replaces keyword-only rubrics with functional, isolated evaluation:
 * - Programming mode: Runs in-browser Playwright tests strictly inside an isolated
 *   Docker container (--network none, unprivileged, read-only root) evaluating
 *   15 functional Pac-Man criteria. Missing Docker prerequisite reports
 *   status: "unavailable" (never fake-pass, never run untrusted code on host browser).
 * - Research mode: Validates security audit findings for component, flaw, and
 *   remediation patch completeness, with optional offline Promptfoo assertion layer.
 * - General mode: Validates TypeScript matrix math modules, architecture docs, and tests.
 * - Memory mode: Validates exact/normalized needle recall across session probes.
 * - All mode: Evaluates all four disciplines with combined scoring.
 */

import { Sandbox } from "./sandbox.ts";
import {
  MEMORY_NEEDLE_CATALOG,
  PACMAN_FEATURES,
  PLANTED_VULNS,
  type ContextScale,
  type ScenarioDefinition,
  type ScenarioMode
} from "./scenarios.ts";
import {
  checkDockerPrerequisite,
  evaluatePacmanInContainer,
  type PlaywrightFeatureResult
} from "./eval/playwright-eval.ts";
import {
  buildAuditReportTestCases,
  runPromptfooOfflineAssertions
} from "./eval/promptfoo-eval.ts";

export type RubricItemStatus = "passed" | "failed" | "unavailable" | "error";

export interface RubricOutcome {
  id: string;
  name: string;
  weight: number;
  passed: boolean;
  status: RubricItemStatus;
  reason?: string;
  durationMs?: number;
}

export interface ScenarioEvaluationResult {
  rubricScore: number | null;
  rubricPassedCount: number;
  rubricFailedCount: number;
  rubricTotalCount: number;
  evaluableCount: number;
  unavailableCount: number;
  errorCount: number;
  rubricDetails: RubricOutcome[];
  prerequisites: {
    containerRuntimeAvailable: boolean;
    containerRuntimeError?: string;
    promptfooAvailable: boolean;
  };
}

export interface ScenarioEvaluationOptions {
  scenario: ScenarioDefinition;
  scale?: ContextScale;
  sandbox: Sandbox;
  timeoutMs?: number;
  usePromptfoo?: boolean;
}

/**
 * Extracts a map of relative file paths to string contents from Sandbox.
 * Directly requires canonical sandbox.getSnapshot() and fails closed on invalid paths.
 */
export function getSandboxFileSnapshot(sandbox: Sandbox): Record<string, string> {
  const custom = sandbox as unknown as { getSnapshot?: () => Record<string, string> };

  if (typeof custom.getSnapshot !== "function") {
    throw new Error("Sandbox does not implement required canonical getSnapshot() method");
  }

  const snapshot = custom.getSnapshot();
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Sandbox getSnapshot() returned an invalid non-object snapshot");
  }

  // Fail closed on invalid snapshot paths
  for (const p of Object.keys(snapshot)) {
    if (typeof p !== "string" || !p.trim()) {
      throw new Error("Invalid empty or non-string path in sandbox snapshot");
    }
    if (p.includes("\0")) {
      throw new Error(`Invalid null byte in sandbox snapshot path: ${p}`);
    }
    const normalized = p.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
      throw new Error(`Path traversal or absolute path violation in sandbox snapshot: ${p}`);
    }
  }

  return snapshot;
}

/**
 * Async evaluator for the programming scenario (Pac-Man 15 criteria).
 */
async function evaluateProgrammingScenario(
  sandbox: Sandbox,
  timeoutMs = 30000
): Promise<{ details: RubricOutcome[]; containerAvailable: boolean; containerError?: string }> {
  const files = getSandboxFileSnapshot(sandbox);
  const prereq = await checkDockerPrerequisite();

  if (!prereq.available) {
    const details: RubricOutcome[] = PACMAN_FEATURES.map((feat) => ({
      id: feat.id,
      name: feat.name,
      weight: 1,
      passed: false,
      status: "unavailable",
      reason: prereq.error ?? "Docker daemon unavailable: isolated container execution required"
    }));
    return { details, containerAvailable: false, containerError: prereq.error };
  }

  const containerResults = await evaluatePacmanInContainer({
    files,
    timeoutMs
  });

  const details: RubricOutcome[] = PACMAN_FEATURES.map((feat) => {
    const res: PlaywrightFeatureResult = containerResults[feat.id] ?? {
      passed: false,
      status: "unavailable",
      reason: "Feature not evaluated by container runner"
    };

    return {
      id: feat.id,
      name: feat.name,
      weight: 1,
      passed: res.passed,
      status: res.status,
      reason: res.reason,
      durationMs: res.durationMs
    };
  });
  return { details, containerAvailable: true };
}

/**
 * Async evaluator for research mode (AUDIT_REPORT.md).
 */
async function evaluateResearchScenario(
  sandbox: Sandbox,
  usePromptfoo?: boolean
): Promise<{ details: RubricOutcome[]; promptfooUsed: boolean }> {
  let report = "";
  try {
    report = sandbox.exists("AUDIT_REPORT.md") ? sandbox.read("AUDIT_REPORT.md") : "";
  } catch {
    report = "";
  }

  if (usePromptfoo) {
    if (!report.trim()) {
      return {
        details: PLANTED_VULNS.map((vuln) => ({
          id: vuln.id,
          name: vuln.name,
          weight: 1,
          passed: false,
          status: "failed",
          reason: "AUDIT_REPORT.md not generated in workspace"
        })),
        promptfooUsed: false
      };
    }

    try {
      const testCases = buildAuditReportTestCases(report);
      const pfEval = await runPromptfooOfflineAssertions(testCases);
      return {
        details: PLANTED_VULNS.map((vuln) => {
          const fileName = vuln.file.split("/").pop()!;
          const matched = pfEval.results.filter((r) => r.description.includes(fileName));
          const passed = matched.length > 0 && matched.every((r) => r.passed);
          const failedReason = matched.find((r) => !r.passed)?.reason;
          return {
            id: vuln.id,
            name: vuln.name,
            weight: 1,
            passed,
            status: matched.length > 0 ? (passed ? "passed" : "failed") : "unavailable",
            reason: failedReason
          };
        }),
        promptfooUsed: true
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        details: PLANTED_VULNS.map((vuln) => ({
          id: vuln.id,
          name: vuln.name,
          weight: 1,
          passed: false,
          status: "error",
          reason: `Promptfoo evaluation failed: ${errorMsg}`
        })),
        promptfooUsed: false
      };
    }
  }
  const promptfooUsed = false;
  const lowerReport = report.toLowerCase();

  const details: RubricOutcome[] = PLANTED_VULNS.map((vuln) => {
    if (!report.trim()) {
      return {
        id: vuln.id,
        name: vuln.name,
        weight: 1,
        passed: false,
        status: "failed",
        reason: "AUDIT_REPORT.md not generated in workspace"
      };
    }

    // Comprehensive finding evaluation: must mention file, root cause, and remediation
    const fileName = vuln.file.split("/").pop()!.toLowerCase();
    const mentionsFile = lowerReport.includes(fileName) || lowerReport.includes(vuln.file.toLowerCase());

    let flawIdentified = false;
    let remediationIdentified = false;

    switch (vuln.id) {
      case "vuln-sql":
        flawIdentified = lowerReport.includes("sql") && (lowerReport.includes("inject") || lowerReport.includes("concatenat") || lowerReport.includes("raw"));
        remediationIdentified = lowerReport.includes("parameter") || lowerReport.includes("prepared") || lowerReport.includes("placeholder");
        break;
      case "vuln-traversal":
        flawIdentified = (lowerReport.includes("traversal") || lowerReport.includes("path")) && (lowerReport.includes("../") || lowerReport.includes("directory"));
        remediationIdentified = lowerReport.includes("resolve") || lowerReport.includes("basename") || lowerReport.includes("sanitiz") || lowerReport.includes("whitelist");
        break;
      case "vuln-rce":
        flawIdentified = (lowerReport.includes("command") || lowerReport.includes("exec") || lowerReport.includes("rce")) && lowerReport.includes("media");
        remediationIdentified = lowerReport.includes("execfile") || lowerReport.includes("spawn") || lowerReport.includes("array") || lowerReport.includes("escape");
        break;
      case "vuln-secret":
        flawIdentified = (lowerReport.includes("secret") || lowerReport.includes("jwt") || lowerReport.includes("hardcoded") || lowerReport.includes("key")) && lowerReport.includes("auth");
        remediationIdentified = lowerReport.includes("env") || lowerReport.includes("variable") || lowerReport.includes("vault") || lowerReport.includes("secrets manager");
        break;
      case "vuln-xss":
        flawIdentified = (lowerReport.includes("xss") || lowerReport.includes("script") || lowerReport.includes("cross-site")) && lowerReport.includes("comment");
        remediationIdentified = lowerReport.includes("escape") || lowerReport.includes("sanitize") || lowerReport.includes("encode") || lowerReport.includes("dompurify");
        break;
      case "vuln-auth":
        flawIdentified = (lowerReport.includes("bola") || lowerReport.includes("idor") || lowerReport.includes("authorization") || lowerReport.includes("ownership")) && lowerReport.includes("order");
        remediationIdentified = lowerReport.includes("user") || lowerReport.includes("auth") || lowerReport.includes("check") || lowerReport.includes("verify");
        break;
    }

    const passed = mentionsFile && flawIdentified && remediationIdentified;
    let reason: string | undefined;
    if (!passed) {
      if (!mentionsFile) reason = `Finding does not reference vulnerable file ${vuln.file}`;
      else if (!flawIdentified) reason = "Vulnerability root cause not accurately identified";
      else reason = "Remediation patch or secure coding guidance missing";
    }

    return {
      id: vuln.id,
      name: vuln.name,
      weight: 1,
      passed,
      status: passed ? "passed" : "failed",
      reason
    };
  });

  return { details, promptfooUsed };
}

/**
 * Async evaluator for general mode (matrix math module).
 */
function evaluateGeneralScenario(sandbox: Sandbox): RubricOutcome[] {
  const details: RubricOutcome[] = [];

  // 1. Matrix Module Created
  let matrixPassed = false;
  let matrixReason: string | undefined;
  if (!sandbox.exists("src/matrix.ts")) {
    matrixReason = "src/matrix.ts was not created";
  } else {
    try {
      const code = sandbox.read("src/matrix.ts").toLowerCase();
      const hasAdd = code.includes("matrixadd") || code.includes("add(");
      const hasMul = code.includes("matrixmultiply") || code.includes("multiply(");
      matrixPassed = hasAdd && hasMul;
      if (!matrixPassed) matrixReason = "src/matrix.ts does not export matrixAdd and matrixMultiply";
    } catch (e: unknown) {
      matrixReason = e instanceof Error ? e.message : String(e);
    }
  }
  details.push({
    id: "matrix-math",
    name: "Matrix Module Created",
    weight: 1,
    passed: matrixPassed,
    status: matrixPassed ? "passed" : "failed",
    reason: matrixReason
  });

  // 2. Architecture Documentation Updated
  let docPassed = false;
  let docReason: string | undefined;
  if (!sandbox.exists("docs/ARCHITECTURE.md")) {
    docReason = "docs/ARCHITECTURE.md not found";
  } else {
    try {
      const doc = sandbox.read("docs/ARCHITECTURE.md");
      docPassed = doc.length > 150 && (doc.includes("matrix") || doc.includes("Matrix"));
      if (!docPassed) docReason = "docs/ARCHITECTURE.md does not document matrix math architecture";
    } catch (e: unknown) {
      docReason = e instanceof Error ? e.message : String(e);
    }
  }
  details.push({
    id: "architecture-docs",
    name: "Architecture Documentation Updated",
    weight: 1,
    passed: docPassed,
    status: docPassed ? "passed" : "failed",
    reason: docReason
  });

  // 3. Unit Tests Added
  let testsPassed = false;
  let testsReason: string | undefined;
  if (!sandbox.exists("tests/matrix.test.ts")) {
    testsReason = "tests/matrix.test.ts was not created";
  } else {
    try {
      const tests = sandbox.read("tests/matrix.test.ts");
      testsPassed = tests.length > 50 && (tests.includes("test(") || tests.includes("it(") || tests.includes("describe("));
      if (!testsPassed) testsReason = "tests/matrix.test.ts lacks test suites";
    } catch (e: unknown) {
      testsReason = e instanceof Error ? e.message : String(e);
    }
  }
  details.push({
    id: "unit-tests",
    name: "Unit Tests Added",
    weight: 1,
    passed: testsPassed,
    status: testsPassed ? "passed" : "failed",
    reason: testsReason
  });

  return details;
}

/**
 * Memory-mode Task Rubric: workspace deliverables + session-secret hygiene.
 *
 * Recall quality is scored separately as Probe Recall (needle probes only), so the
 * task rubric reports what the run actually shipped: platform modules, unit tests,
 * domain barrel exports, and operational runbooks — plus a leak scan asserting no
 * session-only needle value was written into workspace files.
 *
 * Deliverable items are scale-aware: kinds the scenario never schedules at the
 * chosen scale report `unavailable` (excluded from the score) instead of failing
 * work that was never assigned.
 */
const DELIVERABLE_MATCHERS: Record<MemoryDeliverableKind, RegExp> = {
  modules: /`src\/[^`]+\.[tj]s`/,
  tests: /`tests\/[^`]+\.(?:test|spec)\.[tj]s`/,
  barrels: /`src\/[^`]+\/index\.[tj]s`/,
  docs: /`docs\/(?:runbooks|rfcs|advisories)\/[^`]+`/
};

export type MemoryDeliverableKind = "modules" | "tests" | "barrels" | "docs";

/** Needle strings distinctive enough to grep without false positives (no bare numbers). */
export function distinctiveNeedleStrings(): string[] {
  const out = new Set<string>();
  for (const n of MEMORY_NEEDLE_CATALOG) {
    for (const value of [...n.expectedKeywords, ...(n.staleKeywords ?? []), ...n.answer]) {
      const t = value.trim();
      if (t.length >= 5 && !/^\d+$/.test(t)) out.add(t.toLowerCase());
    }
  }
  return [...out];
}

function findNeedleLeaks(files: Record<string, string>): string[] {
  const secrets = distinctiveNeedleStrings();
  const leaks: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const lower = content.toLowerCase();
    for (const secret of secrets) {
      if (lower.includes(secret)) leaks.push(`${path}: ${secret}`);
    }
  }
  return leaks;
}

function evaluateMemoryWorkspaceScenario(
  sandbox: Sandbox,
  scenario: ScenarioDefinition,
  scale: ContextScale
): RubricOutcome[] {
  const files = getSandboxFileSnapshot(sandbox);
  const paths = Object.keys(files);

  const scheduled: Record<MemoryDeliverableKind, number> = { modules: 0, tests: 0, barrels: 0, docs: 0 };
  for (const turn of scenario.generateTurns(scale)) {
    for (const kind of Object.keys(scheduled) as MemoryDeliverableKind[]) {
      if (DELIVERABLE_MATCHERS[kind].test(turn.userMessage)) scheduled[kind]++;
    }
  }

  const isModule = (p: string) => /(^src\/).*\.[tj]s$/.test(p) && !/(^|\/)index\.[tj]s$/.test(p) && p !== "src/service.ts";
  const created: Record<MemoryDeliverableKind, string[]> = {
    modules: paths.filter(isModule),
    tests: paths.filter((p) => /(^tests\/).*\.(?:test|spec)\.[tj]s$/.test(p)),
    barrels: paths.filter((p) => /(^src\/).*\/index\.[tj]s$/.test(p) && /\bexport\b/.test(files[p] ?? "")),
    docs: paths.filter((p) => /(^docs\/)(?:runbooks|rfcs|advisories)\/.*\.md$/.test(p))
  };

  const details: RubricOutcome[] = [];
  const names: Record<MemoryDeliverableKind, string> = {
    modules: "Platform Modules Implemented",
    tests: "Platform Unit Tests Added",
    barrels: "Domain Barrel Exports Wired",
    docs: "Operational Docs Authored"
  };
  for (const kind of Object.keys(scheduled) as MemoryDeliverableKind[]) {
    const want = Math.min(scheduled[kind]!, 3);
    const got = created[kind]!.length;
    if (want === 0) {
      details.push({
        id: `memory-${kind}`,
        name: names[kind],
        weight: 1,
        passed: false,
        status: "unavailable",
        reason: `not scheduled at scale "${scale}"`
      });
      continue;
    }
    const passed = got >= want;
    details.push({
      id: `memory-${kind}`,
      name: names[kind],
      weight: 1,
      passed,
      status: passed ? "passed" : "failed",
      reason: passed ? undefined : `created ${got} of ${want} expected ${kind}`
    });
  }

  const leaks = findNeedleLeaks(files);
  details.push({
    id: "memory-no-secret-leak",
    name: "Session Needles Kept Out of Workspace Files",
    weight: 1,
    passed: leaks.length === 0,
    status: leaks.length === 0 ? "passed" : "failed",
    reason: leaks.length === 0 ? undefined : `leaked session-only values: ${leaks.slice(0, 5).join(", ")}`
  });

  return details;
}

/**
 * Main evaluation entrypoint called by AgentRunner.
 */
export async function evaluateScenario(options: ScenarioEvaluationOptions): Promise<ScenarioEvaluationResult> {
  const mode = options.scenario.mode;
  let rubricDetails: RubricOutcome[] = [];
  let containerRuntimeAvailable = false;
  let containerRuntimeError: string | undefined;
  let promptfooAvailable = false;

  switch (mode) {
    case "programming": {
      const prog = await evaluateProgrammingScenario(options.sandbox, options.timeoutMs);
      rubricDetails = prog.details;
      containerRuntimeAvailable = prog.containerAvailable;
      containerRuntimeError = prog.containerError;
      break;
    }

    case "research": {
      const res = await evaluateResearchScenario(options.sandbox, options.usePromptfoo);
      rubricDetails = res.details;
      promptfooAvailable = res.promptfooUsed;
      break;
    }

    case "general": {
      rubricDetails = evaluateGeneralScenario(options.sandbox);
      break;
    }

    case "memory": {
      rubricDetails = evaluateMemoryWorkspaceScenario(options.sandbox, options.scenario, options.scale ?? "marathon");
      break;
    }

    case "all": {
      const prog = await evaluateProgrammingScenario(options.sandbox, options.timeoutMs);
      containerRuntimeAvailable = prog.containerAvailable;
      containerRuntimeError = prog.containerError;

      const res = await evaluateResearchScenario(options.sandbox, options.usePromptfoo);
      promptfooAvailable = res.promptfooUsed;

      const gen = evaluateGeneralScenario(options.sandbox);
      const mem = evaluateMemoryWorkspaceScenario(options.sandbox, options.scenario, options.scale ?? "marathon");

      rubricDetails = [
        ...prog.details,
        ...res.details,
        ...gen,
        ...mem
      ];
      break;
    }
  }

  const rubricTotalCount = rubricDetails.length;
  const evaluableItems = rubricDetails.filter((r) => r.status === "passed" || r.status === "failed");
  const evaluableCount = evaluableItems.length;
  const rubricPassedCount = rubricDetails.filter((r) => r.passed).length;
  const rubricFailedCount = rubricDetails.filter((r) => r.status === "failed").length;
  const unavailableCount = rubricDetails.filter((r) => r.status === "unavailable").length;
  const errorCount = rubricDetails.filter((r) => r.status === "error").length;

  const evaluableTotalWeight = evaluableItems.reduce((sum, item) => sum + item.weight, 0);
  const evaluablePassedWeight = evaluableItems.filter((item) => item.passed).reduce((sum, item) => sum + item.weight, 0);
  const rubricScore = evaluableCount > 0 && evaluableTotalWeight > 0
    ? evaluablePassedWeight / evaluableTotalWeight
    : null;

  return {
    rubricScore,
    rubricPassedCount,
    rubricFailedCount,
    rubricTotalCount,
    evaluableCount,
    unavailableCount,
    errorCount,
    rubricDetails,
    prerequisites: {
      containerRuntimeAvailable,
      containerRuntimeError,
      promptfooAvailable
    }
  };
}
