import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { formatStatusChip } from "../src/ui/status.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

function conversation(turns: number) {
  const entries: { type: "message"; id: string; message: { role: string; content: string } }[] = [];
  for (let k = 1; k <= turns; k++) {
    entries.push({ type: "message", id: `u${k}`, message: { role: "user", content: `user turn ${k}: ${"investigate caching economics and payback ".repeat(15)}` } });
    entries.push({ type: "message", id: `a${k}`, message: { role: "assistant", content: `assistant turn ${k}: ${"amortized savings exceed one-time cost quickly ".repeat(15)}` } });
  }
  return entries;
}

describe("Payback Economics & Break-Even Turns (#4899)", () => {
  it("reports No folds yet when session has no folds", () => {
    const entries = conversation(3);
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "sess-payback-none",
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => 100_000,
        projectedTokens: () => 5_000,
      },
      entries,
      modelId: "test",
      config: configFromPreset("balanced"),
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    const rep = engine.status();
    expect(rep.vault.paidBack).toBe(false);
    expect(rep.vault.paybackStatus).toBe("No folds yet");
    expect(rep.vault.cumulativeSavedTokens).toBe(0);
  });

  it("calculates break-even turns and tracks paid back status as turns advance", () => {
    const entries = conversation(8);
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "sess-payback-active",
        appendEvent: () => {},
        saveArtifact: async () => "/tmp/unused.md",
        windowTokens: () => 100_000,
        projectedTokens: () => 10_000,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 },
    });
    engine.refresh(entries);
    engine.ingest(entries.map((e) => messageFacts(e.message)).filter((f): f is KernelMessage => f !== null));

    // Fold turns 2 and 3: m00003..m00006
    const res = engine.executeFold({
      folds: [{ range: "m00003..m00006", topic: "Economics", summary: "Short summary" }],
    });
    expect(res.ok).toBe(true);

    const rep = engine.status();
    expect(rep.vault.reclaimedTokens).toBeGreaterThan(0);
    expect(rep.vault.breakEvenTurns).toBeGreaterThanOrEqual(1);
    // Since activeTurn is turn 8 and fold covered turns 2-3 (earliest turn 2), turnsSinceFold = 8 - 2 = 6 turns!
    // Break-even is ~1 turn, so 6 turns >= 1 turn -> paidBack is true!
    expect(rep.vault.paidBack).toBe(true);
    expect(rep.vault.paybackStatus).toContain("Paid back");
    expect(rep.vault.cumulativeSavedTokens).toBeGreaterThan(0);

    // Verify formatStatusChip includes checkmark
    const chip = formatStatusChip(rep);
    expect(chip).toContain("✓");
  });
});
