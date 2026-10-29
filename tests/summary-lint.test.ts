import { describe, expect, it } from "bun:test";
import { lintSummary } from "../src/kernel/summary-lint.ts";
import { EMPTY_MANIFEST } from "../src/kernel/manifest.ts";
import { renderBlockText } from "../src/kernel/render.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import { formatFoldOutcome } from "../src/tools/display.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

describe("lintSummary", () => {
  it("accepts a path named by its last two segments and reports an unnamed commit", () => {
    const manifest = { ...EMPTY_MANIFEST, paths: ["src/kernel/nudge.ts"], commits: ["3b038b3aa"] };
    expect(lintSummary("Reworked kernel/nudge.ts gating.", manifest)).toEqual({ required: 2, missing: ["commit 3b038b3"] });
    expect(lintSummary("nudge.ts at 3b038b3", manifest).missing).toEqual(["path src/kernel/nudge.ts"]);
  });

  it("only requires the first three errors", () => {
    const errors = ["Error one", "Error two", "Error three", "Error four"];
    const lint = lintSummary("", { ...EMPTY_MANIFEST, errors });
    expect(lint.required).toBe(3);
    expect(lint.missing).toEqual(["error Error one", "error Error two", "error Error three"]);
  });
});

describe("fold attaches omitted items and counts what is sent", () => {
  it("renders Also covered and sets tokensAfter from the rendered block", () => {
    const entries = [
      { type: "message", id: "e0", message: { role: "user", content: `start ${"context ".repeat(50)}` } },
      { type: "message", id: "e1", message: { role: "user", content: `fix src/kernel/nudge.ts then commit ${"detail ".repeat(200)}` } },
      { type: "message", id: "e2", message: { role: "assistant", content: `[master 3b038b3] fix gating ${"more ".repeat(200)}` } },
      { type: "message", id: "e3", message: { role: "user", content: "next task" } },
    ];
    const engine = new OrigamiEngine({
      host: { sessionId: () => "lint", appendEvent: () => {}, saveArtifact: async () => "/tmp/x", windowTokens: () => 100_000, projectedTokens: () => 10_000 },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
    const refs = engine.bound.map((m) => m.ref);
    const res = engine.executeFold({ folds: [{ range: `${refs[1]}..${refs[2]}`, topic: "Gating fix", summary: "Fixed kernel/nudge.ts gating." }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const block = engine.state.tree.get(res.outcome.blocks[0]!.id)!;
    expect(block.missing).toEqual(["commit 3b038b3"]);
    const text = renderBlockText(block);
    expect(text.endsWith("\nAlso covered (fold_recall for detail): commit 3b038b3")).toBe(true);
    expect(block.tokensAfter).toBe(engine.state.ledger.countText(text));
    expect(formatFoldOutcome(res.outcome)).toContain(`${block.id}: summary omitted 1 source item(s) (commit 3b038b3); attached as "Also covered".`);
  });
});
