import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

function conversation(turns: number) {
  const entries: { type: "message"; id: string; message: { role: string; content: string } }[] = [];
  for (let k = 1; k <= turns; k++) {
    entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user turn ${k}: ${"please investigate the parser edge case ".repeat(6)}` } });
    entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant turn ${k}: ${"found the off-by-one in the tokenizer loop ".repeat(6)}` } });
  }
  return entries;
}

function harness() {
  const journal: unknown[] = [];
  const entries = conversation(6);
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "sess-coverage-reg",
      appendEvent: (op) => journal.push(op),
      saveArtifact: async () => "/tmp/art.md",
      windowTokens: () => 100_000,
      projectedTokens: () => 10_000,
    },
    entries,
    modelId: "test-model",
    config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    countFn: (t) => t.length,
  });
  engine.refresh(entries);
  engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));
  return { engine, journal };
}

describe("Coverage Regression Guard (#3322)", () => {
  it("allows normal tier 1 and tier 2 folds where coverage is preserved", () => {
    const { engine } = harness();
    // Fold 1: covers m00003..m00004
    const res1 = engine.executeFold({
      folds: [{ range: "m00003..m00004", topic: "T1", summary: "Summary of 3 and 4" }],
    });
    expect(res1.ok).toBe(true);

    // Fold 2: covers m00005..m00006
    const res2 = engine.executeFold({
      folds: [{ range: "m00005..m00006", topic: "T2", summary: "Summary of 5 and 6" }],
    });
    expect(res2.ok).toBe(true);

    // Distillation: merges b1 and b2 into b3
    const res3 = engine.executeFold({
      folds: [{ range: "b1,b2", topic: "T3", summary: "Merged summary of 3 through 6" }],
      tier: 2,
    });
    expect(res3.ok).toBe(true);

    // All original refs m00003..m00006 remain covered!
    const covered = engine.state.foldedRefs();
    for (const ref of ["m00003", "m00004", "m00005", "m00006"]) {
      expect(covered.has(ref)).toBe(true);
    }
  });

  it("rejects any fold that would regress coverage of previously covered messages", () => {
    const { engine, journal } = harness();
    expect(engine.executeFold({
      folds: [{ range: "m00003..m00004", topic: "T1", summary: "Summary of 3 and 4" }],
    }).ok).toBe(true);
    expect(engine.executeFold({
      folds: [{ range: "m00005..m00006", topic: "T2", summary: "Summary of 5 and 6" }],
    }).ok).toBe(true);

    const b1 = engine.state.tree.get("b1")!;
    const b2 = engine.state.tree.get("b2")!;
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();

    // Mock project to simulate a damaged projection where child coverage is dropped
    const origProject = engine.project.bind(engine);
    engine.project = (spec: string, tier: 1 | 2 | 3) => {
      if (tier === 2) {
        return {
          ok: true,
          projected: {
            indices: [],
            refs: ["m00003", "m00005", "m00006"], // Dropped m00004!
            ranges: [{ start: "m00003", end: "m00003" }, { start: "m00005", end: "m00006" }], // Regression: m00004 lost!
            tokens: 50,
          },
          widened: false,
          turnCount: 1,
        };
      }
      return origProject(spec, tier);
    };

    const journalLenBefore = journal.length;
    const res = engine.executeFold({
      folds: [{ range: "b1,b2", topic: "Corrupted", summary: "Corrupted merge" }],
      tier: 2,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("coverage regression");
      expect(res.error).toContain("message m00004 was previously covered but would lose its covering block");
    }
    // State and journal remain unmutated
    expect(journal.length).toBe(journalLenBefore);
    expect(engine.state.tree.get("b1")?.status).toBe("active");
  });

  it("rejects any fold that would produce duplicate coverage or structural invariant violations", () => {
    const { engine, journal } = harness();
    // Fold 1: covers m00003..m00004
    const res1 = engine.executeFold({
      folds: [{ range: "m00003..m00004", topic: "T1", summary: "Summary of 3 and 4" }],
    });
    expect(res1.ok).toBe(true);

    // Fold 2: covers m00005..m00006
    const res2 = engine.executeFold({
      folds: [{ range: "m00005..m00006", topic: "T2", summary: "Summary of 5 and 6" }],
    });
    expect(res2.ok).toBe(true);

    // Fold 3: covers m00007..m00008
    const res3 = engine.executeFold({
      folds: [{ range: "m00007..m00008", topic: "T3", summary: "Summary of 7 and 8" }],
    });
    expect(res3.ok).toBe(true);

    // In Tier 2, merge b2 and b3, but simulate a projection that illegally covers b1's ranges without consuming b1
    const origProject = engine.project.bind(engine);
    engine.project = (spec: string, tier: 1 | 2 | 3) => {
      if (tier === 2) {
        return {
          ok: true,
          projected: {
            indices: [],
            refs: ["m00003", "m00004", "m00005", "m00006", "m00007", "m00008"],
            // Illegally claims m00003..m00004 which is owned by active block b1!
            ranges: [{ start: "m00003", end: "m00008" }],
            tokens: 50,
          },
          widened: false,
          turnCount: 2,
        };
      }
      return origProject(spec, tier);
    };

    const journalLen = journal.length;
    const resTier2 = engine.executeFold({
      folds: [{ range: "b2,b3", topic: "Merge b2 and b3", summary: "Summary of b2 and b3" }],
      tier: 2,
    });

    expect(resTier2.ok).toBe(false);
    if (!resTier2.ok) {
      expect(resTier2.error).toContain("invariant violation (duplicate-coverage)");
      expect(resTier2.error).toContain("overlaps active block b1");
    }
    expect(journal.length).toBe(journalLen);
    expect(engine.state.tree.get("b4")).toBeUndefined();
  });
});
