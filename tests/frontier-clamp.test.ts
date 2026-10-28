import { describe, expect, it } from "bun:test";
import { projectUnit } from "../src/kernel/project-unit.ts";
import type { BoundMessage, KernelRole } from "../src/kernel/types.ts";
import { parseRef } from "../src/kernel/types.ts";

function msg(ref: string, turn: number, role: KernelRole = "user"): BoundMessage {
  return {
    ref,
    turn,
    role,
    index: parseRef(ref),
    ephemeral: false,
    contentHash: "h-" + ref,
    signedThinking: false,
    text: "text",
    bytes: 400,
  };
}

describe("Frontier Clamp Diagnostics (#2146, #4252)", () => {
  const bound: BoundMessage[] = [
    msg("m00001", 0),
    msg("m00002", 1),
    msg("m00003", 1),
    msg("m00004", 2),
    msg("m00005", 2),
  ];

  it("diagnoses all-above-frontier refs as stale generation (#2146)", () => {
    const res = projectUnit({
      bound,
      ranges: [{ start: "m00010", end: "m00020" }],
      foldedRefs: new Set(),
      pinnedHeadRef: "m00001",
      activeTurn: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("is above this session's highest ref (m00005)");
      expect(res.error).toContain("check for stale refs");
    }
  });

  it("diagnoses partially past frontier range with an actionable ceiling clamp (#4252)", () => {
    const res = projectUnit({
      bound,
      ranges: [{ start: "m00002", end: "m00015" }],
      foldedRefs: new Set(),
      pinnedHeadRef: "m00001",
      activeTurn: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("endRef m00015 is above the highest stored ref (m00005)");
      expect(res.error).toContain("retry with endRef ≤ m00005");
    }
  });

  it("allows ranges within the frontier to proceed to boundary checks", () => {
    const res = projectUnit({
      bound,
      ranges: [{ start: "m00002", end: "m00003" }],
      foldedRefs: new Set(),
      pinnedHeadRef: "m00001",
      activeTurn: 2,
      protectedFromTurn: 2,
    });
    expect(res.ok).toBe(true);
  });
});
