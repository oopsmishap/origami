import { describe, expect, it } from "bun:test";
import {
  createStrategyTracker,
  SoftCompactionStrategy,
  HandoverStrategy,
  OrigamiStrategy,
  type CompactionStrategyName
} from "../bench/compaction-strategies.ts";
import type { JournalEntry } from "../bench/replay-lib.ts";

function createMockEntry(role: "user" | "assistant", content: string, index: number): JournalEntry {
  return {
    type: "message",
    id: `msg-${index}`,
    timestamp: new Date(1700000000000 + index * 60000).toISOString(),
    message: {
      role,
      content
    }
  };
}

describe("Compaction Strategies", () => {
  it("factory instantiates all strategy trackers correctly", () => {
    const names: CompactionStrategyName[] = ["soft", "handover", "origami"];
    for (const name of names) {
      const tracker = createStrategyTracker(name);
      expect(tracker.name).toBe(name);
    }
  });

  it("SoftCompactionStrategy triggers summarization when exceeding threshold", () => {
    const tracker = new SoftCompactionStrategy({ thresholdTokens: 500, keepRecentTokens: 200 });
    // Ingest enough messages to cross 500 tokens
    for (let i = 0; i < 30; i++) {
      const content = `Turn ${i}: [decision] Use SQLite FTS5 for session search. Goal: improve retrieval. File src/engine.ts was modified. Error: None. Padding text to increase token count ${"a".repeat(100)}`;
      tracker.ingest(createMockEntry(i % 2 === 0 ? "user" : "assistant", content, i));
    }

    const res = tracker.render(100000);
    expect(res.strategy).toBe("soft");
    expect(res.metadata.compactionCycles as number).toBeGreaterThan(0);
    // Should have system message, summary message, and kept recent messages
    expect(res.messages.some((m) => m.content.includes("soft compaction summary"))).toBe(true);
  });

  it("HandoverStrategy generates structured handoff context when exceeding threshold", () => {
    const tracker = new HandoverStrategy({ thresholdTokens: 500 });
    for (let i = 0; i < 30; i++) {
      const content = `Turn ${i}: [decision] Keep immutable prefix stable. Task: implement reactive hydration. Files: src/kernel/hydration.ts. More detailed content ${"x".repeat(100)}`;
      tracker.ingest(createMockEntry(i % 2 === 0 ? "user" : "assistant", content, i));
    }

    const res = tracker.render(100000);
    expect(res.strategy).toBe("handover");
    expect(res.metadata.hasHandoff).toBe(true);
    expect(res.messages.some((m) => m.content.includes("<handoff-context>"))).toBe(true);
  });

  it("OrigamiStrategy renders hierarchical folds with active tail and hydration", () => {
    const tracker = new OrigamiStrategy({ preset: "balanced" });
    for (let i = 0; i < 10; i++) {
      tracker.ingest(createMockEntry(i % 2 === 0 ? "user" : "assistant", `Turn ${i} work on Origami engine.`, i));
    }

    const res = tracker.render(100000);
    expect(res.strategy).toBe("origami");
    expect(res.messages[0]!.role).toBe("system");
    expect(res.tokens).toBeGreaterThan(0);
  });
});
