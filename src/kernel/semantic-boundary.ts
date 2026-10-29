import type { RecommendBoundMessage } from "./nudge.ts";

export type SemanticSeamKind = "commit" | "test_pass" | "todo_done" | "turn_end";

export interface SemanticSeam {
  /** Index in the bound message array representing the last message of the completed semantic unit. */
  index: number;
  ref: string;
  turn: number;
  kind: SemanticSeamKind;
  score: number;
  description: string;
}

const COMMIT_REGEX = /(?:\[[\w/.-]+\s+[0-9a-f]{7,40}\]|commit\s+[0-9a-f]{7,40}|\d+\s+files?\s+changed,\s+\d+\s+insertions?)/i;
const TEST_PASS_REGEX = /(?:\b0\s+fail(?:ed)?\b|\ball\s+tests?\s+pass(?:ed)?\b|\b[1-9]\d*\s+passed?,\s+0\s+fail(?:ed)?\b)/i;

/**
 * Scan a message slice to detect natural developer milestone boundaries:
 * 1. Git commits (checked-in code deliverables).
 * 2. Test suite passes (verified green implementations).
 * 3. Todo / task completions (declared milestone completion).
 * 4. User turn boundaries (clean conversational inquiry-to-resolution endpoints).
 */
export function detectSemanticSeams(bound: readonly RecommendBoundMessage[]): SemanticSeam[] {
  const seams: SemanticSeam[] = [];

  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    if (m.ephemeral) continue;

    // 1. Git Commit detection on toolResult or assistant text
    if (m.text && COMMIT_REGEX.test(m.text) && !m.isError) {
      seams.push({
        index: i,
        ref: m.ref,
        turn: m.turn,
        kind: "commit",
        score: 100,
        description: `git commit deliverable at turn ${m.turn}`,
      });
      continue;
    }

    // 2. Test Pass detection on toolResult
    if (m.tool && m.text && TEST_PASS_REGEX.test(m.text) && !m.isError) {
      seams.push({
        index: i,
        ref: m.ref,
        turn: m.turn,
        kind: "test_pass",
        score: 90,
        description: `verified test suite pass at turn ${m.turn}`,
      });
      continue;
    }

    // 3. Todo completion detection on assistant tool calls
    if (m.toolCalls && m.toolCalls.some((tc) => tc.name === "todo" && typeof m.text === "string" && m.text.includes('"done"'))) {
      seams.push({
        index: i,
        ref: m.ref,
        turn: m.turn,
        kind: "todo_done",
        score: 80,
        description: `task milestone completion at turn ${m.turn}`,
      });
      continue;
    }

    // 4. Turn Boundary: transition where the NEXT message is a new user turn
    const next = bound[i + 1];
    if (next && !next.ephemeral && next.turn > m.turn && next.role === "user") {
      seams.push({
        index: i,
        ref: m.ref,
        turn: m.turn,
        kind: "turn_end",
        score: 50,
        description: `turn ${m.turn} completion before user turn ${next.turn}`,
      });
    }
  }

  return seams;
}

/**
 * Given a raw contiguous run of foldable indices, evaluate whether semantic seams
 * warrant providing sub-range slices (e.g. individual cohesive milestones) alongside the full run.
 */
export function sliceRunBySemanticSeams(
  run: { startIdx: number; endIdx: number },
  bound: readonly RecommendBoundMessage[],
  minSliceTokens = 8000,
): { startIdx: number; endIdx: number }[] {
  const result: { startIdx: number; endIdx: number }[] = [{ ...run }];
  const seams = detectSemanticSeams(bound).filter((s) => s.index >= run.startIdx && s.index < run.endIdx);

  if (seams.length === 0) return result;

  // Filter seams that leave meaningful token mass on both sides
  let runTokens = 0;
  for (let k = run.startIdx; k <= run.endIdx; k++) runTokens += bound[k]?.tokens ?? 0;

  // Only slice if the full run exceeds 1.5x the minimum slice tokens
  if (runTokens < minSliceTokens * 1.5) return result;

  // Pick high-scoring seams that divide the run into substantial slices
  const candidateSeamIndices: number[] = [];
  let accumulatedTokens = 0;

  for (let k = run.startIdx; k <= run.endIdx; k++) {
    accumulatedTokens += bound[k]?.tokens ?? 0;
    const seamAtK = seams.find((s) => s.index === k);
    if (seamAtK) {
      const remainingTokens = runTokens - accumulatedTokens;
      if (accumulatedTokens >= minSliceTokens && remainingTokens >= minSliceTokens) {
        candidateSeamIndices.push(k);
      }
    }
  }

  // Generate milestone slices for viable seam points
  for (const seamIdx of candidateSeamIndices) {
    result.push({ startIdx: run.startIdx, endIdx: seamIdx });
    result.push({ startIdx: seamIdx + 1, endIdx: run.endIdx });
  }

  return result;
}
