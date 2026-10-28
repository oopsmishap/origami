import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";

describe("Fold/unfold round-trip", () => {
  it("folds message range, unfolds inline with byte-exact message restoration, and unfolds to file artifact", async () => {
    const journal: JournalOp[] = [];
    const entries = [
      { type: "message", id: "m0", message: { role: "system", content: "You are an assistant." } },
      { type: "message", id: "m1", message: { role: "user", content: "Initial prompt at head" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "Response at head" } },
      { type: "message", id: "m3", message: { role: "user", content: "Refactor the authentication middleware to use JWT" } },
      {
        type: "message",
        id: "m4",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "Verifying JWT library signatures...", thinkingSignature: "sig_jwt_abc123" },
            { type: "text", text: "Here is the rewritten middleware using jsonwebtoken verify." },
          ],
        },
      },
      { type: "message", id: "m5", message: { role: "user", content: "Add rate limiting next" } },
      { type: "message", id: "m6", message: { role: "assistant", content: "Rate limiting middleware configured at 100 req/min" } },
      { type: "message", id: "m7", message: { role: "user", content: "In-flight current turn question" } },
    ];

    const artifacts = new Map<string, string>();
    const host = {
      sessionId: () => "sess-roundtrip",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async (content: string, toolType: string) => {
        const path = `/.omp/artifacts/${toolType}-${Date.now()}.md`;
        artifacts.set(path, content);
        return path;
      },
      windowTokens: () => 100_000,
      projectedTokens: () => 15_000,
      entries: () => entries,
    };

    // Recent-tail protection off: this fixture folds turn 2 of a 4-turn session.
    const config = { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0, minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 };
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

    const makeFold = (text: string, blockId: string, refTag?: string) => ({
      role: "custom",
      customType: "origami:fold",
      blockId,
      text: refTag ? `${refTag} ${text}` : text,
    });

    // 1. Initial render before fold: all 8 messages present
    const initialRender = engine.render(entries.map((e) => e.message), makeFold);
    expect(initialRender.length).toBe(8);

    // 2. Execute fold on turn 2 (m00004..m00005)
    // Ref mapping: m0=ephemeral(system), m1=m00002, m2=m00003, m3=m00004, m4=m00005, m5=m00006, m6=m00007, m7=m00008
    const foldRes = engine.executeFold({
      folds: [
        {
          range: "m00004..m00005",
          topic: "JWT Auth Middleware",
          summary: "Refactored authentication middleware to verify JWT tokens with signature preservation.",
        },
      ],
      tier: 1,
    });

    expect(foldRes.ok).toBe(true);
    expect(journal.length).toBe(1);
    expect(journal[0]!.op).toBe("fold");

    // 3. Render after fold: m00004 and m00005 are replaced by 1 custom fold block
    const foldedRender = engine.render(entries.map((e) => e.message), makeFold);
    // 8 - 2 (covered) + 1 (fold block) = 7
    expect(foldedRender.length).toBe(7);

    const foldBlockMsg = foldedRender.find(
      (m: unknown): m is { customType: string; blockId: string; text: string } =>
        Boolean(m && typeof m === "object" && "customType" in m && m.customType === "origami:fold"),
    );
    expect(foldBlockMsg).toBeDefined();
    if (!foldBlockMsg) return;
    expect(foldBlockMsg.blockId).toBe("b1");
    expect(foldBlockMsg.text).toContain("JWT Auth Middleware");
    expect(foldBlockMsg.text).toContain("[#m00004]");

    // Verify surviving assistant messages were not mutated (e.g. thinking signature byte-exact)
    const asstTurn3 = foldedRender[5] as { role: string; content: string };
    expect(asstTurn3.content).toBe("Rate limiting middleware configured at 100 req/min");

    // 4. Test Mode 2: Unfold to artifact file
    const fileRes = await engine.unfoldArtifact("b1");
    expect(fileRes.ok).toBe(true);
    if (!fileRes.ok) return;

    expect(artifacts.has(fileRes.path)).toBe(true);
    const artifactContent = artifacts.get(fileRes.path)!;
    expect(artifactContent).toContain("# b1 — JWT Auth Middleware");
    expect(artifactContent).toContain("JWT Auth Middleware");
    expect(artifactContent).toContain("Refactor the authentication middleware to use JWT");
    expect(artifactContent).toContain("jsonwebtoken verify");
    expect(fileRes.toc).toContain("m00004");
    expect(fileRes.toc).toContain("m00005");

    // 5. Test Mode 1: Unfold inline
    const inlineRes = engine.executeUnfold("b1");
    expect(inlineRes.ok).toBe(true);
    expect(journal.length).toBe(2);
    expect(journal[1]!.op).toBe("unfold");

    // Re-render after inline unfold: block is unfolded, original messages restored
    const unfoldedRender = engine.render(entries.map((e) => e.message), makeFold);
    expect(unfoldedRender.length).toBe(8);

    // Verify restored messages are byte-for-byte identical to original
    const restoredUser = unfoldedRender[3] as { role: string; content: string };
    expect(restoredUser.role).toBe("user");
    expect(restoredUser.content).toBe("Refactor the authentication middleware to use JWT");

    const restoredAsst = unfoldedRender[4] as {
      role: string;
      content: { type: string; text?: string; thinkingSignature?: string }[];
    };
    expect(restoredAsst.role).toBe("assistant");
    expect(Array.isArray(restoredAsst.content)).toBe(true);
    expect(restoredAsst.content[0]!.type).toBe("thinking");
    expect(restoredAsst.content[0]!.thinkingSignature).toBe("sig_jwt_abc123");
    expect(restoredAsst.content[1]!.text).toBe("Here is the rewritten middleware using jsonwebtoken verify.");
  });
});
