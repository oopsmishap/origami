import { describe, expect, it } from "bun:test";
import origamiExtension from "../src/index.ts";
import { sessionRegistry } from "../src/sessions.ts";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

describe("Host disarm proof", () => {
  /**
   * The full disarm set. Every id must resolve in omp's registry: a key that does not
   * exist makes the override a silent no-op, which is how two invented ids
   * (`compaction.memoryEnabled`, `compaction.shakeEnabled`) previously went unnoticed.
   */
  const DISARM_KEYS = [
    "compaction.enabled",
    "compaction.idleEnabled",
    "compaction.midTurnEnabled",
    "compaction.modelThresholdsEnabled",
    "compaction.experimentalContextManagement",
    "compaction.asyncEnabled",
    "compaction.autoContinue",
    "compaction.supersedeReads",
    "compaction.dropUseless",
  ] as const;

  it("every disarm key is a real omp boolean setting", async () => {
    await Settings.init({ inMemory: true });
    for (const k of DISARM_KEYS) {
      const s = lookup(k);
      expect({ key: k, resolved: s !== undefined }).toEqual({ key: k, resolved: true });
      expect({ key: k, type: s?.type }).toEqual({ key: k, type: "boolean" });
    }
  });

  it("disarms every compaction.* prefix-rewrite setting on main agent session initialization", async () => {
    await Settings.init({ inMemory: true });
    // 1. Initial state: force every key true so the assertion cannot pass vacuously.
    for (const k of DISARM_KEYS) {
      const s = lookup(k);
      expect(s).toBeDefined();
      if (s) s.override(settings, true);
    }
    for (const k of DISARM_KEYS) expect(lookup(k)!.get(settings)).toBe(true);


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
          Boolean: (b: unknown) => b,
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

    const started = beforeStart({ systemPrompt: ["test prompt"] }, mainCtx) as { systemPrompt: string[] };
    // The host system prompt stays first and intact; the doctrine is only appended after it.
    expect(started.systemPrompt[0]).toBe("test prompt");
    expect(started.systemPrompt).toHaveLength(2);

    // 5. Verify every key in the disarm set is now false.
    for (const k of DISARM_KEYS) {
      expect({ key: k, value: lookup(k)!.get(settings) }).toEqual({ key: k, value: false });
    }
  });

  it("does not fold when omp host compaction starts; it only records the host rewrite", async () => {
    await Settings.init({ inMemory: true });
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const appended: string[] = [];
    const fakeApi = {
      typebox: {
        Type: new Proxy({}, { get: () => (x: unknown) => x }),
      },
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      appendEntry: (type: string) => {
        appended.push(type);
      },
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    origamiExtension(fakeApi);

    const entries = Array.from({ length: 12 }, (_, i) => ({
      type: "message",
      id: `e${i}`,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"payload ".repeat(400)}` },
    }));
    const mainCtx = {
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "main-session-compaction",
        getEntries: () => entries,
        saveArtifact: async () => "/tmp/art",
      },
      cwd: "/tmp",
      getContextUsage: () => ({ tokens: 95_000, contextWindow: 100_000 }),
      hasUI: false,
    } as unknown as ExtensionContext;

    handlers.get("before_agent_start")!({ systemPrompt: ["test prompt"] }, mainCtx);
    await handlers.get("auto_compaction_start")!({ reason: "threshold", action: "shake" }, mainCtx);

    expect(appended).not.toContain("origami:event");
    const rt = sessionRegistry().live("main-session-compaction")?.runtime;
    expect(rt).toBeDefined();
    expect(rt!.engine.state.tree.all()).toHaveLength(0);
  });
});
