import { describe, expect, it } from "bun:test";
import { detectUncoveredRuns } from "../src/kernel/project-unit.ts";
import type { BoundMessage, KernelRole } from "../src/kernel/types.ts";
import { parseRef } from "../src/kernel/types.ts";

function msg(ref: string, turn: number, tokens = 100, role: KernelRole = "user"): BoundMessage {
  return {
    ref,
    turn,
    role,
    index: parseRef(ref),
    ephemeral: false,
    contentHash: "hash-" + ref,
    signedThinking: false,
    text: "text",
    prose: "text",
    isError: false,
    bytes: tokens * 4,
  };
}

describe("detectUncoveredRuns (Billion-Context #4331, uncovered.ts)", () => {
  it("detects stranded mid-history gaps between active fold blocks", () => {
    // History: m00001 (pinned head, turn 0)
    //          m00002..m00003 (block b1, turn 1)
    //          m00004..m00005 (stranded gap, turn 2)
    //          m00006..m00007 (block b2, turn 3)
    //          m00008..m00009 (protected tail, turn 4)
    const bound: BoundMessage[] = [
      msg("m00001", 0, 150),
      msg("m00002", 1, 200),
      msg("m00003", 1, 200),
      msg("m00004", 2, 300),
      msg("m00005", 2, 400),
      msg("m00006", 3, 250),
      msg("m00007", 3, 250),
      msg("m00008", 4, 500),
      msg("m00009", 4, 500),
    ];
    const foldedRefs = new Set(["m00002", "m00003", "m00006", "m00007"]);
    const bookkeepingRefs = new Set<string>();

    const runs = detectUncoveredRuns(
      bound,
      4, // protectedFromTurn = 4
      foldedRefs,
      "m00001", // pinned head
      bookkeepingRefs,
      (m) => Math.ceil(m.bytes / 4),
      [], // no active nudge
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      startRef: "m00004",
      endRef: "m00005",
      count: 2,
      tokens: 700,
      advertised: false,
    });
  });

  it("marks advertised: true when an uncovered run is covered by active nudge ranges", () => {
    const bound: BoundMessage[] = [
      msg("m00001", 0, 100),
      msg("m00002", 1, 100),
      msg("m00003", 1, 100),
      msg("m00004", 2, 500),
    ];
    const foldedRefs = new Set<string>();
    const bookkeepingRefs = new Set<string>();

    const runs = detectUncoveredRuns(
      bound,
      2, // protectedFromTurn = 2
      foldedRefs,
      "m00001",
      bookkeepingRefs,
      (m) => Math.ceil(m.bytes / 4),
      [{ start: "m00002", end: "m00003" }],
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.startRef).toBe("m00002");
    expect(runs[0]?.endRef).toBe("m00003");
    expect(runs[0]?.advertised).toBe(true);
  });

  it("returns empty when all compressible messages are covered by fold blocks", () => {
    const bound: BoundMessage[] = [
      msg("m00001", 0, 100),
      msg("m00002", 1, 100),
      msg("m00003", 1, 100),
      msg("m00004", 2, 500),
    ];
    const foldedRefs = new Set(["m00002", "m00003"]);
    const bookkeepingRefs = new Set<string>();

    const runs = detectUncoveredRuns(
      bound,
      2,
      foldedRefs,
      "m00001",
      bookkeepingRefs,
      (m) => Math.ceil(m.bytes / 4),
    );

    expect(runs).toEqual([]);
  });
});
