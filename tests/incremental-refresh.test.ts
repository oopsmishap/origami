import { describe, expect, it } from "bun:test";
import { SessionState } from "../src/kernel/state.ts";
import type { SessionEntryLike } from "../src/kernel/registry.ts";
import { makeFoldOp, makeUnfoldOp } from "../src/kernel/journal.ts";

function timeline(turns: number): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  let ref = 0;
  for (let turn = 0; turn < turns; turn++) {
    entries.push({ type: "message", id: `u${turn}`, message: { role: "user", content: `task ${turn} ${"p".repeat(40)}` } });
    ref++;
    entries.push({ type: "message", id: `a${turn}`, message: { role: "assistant", content: `work ${turn} ${"q".repeat(40)}` } });
    ref++;
    if (turn % 3 === 2) {
      const end = `m${String(ref).padStart(5, "0")}`;
      const start = `m${String(ref - 3).padStart(5, "0")}`;
      entries.push({
        type: "custom",
        id: `f${turn}`,
        customType: "origami:event",
        data: makeFoldOp({
          id: `b${turn}`,
          tier: 1,
          ranges: [{ start, end }],
          topic: `turn ${turn}`,
          summary: "did work",
          children: [],
          status: "active",
          consumedBy: null,
          tokensBefore: 400,
          tokensAfter: 20,
          createdAt: turn,
          anchorRef: end,
        }),
      });
    }
    if (turn === 8) {
      entries.push({ type: "custom", id: `un${turn}`, customType: "origami:event", data: makeUnfoldOp("b2") });
    }
  }
  return entries;
}

function stateOf(entries: readonly SessionEntryLike[]): SessionState {
  const state = new SessionState({ sessionId: "s", modelId: "test", entries, countFn: null });
  state.bind();
  return state;
}

function refresh(state: SessionState, entries: readonly SessionEntryLike[], verify = false): void {
  state.refresh(entries, verify);
  state.bind();
}

function snapshot(state: SessionState) {
  return {
    blocks: state.tree.all().map((b) => ({ id: b.id, status: b.status, consumedBy: b.consumedBy, ranges: b.ranges, tokensAfter: b.tokensAfter })),
    folded: [...state.foldedRefs()].sort(),
    anchors: state.tree.latestFoldAnchor(),
    messages: state.messages.map((m) => `${m.role}:${m.contentHash}`),
    bound: state.bound.map((m) => `${m.ref}:${m.turn}:${m.role}`),
  };
}

describe("SessionState incremental refresh", () => {
  it("matches a full replay when entries are appended one at a time", () => {
    const all = timeline(12);
    const incremental = stateOf([]);
    for (let n = 1; n <= all.length; n++) refresh(incremental, all.slice(0, n));

    expect(snapshot(incremental)).toEqual(snapshot(stateOf(all)));
    expect(incremental.refreshStats.rebuilt).toBe(false);
  });

  it("hashes only the appended entries on an append", () => {
    const all = timeline(30);
    const state = stateOf(all.slice(0, all.length - 1));
    refresh(state, all);

    expect(state.refreshStats).toEqual({ appended: 1, rebuilt: false });
    expect(state.messages).toHaveLength(all.filter((e) => e.type === "message").length);
  });

  it("rebuilds when the journal is truncated", () => {
    const all = timeline(12);
    const state = stateOf(all);
    refresh(state, all.slice(0, 6));

    expect(state.refreshStats.rebuilt).toBe(true);
    expect(snapshot(state)).toEqual(snapshot(stateOf(all.slice(0, 6))));
  });

  it("rebuilds when an already-applied entry id is replaced", () => {
    const all = timeline(12);
    const state = stateOf(all);
    const rewritten = all.map((e, i) => (i === 3 ? { ...e, id: "replaced" } : e));
    refresh(state, rewritten);

    expect(state.refreshStats.rebuilt).toBe(true);
    expect(snapshot(state)).toEqual(snapshot(stateOf(rewritten)));
  });

  it("does no work when the journal is unchanged", () => {
    const all = timeline(12);
    const state = stateOf(all);
    state.refreshStats = { appended: 99, rebuilt: true };
    refresh(state, all);
    expect(state.refreshStats).toEqual({ appended: 99, rebuilt: true });
  });

  it("verify forces a replay so in-place source edits are observed", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "assistant", content: "fourth" },
    ];
    const entries: SessionEntryLike[] = messages.map((message, i) => ({ type: "message", id: `e${i}`, message }));
    const state = stateOf(entries);
    const before = snapshot(state).messages;

    messages[1]!.content = "second (edited)";
    refresh(state, entries);
    expect(snapshot(state).messages).toEqual(before);

    refresh(state, entries, true);
    expect(snapshot(state).messages).not.toEqual(before);
  });

  it("reuses the request bind for the same array until the journal changes", () => {
    const all = timeline(6);
    const state = stateOf(all);
    const raw: unknown[] = [];
    for (const entry of all) {
      if (entry.type === "message") raw.push(entry.message);
    }

    const first = state.bindRequest(raw);
    expect(first.aligned).toBe(true);
    expect(state.bindRequest(raw)).toBe(first);

    refresh(state, [...all, { type: "message", id: "extra", message: { role: "user", content: "more" } }]);
    expect(state.bindRequest(raw)).not.toBe(first);
  });
});
