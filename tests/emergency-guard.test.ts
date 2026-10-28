import { describe, expect, it } from "bun:test";
import { planElision, selectElideCandidates, applyElision, elideLabel } from "../src/kernel/guard.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";

describe("Emergency guard test (overflow elision)", () => {
  it("leaves context untouched when under emergency threshold", () => {
    const candidates = [
      { ref: "m00003", index: 2, tokens: 10_000 },
      { ref: "m00005", index: 4, tokens: 15_000 },
    ];
    const plan = planElision({
      projectedTokens: 80_000,
      windowTokens: 100_000,
      candidates,
      thresholds: { elideFillPct: 0.85, targetFillPct: 0.7 },
    });

    expect(plan.elided.length).toBe(0);
  });

  it("plans elision to bring context below target fill when crossing emergency threshold", () => {
    const candidates = [
      { ref: "m00003", index: 2, tokens: 10_000 },
      { ref: "m00005", index: 4, tokens: 15_000 },
      { ref: "m00007", index: 6, tokens: 5_000 },
    ];
    // 90K / 100K = 90% >= 85% elideFillPct. Target = 70K
    const plan = planElision({
      projectedTokens: 90_000,
      windowTokens: 100_000,
      candidates,
      thresholds: { elideFillPct: 0.85, targetFillPct: 0.7 },
    });

    // To get from 90K down to <= 70K, we need to shed at least 20K.
    // Largest candidate is 15K (m00005) -> 90K - 15K = 75K.
    // Next largest candidate is 10K (m00003) -> 75K - 10K = 65K <= 70K.
    expect(plan.elided.length).toBe(2);
    expect(plan.elided.map((e) => e.ref)).toEqual(["m00005", "m00003"]);
  });

  it("never selects assistant, user, or thinking messages as elide candidates", () => {
    const bound = [
      { ref: "m00001", index: 0, role: "system", tokens: 500, ephemeral: true },
      { ref: "m00002", index: 1, role: "user", tokens: 2_000, ephemeral: false },
      { ref: "m00003", index: 2, role: "assistant", tokens: 8_000, ephemeral: false },
      { ref: "m00004", index: 3, role: "toolResult", tokens: 25_000, ephemeral: false },
      { ref: "m00005", index: 4, role: "assistant", tokens: 6_000, ephemeral: false },
    ];

    const candidates = selectElideCandidates(bound);
    // ONLY the toolResult is selected! Assistant and user are excluded.
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.ref).toBe("m00004");
  });

  it("applies elision labels cleanly to tool results while preserving assistant signed thinking", () => {
    interface TestMsg {
      role: string;
      content: unknown;
    }

    const messages: TestMsg[] = [
      { role: "user", content: "read a huge log file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "analyzing log data...", thinkingSignature: "sig_log_safe" },
          { type: "text", text: "Reading the log file now." },
        ],
      },
      { role: "toolResult", content: "A".repeat(50_000) },
    ];

    const plan = {
      elided: [{ ref: "m00003", index: 2, tokens: 20_000 }],
      label: elideLabel,
    };

    const out = applyElision(
      messages,
      plan,
      () => "m00003",
      (m, label) => ({ ...m, content: label }),
    );

    expect(out.length).toBe(3);
    // Assistant message and signed thinking remain completely byte-exact
    const asst = out[1]!.content as { type: string; thinkingSignature?: string }[];
    expect(asst[0]!.type).toBe("thinking");
    expect(asst[0]!.thinkingSignature).toBe("sig_log_safe");

    // Tool result is replaced with clean elide label
    expect(out[2]!.content).toBe("[#m00003 · 20,000t · elided]");
  });

  it("engine render integrates emergency elision when projected tokens exceed threshold", () => {
    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "m0", message: { role: "system", content: "system prompt" } },
      { type: "message", id: "m1", message: { role: "user", content: "run command" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "running..." } },
      { type: "message", id: "m3", message: { role: "toolResult", content: "output line 1\noutput line 2\n" + "X".repeat(5000) } },
      { type: "message", id: "m4", message: { role: "assistant", content: "done" } },
      { type: "message", id: "m5", message: { role: "user", content: "next prompt" } },
    ];

    let projected = 96_000;
    const host = {
      sessionId: () => "sess-guard",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/art",
      windowTokens: () => 100_000,
      projectedTokens: () => projected,
      entries: () => entries,
    };

    const config = configFromPreset("balanced");
    const engine = new OrigamiEngine({
      host,
      entries,
      modelId: "test-model",
      config,
      countFn: (t) => t.length,
    });

    const syncFacts = () => {
      engine.refresh(entries);
      const facts: KernelMessage[] = [];
      for (const e of entries) {
        const f = messageFacts(e.message);
        if (f) facts.push(f);
      }
      engine.ingest(facts);
    };

    syncFacts();

    const makeFold = (text: string, blockId: string) => ({
      role: "custom",
      customType: "origami:fold",
      blockId,
      text,
    });

    // 1. With projectedTokens at 96K (>= 95K elideFillPct): emergency elision fires
    const elidedRender = engine.render(entries.map((e) => e.message), makeFold);
    const toolMsg = elidedRender[3] as { role: string; content: string };
    expect(toolMsg.role).toBe("toolResult");
    expect(toolMsg.content).toContain("· elided]");

    // 2. If projectedTokens drops back to 50K (< 85K): no elision fires
    projected = 50_000;
    const normalRender = engine.render(entries.map((e) => e.message), makeFold);
    const normalToolMsg = normalRender[3] as { role: string; content: string };
    expect(normalToolMsg.content).toContain("output line 1");
  });
});
