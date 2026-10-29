import { describe, expect, it } from "bun:test";
import { formatRecallHints, matchRecallHints } from "../src/kernel/recall-hints.ts";
import { EMPTY_MANIFEST } from "../src/kernel/manifest.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { Block, KernelMessage } from "../src/kernel/types.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";

const block: Block = {
  id: "b14",
  tier: 1,
  ranges: [{ start: "m01200", end: "m01260" }],
  topic: "Cache economics port",
  summary: "s",
  children: [],
  status: "active",
  consumedBy: null,
  tokensBefore: 1000,
  tokensAfter: 100,
  createdAt: 1,
  anchorRef: null,
  manifest: { ...EMPTY_MANIFEST, paths: ["src/kernel/nudge.ts"], symbols: ["computeFoldEconomics"] },
};

describe("recall hints", () => {
  it("matches a folded block's manifest path in the current probe", () => {
    const hints = matchRecallHints({ blocks: [block], probe: 'read {"path":"src/kernel/nudge.ts"}', exclude: new Set(), max: 3 });
    expect(formatRecallHints(hints)).toBe(
      [
        "[origami recall] Folded history matches your current work:",
        '- b14 (m01200..m01260) "Cache economics port" — matches: src/kernel/nudge.ts',
        "Use fold_recall on those refs (or fold_search) before relying on memory of that work.",
      ].join("\n"),
    );
    expect(matchRecallHints({ blocks: [{ ...block, status: "consumed" }], probe: "src/kernel/nudge.ts", exclude: new Set(), max: 3 })).toEqual([]);
    expect(matchRecallHints({ blocks: [block], probe: "computeFoldEconomicsX", exclude: new Set(), max: 3 })).toEqual([]);
  });

  it("engine hints a block once, then stays quiet for the next 5 turns", () => {
    const entries: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
    const push = (role: string, content: string) => entries.push({ type: "message", id: `e${entries.length}`, message: { role, content } });
    for (let t = 0; t < 4; t++) {
      push("user", `early turn ${t} edits src/kernel/nudge.ts ${"detail ".repeat(200)}`);
      push("assistant", `done ${t} ${"reply ".repeat(200)}`);
    }
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "hints",
        appendEvent: (op) => entries.push({ type: "custom", id: `j${entries.length}`, customType: JOURNAL_ENTRY_TYPE, data: op }),
        saveArtifact: async () => "/tmp/x",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    const sync = () => {
      engine.refresh(entries);
      engine.ingest(entries.map((e) => (e.message ? messageFacts(e.message) : null)).filter((f): f is KernelMessage => f !== null));
    };
    sync();
    const refs = engine.bound.map((m) => m.ref);
    const res = engine.executeFold({ folds: [{ range: `${refs[2]}..${refs[5]}`, topic: "Nudge work", summary: "edited nudge" }] });
    expect(res.ok).toBe(true);

    // Every turn touches the folded file; the hint fires, stays quiet 5 turns, then fires again.
    const hintsByTurn: boolean[] = [];
    for (let t = 0; t < 7; t++) {
      push("user", `turn ${t}: open src/kernel/nudge.ts again`);
      sync();
      hintsByTurn.push(engine.recallHintText() !== null);
      push("assistant", "ok");
    }
    expect(hintsByTurn).toEqual([true, false, false, false, false, false, true]);
  });
});
