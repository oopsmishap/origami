import { describe, expect, it } from "bun:test";
import origamiExtension from "../src/index.ts";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

describe("Host disarm proof", () => {
  it("disarms the four compaction.* settings on main agent session initialization", async () => {
    await Settings.init({ inMemory: true });
    // 1. Initial state: ensure settings are initially enabled/true for the test
    const keys = [
      "compaction.enabled",
      "compaction.idleEnabled",
      "compaction.supersedeReads",
      "compaction.dropUseless",
    ];

    for (const k of keys) {
      const s = lookup(k);
      expect(s).toBeDefined();
      if (s) s.override(settings, true);
    }

    // Verify they read true
    expect(lookup("compaction.enabled")!.get(settings)).toBe(true);
    expect(lookup("compaction.idleEnabled")!.get(settings)).toBe(true);

    // 2. Set up origami extension with fake API
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const fakeApi = {
      typebox: {
        Type: {
          Object: (o: unknown) => o,
          Array: (a: unknown) => a,
          String: (s: unknown) => s,
          Optional: (x: unknown) => x,
          Union: (u: unknown) => u,
          Literal: (l: unknown) => l,
          Integer: (i: unknown) => i,
        },
      },
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    origamiExtension(fakeApi);

    // 3. Trigger session start with a subagent first: disarm should NOT happen
    const subCtx = {
      agent: { kind: "sub" },
      sessionManager: {
        getSessionId: () => "sub-session-1",
        getEntries: () => [],
        saveArtifact: async () => "/tmp/art",
      },
      cwd: "/tmp",
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000 }),
      hasUI: false,
    } as unknown as ExtensionContext;

    const beforeStart = handlers.get("before_agent_start")!;
    expect(beforeStart).toBeDefined();

    // Run before_agent_start on subagent
    beforeStart({ systemPrompt: ["test prompt"] }, subCtx);

    // Compaction remains true
    expect(lookup("compaction.enabled")!.get(settings)).toBe(true);

    // 4. Trigger on main agent: disarm MUST fire
    const mainCtx = {
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "main-session-1",
        getEntries: () => [],
        saveArtifact: async () => "/tmp/art",
      },
      cwd: "/tmp",
      getContextUsage: () => ({ tokens: 5_000, contextWindow: 100_000 }),
      hasUI: false,
    } as unknown as ExtensionContext;

    beforeStart({ systemPrompt: ["test prompt"] }, mainCtx);

    // 5. Verify all four settings are now false!
    expect(lookup("compaction.enabled")!.get(settings)).toBe(false);
    expect(lookup("compaction.idleEnabled")!.get(settings)).toBe(false);
    expect(lookup("compaction.supersedeReads")!.get(settings)).toBe(false);
    expect(lookup("compaction.dropUseless")!.get(settings)).toBe(false);
  });
});
