import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import origamiExtension from "../src/index.ts";
import { sessionRegistry } from "../src/sessions.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/kernel/journal.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

beforeAll(async () => {
  await Settings.init({ inMemory: true });
});

/**
 * A plugin can swap the session to a restricted tool roster that removes `fold`
 * (observed live: 18 consecutive "Tool fold not found" calls while the emergency
 * nudge kept demanding a fold). Nudges and candidate notes must be suppressed when
 * the tool is absent, and emergency folding must then run extractively in-process.
 */
function harness(sessionId: string, opts: { activeTools?: string[] | null; tokens?: number }) {
  const handlers = new Map<string, Handler>();
  const journal: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
  const fakeApi = {
    typebox: { Type: new Proxy({}, { get: () => (x: unknown) => x }) },
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", id: `j${journal.length}`, customType, data }),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    ...(opts.activeTools !== null ? { getActiveTools: () => opts.activeTools } : {}),
  } as unknown as ExtensionAPI;
  origamiExtension(fakeApi);

  journal.push({ type: "message", id: "u0", message: { role: "user", content: "big task" } });
  for (let i = 1; i < 40; i++) {
    journal.push({
      type: "message",
      id: `e${i}`,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"finished work on the parser module ".repeat(60)}` },
    });
  }
  journal.push({ type: "message", id: "u99", message: { role: "user", content: "next task please" } });

  const ctx = {
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => journal,
      saveArtifact: async () => "/tmp/art",
    },
    cwd: "/tmp",
    getContextUsage: () => ({ tokens: opts.tokens ?? 60_000, contextWindow: 100_000 }),
    hasUI: false,
  } as unknown as ExtensionContext;

  handlers.get("before_agent_start")!({ systemPrompt: [] }, ctx);
  const record = sessionRegistry().live(sessionId)!;
  Object.assign(record.config, {
    speculativeFolds: false,
    growthStep: 1000,
    compressibleFloor: 500,
    protectedTailMessages: 2,
    protectedTailTokens: 0,
    minFoldBenefitTokens: 0,
    minFoldBenefitWindowPct: 0,
    minFoldFillPct: 0,
    minFoldFillCapTokens: 0,
    paybackHorizonTurns: 0,
  });
  const messages = () => journal.filter((e) => e.message).map((e) => e.message!);
  const context = () => handlers.get("context")!({ messages: messages() }, ctx) as { messages: { role: string; content: unknown }[] };
  const developerTexts = (out: { messages: { role: string; content: unknown }[] }) =>
    out.messages.filter((m) => m.role === "developer").map((m) => (m.content as { text: string }[])[0]!.text);
  return { journal, context, developerTexts };
}

describe("tool roster gating", () => {
  it("emits nudges when the fold tool is in the active roster", () => {
    const h = harness("roster-on", { activeTools: ["read", "fold", "fold_status"] });
    const texts = h.developerTexts(h.context());
    expect(texts.some((t) => t.includes("[origami]"))).toBe(true);
  });

  it("suppresses nudges when fold is not in the roster", () => {
    const h = harness("roster-off", { activeTools: ["vibe_spawn", "vibe_send"] });
    const texts = h.developerTexts(h.context());
    expect(texts.some((t) => t.includes("[origami]"))).toBe(false);
  });

  it("keeps nudges when the host does not expose getActiveTools", () => {
    const h = harness("roster-unknown", { activeTools: null });
    const texts = h.developerTexts(h.context());
    expect(texts.some((t) => t.includes("[origami]"))).toBe(true);
  });

  it("auto-folds extractively at the emergency threshold when fold is unavailable", () => {
    const h = harness("roster-emergency", { activeTools: ["vibe_spawn"], tokens: 95_000 });
    h.context();
    const foldEvents = h.journal.filter((e) => e.customType === JOURNAL_ENTRY_TYPE);
    expect(foldEvents.length).toBeGreaterThan(0);
  });
});
