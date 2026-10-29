import { describe, expect, it } from "bun:test";
import { annotateCachedPrefix } from "../src/kernel/cache-zones.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { configFromPreset } from "../src/config.ts";
import { messageFacts } from "../src/kernel/message-facts.ts";
import type { KernelMessage } from "../src/kernel/types.ts";

const zones = [
  { kind: "protected", start: "m00001", end: "m00001", tokens: 100, messages: 1 },
  { kind: "folded", start: "m00002", end: "m00010", tokens: 60, messages: 9 },
  { kind: "compressible", start: "m00011", end: "m00016", tokens: 140, messages: 6 },
];

describe("cached prefix context zones", () => {
  it("subtracts prompt overhead, then marks full and partial zones in context order", () => {
    expect(annotateCachedPrefix(zones, 1_230, 1_000)).toEqual([
      { ...zones[0]!, cachedTokens: 100, cacheCoverage: "full" },
      { ...zones[1]!, cachedTokens: 60, cacheCoverage: "full" },
      { ...zones[2]!, cachedTokens: 70, cacheCoverage: "partial" },
    ]);
  });

  it("reports no cached zone when the provider read only prompt overhead", () => {
    expect(annotateCachedPrefix(zones, 900, 1_000).map((z) => [z.cachedTokens, z.cacheCoverage])).toEqual([
      [0, "none"],
      [0, "none"],
      [0, "none"],
    ]);
  });

  it("keeps the latest round in memory when SQLite persistence is unavailable", () => {
    const raw = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ];
    const entries = raw.map((message, i) => ({ type: "message" as const, id: `e${i}`, message }));
    const engine = new OrigamiEngine({
      host: {
        sessionId: () => "cache-zones",
        appendEvent: () => {},
        saveArtifact: async () => "",
        windowTokens: () => 10_000,
        projectedTokens: () => 40,
      },
      entries,
      modelId: "test",
      config: { ...configFromPreset("balanced"), protectedTailMessages: 0, protectedTailTokens: 0 },
      countFn: (text) => text.length,
    });
    engine.refresh(entries);
    engine.ingest(raw.map((m) => messageFacts(m)).filter((m): m is KernelMessage => m !== null));
    engine.recordRound({ ts: 1, totalIn: 40, cacheRead: 20, cacheWrite: 0, foldEventId: null, hostRewrite: false });

    const status = engine.status();
    expect(status.zones.reduce((sum, z) => sum + z.cachedTokens, 0)).toBeGreaterThan(0);
    expect(status.zones.some((z) => z.cacheCoverage !== "none")).toBe(true);
  });
});
