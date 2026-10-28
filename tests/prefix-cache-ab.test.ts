import { describe, expect, it } from "bun:test";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import type { JournalOp } from "../src/persist/journal.ts";
import type { KernelMessage } from "../src/kernel/types.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";

interface CacheSimulationRound {
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
  hitRate: number;
}

function simulateRound(
  previousPrefix: string[],
  currentMessages: string[],
): { round: CacheSimulationRound; currentPrefix: string[] } {
  // Find common prefix with previous round
  let matchLen = 0;
  while (
    matchLen < previousPrefix.length &&
    matchLen < currentMessages.length &&
    previousPrefix[matchLen] === currentMessages[matchLen]
  ) {
    matchLen++;
  }

  // Token estimate: 100 tokens per message string
  const totalTokens = currentMessages.length * 100;
  const cacheRead = matchLen * 100;
  const cacheWrite = (currentMessages.length - matchLen) * 100;
  const hitRate = totalTokens > 0 ? cacheRead / totalTokens : 0;

  return {
    round: {
      promptTokens: totalTokens,
      cacheRead,
      cacheWrite,
      hitRate,
    },
    currentPrefix: [...currentMessages],
  };
}

describe("Prefix Cache A/B Simulation", () => {
  it("origami preserves cache hit rate >= 75% and keeps prompt tokens in corridor vs uncompressed and full rewrite", () => {
    const turns = 50;
    const journal: JournalOp[] = [];
    const entries: { type: string; id: string; message: { role: string; content: string } }[] = [];

    // System prompt at head (stable)
    entries.push({
      type: "message",
      id: "e0",
      message: { role: "system", content: "You are a helpful coding assistant." },
    });

    const host = {
      sessionId: () => "sess-ab",
      appendEvent: (op: JournalOp) => journal.push(op),
      saveArtifact: async () => "/tmp/art",
      windowTokens: () => 100_000,
      projectedTokens: () => entries.length * 100,
    };

    const config = { ...configFromPreset("balanced"), minFoldBenefitTokens: 0, minFoldBenefitWindowPct: 0 };
    // Configure aggressive fold cadence for simulation: fold whenever 6 messages accumulate
    const engine = new OrigamiEngine({
      host,
      entries,
      modelId: "test-model",
      // Tiny synthetic turns: protect the last 5 messages by count, not the 5K-token floor.
      config: { ...config, growthStep: 600, protectedTailTokens: 0 },
      countFn: (text) => text.length,
    });

    let prevOrigamiPrefix: string[] = [];
    const origamiRounds: CacheSimulationRound[] = [];

    let prevUncompressedPrefix: string[] = [];
    const uncompressedRounds: CacheSimulationRound[] = [];

    let prevCompactedPrefix: string[] = [];
    const compactedRounds: CacheSimulationRound[] = [];

    const uncompressedMessages: string[] = ["system: You are a helpful assistant"];
    const compactedMessages: string[] = ["system: You are a helpful assistant"];

    for (let turn = 1; turn <= turns; turn++) {
      // Add user turn
      const userText = `user query turn ${turn}: inspect module ${turn}`;
      const assistantText = `assistant reply turn ${turn}: result of inspection ${turn} is ok`;

      // 1. Uncompressed
      uncompressedMessages.push(userText, assistantText);
      const uncomp = simulateRound(prevUncompressedPrefix, uncompressedMessages);
      uncompressedRounds.push(uncomp.round);
      prevUncompressedPrefix = uncomp.currentPrefix;

      // 2. Full-history compaction baseline (compacts all previous history every 10 turns)
      if (turn % 10 === 0) {
        // Rewrite history: replaces all past turns with one single compaction summary
        compactedMessages.length = 1; // keep only system
        compactedMessages.push(`compaction summary up to turn ${turn}`);
      }
      compactedMessages.push(userText, assistantText);
      const comp = simulateRound(prevCompactedPrefix, compactedMessages);
      compactedRounds.push(comp.round);
      prevCompactedPrefix = comp.currentPrefix;

      // 3. Origami incremental folding
      const userEntry = {
        type: "message",
        id: `e_u_${turn}`,
        message: { role: "user", content: userText },
      };
      const asstEntry = {
        type: "message",
        id: `e_a_${turn}`,
        message: { role: "assistant", content: assistantText },
      };
      entries.push(userEntry, asstEntry);

      engine.refresh(entries);
      const facts: KernelMessage[] = [];
      for (const e of entries) {
        const f = messageFacts(e.message);
        if (f) facts.push(f);
      }
      engine.ingest(facts);

      // Check if origami folds
      const recommended = engine.recommendedRanges();
      if (recommended.length > 0 && turn % 10 === 0) {
        const r = recommended[0]!;
        engine.executeFold({
          folds: [
            {
              range: `${r.start}..${r.end}`,
              topic: `Turn batch fold ${turn}`,
              summary: `Summary of turns covered by ${r.start}..${r.end}`,
            },
          ],
        });
      }

      // Render outbound messages
      const rendered = engine.render(
        entries.map((e) => e.message),
        (text, blockId, refTag) => ({
          role: "custom",
          content: `${refTag ?? ""} [${blockId}] ${text}`,
        }),
      );

      const renderedStrings = rendered.map((m: unknown) => {
        const rec = m as { role?: string; content?: unknown };
        return `${rec.role ?? ""}:${typeof rec.content === "string" ? rec.content : JSON.stringify(rec.content)}`;
      });
      const orig = simulateRound(prevOrigamiPrefix, renderedStrings);
      origamiRounds.push(orig.round);
      prevOrigamiPrefix = orig.currentPrefix;
    }

    // Assertions:
    // A) Final uncompressed prompt size has grown to 50 turns * 2 = 101 messages
    expect(uncompressedMessages.length).toBe(101);

    // B) Origami prompt size is bounded in a flat corridor (< 50 messages)
    const finalOrigamiCount = prevOrigamiPrefix.length;
    expect(finalOrigamiCount).toBeLessThan(50);

    // C) Cache hit rate on late rounds (rounds 20..50)
    const lateOrigamiRounds = origamiRounds.slice(20);
    const avgOrigamiHitRate =
      lateOrigamiRounds.reduce((acc, r) => acc + r.hitRate, 0) / lateOrigamiRounds.length;

    // Origami maintains high prefix cache hit rate (>= 75%) because folding replaces
    // at stable anchor rather than churning the entire prompt
    expect(avgOrigamiHitRate).toBeGreaterThanOrEqual(0.75);

    // D) Native compaction cache write spikes on compaction boundaries
    const compactionSpikeRounds = [10, 20, 30, 40].map((t) => compactedRounds[t - 1]!);
    for (const spike of compactionSpikeRounds) {
      // Hit rate drops to near 0 on full compaction rewrites (only system prompt matches)
      expect(spike.hitRate).toBeLessThan(0.35);
    }
  });
});
