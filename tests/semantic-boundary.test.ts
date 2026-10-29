import { describe, expect, it } from "bun:test";
import { detectSemanticSeams, sliceRunBySemanticSeams } from "../src/kernel/semantic-boundary.ts";
import { recommendRanges, type RecommendBoundMessage } from "../src/kernel/nudge.ts";

describe("Semantic Boundary Detection", () => {
  it("detects git commit deliverables, test suite passes, todo done, and turn boundaries", () => {
    const bound: RecommendBoundMessage[] = [
      {
        ref: "m00001",
        ephemeral: false,
        turn: 1,
        tokens: 100,
        tool: false,
        role: "user",
        text: "Please implement feature X and verify",
      },
      {
        ref: "m00002",
        ephemeral: false,
        turn: 1,
        tokens: 300,
        tool: false,
        role: "assistant",
        text: 'bash {"command":"git commit -m \'feat: add X\'"}',
        toolCalls: [{ id: "c1", name: "bash" }],
      },
      {
        ref: "m00003",
        ephemeral: false,
        turn: 1,
        tokens: 150,
        tool: true,
        role: "toolResult",
        toolCallId: "c1",
        text: "[master 3b038b3] feat: add X\n 2 files changed, 45 insertions(+)",
        isError: false,
      },
      {
        ref: "m00004",
        ephemeral: false,
        turn: 1,
        tokens: 200,
        tool: true,
        role: "toolResult",
        text: "bun test v1.3.11\n 45 pass\n 0 fail\nRan 45 tests across 3 files. [1.2s]",
        isError: false,
      },
      {
        ref: "m00005",
        ephemeral: false,
        turn: 1,
        tokens: 120,
        tool: false,
        role: "assistant",
        text: 'todo {"op":"done","task":"Implement feature X"}',
        toolCalls: [{ id: "c2", name: "todo" }],
      },
      {
        ref: "m00006",
        ephemeral: false,
        turn: 1,
        tokens: 180,
        tool: false,
        role: "assistant",
        text: "Feature X has been implemented, committed, and verified with all tests passing.",
      },
      {
        ref: "m00007",
        ephemeral: false,
        turn: 2,
        tokens: 80,
        tool: false,
        role: "user",
        text: "Now refactor the logging module",
      },
      {
        ref: "m00008",
        ephemeral: false,
        turn: 2,
        tokens: 250,
        tool: false,
        role: "assistant",
        text: "I am refactoring the logging module now.",
      },
    ];

    const seams = detectSemanticSeams(bound);
    expect(seams.length).toBeGreaterThanOrEqual(4);

    const commitSeam = seams.find((s) => s.kind === "commit");
    expect(commitSeam).toBeDefined();
    expect(commitSeam?.ref).toBe("m00003");
    expect(commitSeam?.score).toBe(100);

    const testPassSeam = seams.find((s) => s.kind === "test_pass");
    expect(testPassSeam).toBeDefined();
    expect(testPassSeam?.ref).toBe("m00004");
    expect(testPassSeam?.score).toBe(90);

    const todoSeam = seams.find((s) => s.kind === "todo_done");
    expect(todoSeam).toBeDefined();
    expect(todoSeam?.ref).toBe("m00005");
    expect(todoSeam?.score).toBe(80);

    const turnSeam = seams.find((s) => s.kind === "turn_end");
    expect(turnSeam).toBeDefined();
    expect(turnSeam?.ref).toBe("m00006");
    expect(turnSeam?.turn).toBe(1);
  });

  it("sliceRunBySemanticSeams returns sub-ranges when run exceeds token threshold with valid seams", () => {
    const bound: RecommendBoundMessage[] = [
      { ref: "m00001", ephemeral: false, turn: 1, tokens: 6000, tool: false, role: "user" },
      { ref: "m00002", ephemeral: false, turn: 1, tokens: 6000, tool: true, role: "toolResult", text: "[main 1a2b3c4] add feature\n 3 files changed" },
      { ref: "m00003", ephemeral: false, turn: 2, tokens: 6000, tool: false, role: "user" },
      { ref: "m00004", ephemeral: false, turn: 2, tokens: 6000, tool: false, role: "assistant" },
    ];

    // Total tokens: 24,000. Slicing with minSliceTokens = 8,000.
    const slices = sliceRunBySemanticSeams({ startIdx: 0, endIdx: 3 }, bound, 8000);
    expect(slices.length).toBeGreaterThan(1);
    // Slices contain full run [0, 3], first milestone [0, 1], and second milestone [2, 3]
    expect(slices).toContainEqual({ startIdx: 0, endIdx: 3 });
    expect(slices).toContainEqual({ startIdx: 0, endIdx: 1 });
    expect(slices).toContainEqual({ startIdx: 2, endIdx: 3 });
  });

  it("sliceRunBySemanticSeams keeps single run when token mass is too small to divide", () => {
    const bound: RecommendBoundMessage[] = [
      { ref: "m00001", ephemeral: false, turn: 1, tokens: 1000, tool: false, role: "user" },
      { ref: "m00002", ephemeral: false, turn: 1, tokens: 2000, tool: true, role: "toolResult", text: "[main 1a2b3c4] commit" },
      { ref: "m00003", ephemeral: false, turn: 2, tokens: 1000, tool: false, role: "user" },
    ];

    // Total tokens: 4,000. minSliceTokens = 8,000 -> does not slice
    const slices = sliceRunBySemanticSeams({ startIdx: 0, endIdx: 2 }, bound, 8000);
    expect(slices).toEqual([{ startIdx: 0, endIdx: 2 }]);
  });

  it("recommendRanges surfaces both full run and semantic sub-ranges while respecting boundaries", () => {
    const bound: RecommendBoundMessage[] = [
      { ref: "m00001", ephemeral: false, turn: 1, tokens: 10000, tool: false, role: "user" },
      { ref: "m00002", ephemeral: false, turn: 1, tokens: 10000, tool: true, role: "toolResult", text: "[master 4f8a192] deliver milestone 1" },
      { ref: "m00003", ephemeral: false, turn: 2, tokens: 10000, tool: false, role: "user" },
      { ref: "m00004", ephemeral: false, turn: 2, tokens: 10000, tool: false, role: "assistant" },
      // Protected turn 3
      { ref: "m00005", ephemeral: false, turn: 3, tokens: 5000, tool: false, role: "user" },
    ];

    const ranges = recommendRanges({
      bound,
      foldedRefs: new Set(),
      protectedFromTurn: 3,
      minSliceTokens: 8000,
    });

    expect(ranges.length).toBeGreaterThanOrEqual(2);
    const fullRange = ranges.find((r) => r.start === "m00001" && r.end === "m00004");
    expect(fullRange).toBeDefined();
    expect(fullRange?.tokens).toBe(40000);

    const subRange1 = ranges.find((r) => r.start === "m00001" && r.end === "m00002");
    expect(subRange1).toBeDefined();
    expect(subRange1?.tokens).toBe(20000);

    const subRange2 = ranges.find((r) => r.start === "m00003" && r.end === "m00004");
    expect(subRange2).toBeDefined();
    expect(subRange2?.tokens).toBe(20000);
  });
});
