import { describe, expect, it } from "bun:test";
import { projectUnit, protectedZoneMap } from "../src/kernel/project-unit.ts";
import type { BoundMessage } from "../src/kernel/types.ts";

function msg(ref: string, turn: number, role: BoundMessage["role"] = "user", extra: Partial<BoundMessage> = {}): BoundMessage {
  return {
    ref,
    turn,
    role,
    index: 0,
    contentHash: `h${ref}`,
    text: `bytes-${ref}`,
    bytes: ref.length + 6,
    signedThinking: false,
    ephemeral: false,
    ...extra,
  };
}

function turn(n: number, base: number): BoundMessage[] {
  return [
    msg(`m${String(base).padStart(5, "0")}`, n, "user"),
    msg(`m${String(base + 1).padStart(5, "0")}`, n, "assistant"),
    msg(`m${String(base + 2).padStart(5, "0")}`, n, "toolResult"),
  ];
}

function makeBound(): BoundMessage[] {
  return [...turn(1, 1), ...turn(2, 4), ...turn(3, 7), ...turn(4, 10), ...turn(5, 13)].map((m, i) => ({ ...m, index: i }));
}

const base = { foldedRefs: new Set<string>(), pinnedHeadRef: "m00001", activeTurn: 5 };

describe("projectUnit", () => {
  it("rejects an empty range with a stable literal", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [], ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty range");
  });

  it("rejects a range matching no messages or above frontier", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00090", end: "m00099" }], ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("is above this session's highest ref");

    // An in-frontier range where all messages are already folded matches no messages
    const r2 = projectUnit({
      bound: makeBound(),
      ranges: [{ start: "m00004", end: "m00006" }],
      ...base,
      foldedRefs: new Set(["m00004", "m00005", "m00006"]),
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("range matches no messages");
  });

  it("accepts a whole turn and keeps its single span", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00004", end: "m00006" }], ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projected.refs).toEqual(["m00004", "m00005", "m00006"]);
      expect(r.projected.ranges).toEqual([{ start: "m00004", end: "m00006" }]);
      expect(r.widened).toBe(false);
      expect(r.turnCount).toBe(1);
    }
  });

  it("widens a partial turn to the whole turn", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00005", end: "m00005" }], ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projected.refs).toEqual(["m00004", "m00005", "m00006"]);
      expect(r.widened).toBe(true);
    }
  });

  it("keeps a signed-thinking turn whole across a toolResult-only range", () => {
    const bound = makeBound();
    bound[4] = msg("m00005", 2, "assistant", { signedThinking: true });
    const r = projectUnit({ bound, ranges: [{ start: "m00006", end: "m00006" }], ...base });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projected.refs).toEqual(["m00004", "m00005", "m00006"]);
  });

  it("rejects the pinned protected head", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00001", end: "m00003" }], ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range inside protected head");
  });

  it("rejects a whole in-flight turn", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00013", end: "m00015" }], ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range includes current in-flight turn");
  });

  it("reports the split count when a range cuts through an in-flight turn", () => {
    const r = projectUnit({ bound: makeBound(), ranges: [{ start: "m00014", end: "m00014" }], ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range splits 1 turn(s)");
  });

  it("counts multiple cut turns in the split literal", () => {
    const r = projectUnit({
      bound: makeBound(),
      ranges: [{ start: "m00002", end: "m00002" }, { start: "m00014", end: "m00014" }],
      ...base,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range splits 2 turn(s)");
  });

  it("keeps a live gap between disjoint ranges", () => {
    const r = projectUnit({
      bound: makeBound(),
      ranges: [
        { start: "m00004", end: "m00006" },
        { start: "m00010", end: "m00012" },
      ],
      ...base,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projected.refs).toEqual(["m00004", "m00005", "m00006", "m00010", "m00011", "m00012"]);
      expect(r.projected.ranges).toEqual([
        { start: "m00004", end: "m00006" },
        { start: "m00010", end: "m00012" },
      ]);
    }
  });

  it("skips already-folded refs and reports no messages", () => {
    const r = projectUnit({
      bound: makeBound(),
      ranges: [{ start: "m00004", end: "m00006" }],
      ...base,
      foldedRefs: new Set(["m00004", "m00005", "m00006"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range matches no messages");
  });

  it("never pulls ephemeral messages into the projection", () => {
    const bound = makeBound();
    bound[3] = msg("m00004", 2, "developer", { ephemeral: true });
    const r = projectUnit({ bound, ranges: [{ start: "m00005", end: "m00006" }], ...base });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projected.refs).toEqual(["m00005", "m00006"]);
  });
});

describe("protectedZoneMap", () => {
  it("labels head, compressible, folded and in-flight runs", () => {
    const bound = makeBound();
    const zones = protectedZoneMap(bound, 5, new Set(["m00004", "m00005", "m00006"]), "m00001");
    expect(zones[0]).toEqual({ kind: "protected", start: "m00001", end: "m00003" });
    expect(zones[1]).toEqual({ kind: "folded", start: "m00004", end: "m00006" });
    expect(zones[2]).toEqual({ kind: "compressible", start: "m00007", end: "m00012" });
    expect(zones[3]).toEqual({ kind: "protected", start: "m00013", end: "m00015" });
  });

  it("preserves contiguous folded zone across internal ephemeral messages", () => {
    const bound: BoundMessage[] = [
      msg("m00001", 1, "user"),
      msg("m00002", 2, "user"),
      msg("", 2, "developer", { ephemeral: true }),
      msg("m00003", 2, "assistant"),
      msg("m00004", 3, "user"),
    ];
    const zones = protectedZoneMap(bound, 3, new Set(["m00002", "m00003"]), "m00001");
    expect(zones).toHaveLength(3);
    expect(zones[0]).toEqual({ kind: "protected", start: "m00001", end: "m00001" });
    expect(zones[1]).toEqual({ kind: "folded", start: "m00002", end: "m00003" });
    expect(zones[2]).toEqual({ kind: "protected", start: "m00004", end: "m00004" });
  });
});