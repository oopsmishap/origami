import { describe, expect, it } from "bun:test";
import { bindMessages, monotonicCheck } from "../src/kernel/refs.ts";
import { RefRegistry } from "../src/kernel/registry.ts";
import type { SessionEntryLike } from "../src/kernel/registry.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

interface RawMessage {
  role: KernelMessage["role"];
  text: string;
  toolCallId?: string;
}

function raw(role: KernelMessage["role"], text: string, toolCallId?: string): RawMessage {
  return { role, text, toolCallId };
}

function toMessage(r: RawMessage): Record<string, unknown> {
  return {
    role: r.role,
    content: [{ type: "text", text: r.text }],
    ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
  };
}

function factsOf(r: RawMessage): KernelMessage {
  return messageFacts(toMessage(r))!;
}

function entriesFrom(raws: readonly RawMessage[]): SessionEntryLike[] {
  return raws.map((r, i) => ({ type: "message", id: `e${i}`, message: toMessage(r) }));
}

describe("RefRegistry", () => {
  it("assigns ordinal refs by journal message order", () => {
    const reg = new RefRegistry(entriesFrom([raw("user", "a"), raw("assistant", "b"), raw("toolResult", "c", "t1")]));
    expect(reg.entries.map((e) => e.ref)).toEqual([1, 2, 3]);
    expect(reg.byToolCallId.get("t1")).toBe(3);
    expect(reg.nextRef).toBe(4);
  });

  it("keeps identical refs for shared history across fork views", () => {
    const all = entriesFrom([raw("user", "a"), raw("assistant", "b"), raw("user", "c"), raw("assistant", "d")]);
    const branchA = new RefRegistry(all.slice(0, 3));
    const extra = entriesFrom([raw("assistant", "z")]).map((e) => ({ ...e, id: "f0" }));
    const branchB = new RefRegistry(all.slice(0, 3).concat(extra));
    expect(branchA.byEntryId.get("e0")).toBe(1);
    expect(branchB.byEntryId.get("e0")).toBe(1);
    expect(branchB.byEntryId.get("e2")).toBe(3);
    expect(branchB.nextRef).toBe(5);
  });
});

describe("bindMessages", () => {
  it("binds toolResults by journaled toolCallId ref", () => {
    const raws = [raw("assistant", "b"), raw("toolResult", "c", "t1")];
    const reg = new RefRegistry(entriesFrom(raws));
    const bound = bindMessages(raws.map(factsOf), reg);
    expect(bound.map((m) => m.ref)).toEqual(["m00001", "m00002"]);
  });

  it("is pure: repeated binds of the same history yield identical refs", () => {
    const raws = [raw("user", "a"), raw("assistant", "b"), raw("toolResult", "c", "t1"), raw("assistant", "d")];
    const reg = new RefRegistry(entriesFrom(raws));
    const msgs = raws.map(factsOf);
    const first = bindMessages(msgs, reg).map((m) => m.ref);
    const second = bindMessages(msgs, reg).map((m) => m.ref);
    expect(first).toEqual(second);
    expect(first).toEqual(["m00001", "m00002", "m00003", "m00004"]);
    expect(monotonicCheck(first)).toBe(true);
  });

  it("assigns fresh refs beyond the registry cursor for unseen messages", () => {
    const raws = [raw("user", "a")];
    const reg = new RefRegistry(entriesFrom(raws));
    const bound = bindMessages([raw("user", "a"), raw("assistant", "b"), raw("assistant", "c")].map(factsOf), reg);
    expect(bound.map((m) => m.ref)).toEqual(["m00001", "m00002", "m00003"]);
  });

  it("marks developer messages ephemeral with no ref", () => {
    const raws = [raw("user", "a"), raw("assistant", "c")];
    const reg = new RefRegistry(entriesFrom(raws));
    const bound = bindMessages([raw("user", "a"), raw("developer", "b"), raw("assistant", "c")].map(factsOf), reg);
    expect(bound[1]!.ephemeral).toBe(true);
    expect(bound[1]!.ref).toBe("");
    expect(bound[0]!.ephemeral).toBe(false);
    expect(bound[2]!.ephemeral).toBe(false);
  });

  it("assigns turns starting at 1 per user message", () => {
    const reg = new RefRegistry([]);
    const bound = bindMessages([raw("user", "a"), raw("assistant", "b"), raw("toolResult", "c"), raw("user", "d"), raw("assistant", "e")].map(factsOf), reg);
    expect(bound.map((m) => m.turn)).toEqual([1, 1, 1, 2, 2]);
  });
});

describe("monotonicCheck", () => {
  it("rejects decreasing refs", () => {
    expect(monotonicCheck(["m00001", "m00003", "m00002"])).toBe(false);
    expect(monotonicCheck(["m00001", "m00002", "m00003"])).toBe(true);
  });
});