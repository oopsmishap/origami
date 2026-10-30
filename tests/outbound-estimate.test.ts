import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

describe("outbound estimate after a fold", () => {
  it("does not count folded history still inside the host's last-round anchor", () => {
    const entries: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
    const push = (role: string, content: string) => entries.push({ type: "message", id: `e${entries.length}`, message: { role, content } });
    for (let t = 0; t < 6; t++) {
      push("user", `turn ${t} ${"question ".repeat(400)}`);
      push("assistant", `answer ${t} ${"detail ".repeat(400)}`);
    }
    const OVERHEAD = 12_000;
    let projected = 0;
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "estimate-session",
        appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 200_000,
        projectedTokens: () => projected,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    const raw = () => entries.filter((e) => e.message).map((e) => e.message!);
    const sync = () => {
      engine.refresh(entries);
      engine.ingest(raw().map((m) => messageFacts(m)).filter((f): f is KernelMessage => f !== null));
    };
    sync();
    const make = (text: string) => ({ role: "custom", customType: "origami:fold", content: text, display: false });

    // The host anchors on the last provider round: overhead + everything sent then.
    const before = engine.outboundEstimateTokens(engine.render(raw(), make));
    projected = before.bound + OVERHEAD;
    engine.recordRound({ ts: 1, totalIn: projected, cacheRead: 0, cacheWrite: 0, foldEventId: null, hostRewrite: false });
    expect(engine.outboundEstimateTokens(engine.render(raw(), make)).overhead).toBe(OVERHEAD);

    const refs = engine.bound.map((m) => m.ref);
    const res = engine.executeFold({ folds: [{ range: `${refs[2]}..${refs[9]}`, topic: "Early turns", summary: "Questions and answers." }] });
    expect(res.ok).toBe(true);
    sync();

    // No new round yet: the host still projects the pre-fold size.
    const after = engine.outboundEstimateTokens(engine.render(raw(), make));
    expect(after.bound).toBeLessThan(before.bound);
    expect(after.overhead).toBeLessThanOrEqual(OVERHEAD + 50);
    expect(after.total).toBeLessThanOrEqual(after.bound + OVERHEAD + 50);
    expect(after.total).toBeLessThan(projected);
  });

  it("blocks an over-limit request once per estimate, so a stuck session can always send again", () => {
    const engine = new OrigamiEngine({
      host: { sessionId: () => "abort-guard", appendEvent: () => {}, saveArtifact: async () => "/tmp/x", windowTokens: () => 100_000, projectedTokens: () => 0 },
      entries: [],
      modelId: "test",
    });
    expect(engine.shouldAbortAtLimit(120_000)).toBe(true);
    // Retry with nothing shrunk: sent through rather than aborted again.
    expect(engine.shouldAbortAtLimit(120_000)).toBe(false);
    expect(engine.shouldAbortAtLimit(125_000)).toBe(false);
    // Something shrank but is still over: one more block with the new estimate.
    expect(engine.shouldAbortAtLimit(110_000)).toBe(true);
    // A request under the window resets the guard.
    engine.clearContextAbort();
    expect(engine.shouldAbortAtLimit(120_000)).toBe(true);
  });
});
