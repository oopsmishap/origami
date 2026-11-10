import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { bindMessages, TURN_SEGMENT_BYTES } from "../src/kernel/refs.ts";
import { RefRegistry } from "../src/kernel/registry.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/kernel/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

/**
 * Single-prompt marathons (subagents, long autonomous stretches) previously formed one
 * giant in-flight turn: nothing in them could ever be folded, while the doctrine told
 * the model to fold. Live telemetry showed 43/43 failed folds in one subagent session
 * ("range splits 1 turn(s)") and "range includes protected recent tail (turn N onward)"
 * loops after the last user message in orchestration sessions.
 */

const BIG = "implementation detail ".repeat(200); // ~4.4KB per message

interface Entry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; content: string | unknown[]; toolCallId?: string };
}

function marathonEntries(steps: number, opts: { trailingUser?: boolean } = {}): Entry[] {
  const entries: Entry[] = [{ type: "message", id: "u1", message: { role: "user", content: "do the big task" } }];
  for (let k = 1; k <= steps; k++) {
    entries.push({
      type: "message",
      id: `a${k}`,
      message: { role: "assistant", content: [{ type: "toolCall", id: `c${k}`, name: "read", arguments: { path: `f${k}` } }] },
    });
    entries.push({
      type: "message",
      id: `r${k}`,
      message: { role: "toolResult", content: [{ type: "text", text: `step ${k}: ${BIG}` }], toolCallId: `c${k}` },
    });
  }
  if (opts.trailingUser) entries.push({ type: "message", id: "u2", message: { role: "user", content: "now also handle the edge case" } });
  return entries;
}

function makeEngine(entries: Entry[]) {
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "marathon",
      appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
      saveArtifact: async () => "/tmp/x",
      windowTokens: () => 200_000,
      projectedTokens: () => 50_000,
    },
    entries: entries as never,
    modelId: "test",
    config: { ...configFromPreset("balanced"), minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    countFn: (t) => Math.ceil(t.length / 4),
  });
  const sync = () => {
    engine.refresh(entries as never);
    engine.ingest(
      entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null),
    );
  };
  sync();
  return { engine, sync };
}

describe("turn segmentation", () => {
  it("splits an oversized single turn into segments at assistant step boundaries", () => {
    const registry = new RefRegistry([]);
    const facts = marathonEntries(30)
      .map((e) => (e.message ? messageFacts(e.message) : null))
      .filter((f): f is KernelMessage => f !== null);
    const bound = bindMessages(facts, registry);
    const turns = new Set(bound.filter((m) => !m.ephemeral).map((m) => m.turn));
    expect(turns.size).toBeGreaterThan(1);
    // Segments respect the byte budget: each holds at least one full step.
    const byTurn = new Map<number, number>();
    for (const m of bound) {
      if (!m.ephemeral) byTurn.set(m.turn, (byTurn.get(m.turn) ?? 0) + m.bytes);
    }
    for (const [turn, bytes] of byTurn) {
      if (turn === Math.max(...turns)) continue; // the open tail segment may be small
      expect(bytes).toBeGreaterThanOrEqual(TURN_SEGMENT_BYTES * 0.5);
    }
    // A tool call and its result always share a segment.
    const turnOf = new Map(bound.map((m) => [m.ref, m.turn]));
    for (const m of bound) {
      if (m.toolCallId) {
        const caller = bound.find((x) => x.toolCalls?.some((c) => c.id === m.toolCallId));
        expect(turnOf.get(m.ref)).toBe(turnOf.get(caller!.ref));
      }
    }
  });

  it("small multi-turn sessions keep one turn per user message", () => {
    const registry = new RefRegistry([]);
    const raws = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const bound = bindMessages(raws.map((r) => messageFacts(r)!), registry);
    expect(bound.map((m) => m.turn)).toEqual([1, 1, 2, 2]);
  });
});

describe("marathon foldability", () => {
  it("folds completed segments of a single-prompt session", () => {
    const { engine } = makeEngine(marathonEntries(30));
    const ranges = engine.recommendedRanges();
    expect(ranges.length).toBeGreaterThan(0);
    const r = ranges[0]!;
    const res = engine.executeFold({ folds: [{ range: `${r.start}..${r.end}`, topic: "marathon work", summary: "did steps" }] });
    expect(res.ok).toBe(true);
  });

  it("keeps the latest user instruction unfoldable but folds the work after it", () => {
    const entries = marathonEntries(2, { trailingUser: true });
    // Long autonomous stretch after the trailing user message.
    for (let k = 100; k < 130; k++) {
      entries.push({
        type: "message",
        id: `a${k}`,
        message: { role: "assistant", content: [{ type: "toolCall", id: `c${k}`, name: "read", arguments: { path: `f${k}` } }] },
      });
      entries.push({
        type: "message",
        id: `r${k}`,
        message: { role: "toolResult", content: [{ type: "text", text: `step ${k}: ${BIG}` }], toolCallId: `c${k}` },
      });
    }
    const { engine } = makeEngine(entries);
    const bound = engine.bound;
    const lastUser = [...bound].reverse().find((m) => !m.ephemeral && m.role === "user")!;
    expect(lastUser.text).toContain("edge case");

    // Work after the last user message is foldable (previously: protected tail rejection).
    const ranges = engine.recommendedRanges();
    const afterUser = ranges.find((r) => r.start > lastUser.ref);
    expect(afterUser).toBeDefined();
    const res = engine.executeFold({ folds: [{ range: `${afterUser!.start}..${afterUser!.end}`, topic: "post-instruction work", summary: "steps" }] });
    expect(res.ok).toBe(true);

    // The user instruction itself stays out of every candidate range and cannot be folded.
    for (const r of engine.recommendedRanges()) {
      expect(lastUser.ref >= r.start && lastUser.ref <= r.end).toBe(false);
    }
    const pinned = engine.executeFold({ folds: [{ range: `${lastUser.ref}..${lastUser.ref}`, topic: "user msg", summary: "s" }] });
    expect(pinned.ok).toBe(false);
  });
});
