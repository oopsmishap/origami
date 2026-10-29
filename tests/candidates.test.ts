import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import origamiExtension from "../src/index.ts";
import { CANDIDATE_MARKER, candidatePrompt } from "../src/candidates.ts";
import { sessionRegistry } from "../src/sessions.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type ToolDef = { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: { text: string }[]; isError: boolean }> };

beforeAll(async () => {
  await Settings.init({ inMemory: true });
});

function harness(sessionId: string, opts: { speculative?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDef>();
  const journal: { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content: string } }[] = [];
  const fakeApi = {
    typebox: { Type: new Proxy({}, { get: () => (x: unknown) => x }) },
    registerTool: (def: ToolDef) => tools.set(def.name, def),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", id: `j${journal.length}`, customType, data }),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  origamiExtension(fakeApi);

  for (let i = 0; i < 12; i++) {
    journal.push({
      type: "message",
      id: `e${i}`,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"finished work on the parser module ".repeat(60)}` },
    });
  }
  journal.push({ type: "message", id: "e12", message: { role: "user", content: "next task please" } });

  const prompts: string[] = [];
  const ctx = {
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => journal,
      saveArtifact: async () => "/tmp/art",
    },
    cwd: "/tmp",
    getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
    hasUI: false,
    runEphemeralTurn: async (o: { promptText: string }) => {
      prompts.push(o.promptText);
      const range = /ranges (m\d+\.\.m\d+)/.exec(o.promptText)![1]!;
      return { replyText: `Here you go: ${JSON.stringify({ range, topic: "Parser work", summary: "- parser module finished" })}` };
    },
  } as unknown as ExtensionContext;

  handlers.get("before_agent_start")!({ systemPrompt: [] }, ctx);
  const record = sessionRegistry().live(sessionId)!;
  Object.assign(record.config, {
    speculativeFolds: opts.speculative ?? true,
    growthStep: 1000,
    compressibleFloor: 500,
    protectedTailMessages: 2,
    protectedTailTokens: 0,
    minFoldBenefitTokens: 0,
    minFoldBenefitWindowPct: 0,
    paybackHorizonTurns: 0,
  });
  const rt = record.runtime!;
  const messages = () => journal.filter((e) => e.message).map((e) => e.message!);
  const context = (msgs: unknown[] = messages()) =>
    handlers.get("context")!({ messages: msgs }, ctx) as { messages: { role: string; content: unknown }[] };
  const turnEnd = async () => {
    handlers.get("turn_end")!({}, ctx);
    for (let i = 0; i < 20 && rt.candidates.inFlight; i++) await Bun.sleep(1);
  };
  const tool = (name: string, params: unknown) => tools.get(name)!.execute("call", params, undefined, undefined, ctx);
  const developerTexts = (out: { messages: { role: string; content: unknown }[] }) =>
    out.messages.filter((m) => m.role === "developer").map((m) => (m.content as { text: string }[])[0]!.text);
  return { rt, prompts, journal, context, turnEnd, tool, developerTexts, messages };
}

describe("speculative fold candidates", () => {
  it("drafts exactly one candidate per turn end only when enabled", async () => {
    const off = harness("cand-off", { speculative: false });
    await off.turnEnd();
    expect(off.prompts).toHaveLength(0);

    const on = harness("cand-on");
    await on.turnEnd();
    await on.turnEnd();
    expect(on.prompts).toHaveLength(1);
    expect(on.prompts[0]).toContain(CANDIDATE_MARKER);
    expect(on.rt.candidates.pending?.id).toBe("c1");
  });

  it("surfaces the candidate instead of the efficiency nudge, and accept folds it", async () => {
    const h = harness("cand-accept");
    await h.turnEnd();
    const texts = h.developerTexts(h.context());
    expect(texts.some((t) => t.startsWith("[origami] A fold was prepared in the background: c1 covers"))).toBe(true);
    expect(h.rt.engine.nudge.kind).toBe("efficiency");
    expect(texts.some((t) => t.includes("tokens have accumulated since the last fold"))).toBe(false);

    const res = await h.tool("fold_candidate", { id: "c1", action: "accept" });
    expect(res.isError).toBe(false);
    h.rt.sync();
    expect(h.rt.engine.state.tree.live()).toHaveLength(1);
    expect(h.rt.engine.state.tree.live()[0]!.topic).toBe("Parser work");
    expect(h.rt.candidates.pending).toBeNull();
  });

  it("refuses a candidate whose source changed", async () => {
    const h = harness("cand-stale");
    await h.turnEnd();
    for (const e of h.journal.slice(0, 10)) if (e.message) e.message.content += " (edited)";
    const res = await h.tool("fold_candidate", { id: "c1", action: "accept" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("candidate c1 is stale (its source changed); discarded");
    expect(h.rt.engine.state.tree.all()).toHaveLength(0);
  });

  it("renders the side turn without nudges, hints or doctrine", async () => {
    const h = harness("cand-side");
    const msgs = [...h.messages(), { role: "user", content: candidatePrompt([{ start: "m00002", end: "m00009", tokens: 1, messages: 8, toolTokens: 0 }]) }];
    const out = h.context(msgs);
    expect(out.messages.filter((m) => m.role === "developer")).toHaveLength(0);
    expect(out.messages).toHaveLength(msgs.length);
    expect(h.rt.engine.nudge.kind).toBeNull();
  });
});
