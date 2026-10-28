import { describe, expect, it } from "bun:test";
import { SessionRegistry, type AgentInfo } from "../src/sessions.ts";
import { OrigamiRuntime } from "../src/runtime.ts";
import { configFromPreset } from "../src/config.ts";
import { startDashboardServer } from "../src/ui/dashboard-server.ts";

const MAIN: AgentInfo = { kind: "main", id: "Main", name: "main", depth: 0, parentId: null };
const sub = (id: string, parentId: string): AgentInfo => ({ kind: "sub", id, name: id.toLowerCase(), depth: 1, parentId });

function runtime(sessionId: string, windowTokens: number) {
  const entries = [
    { type: "message", id: "u1", message: { role: "user", content: `hello from ${sessionId}` } },
    { type: "message", id: "a1", message: { role: "assistant", content: "hi" } },
  ];
  const rt = new OrigamiRuntime({
    host: {
      sessionId: () => sessionId,
      appendEvent: () => {},
      saveArtifact: async () => "/tmp/unused.md",
      windowTokens: () => windowTokens,
      projectedTokens: () => windowTokens / 4,
      entries: () => entries,
    },
    modelId: "test",
    config: configFromPreset("balanced"),
    countFn: (t) => t.length,
  });
  rt.sync();
  return rt;
}

function register(registry: SessionRegistry, sessionId: string, agent: AgentInfo, windowTokens = 100_000) {
  return registry.register({ sessionId, agent, runtime: runtime(sessionId, windowTokens), config: configFromPreset("balanced"), ctx: null });
}

describe("session registry", () => {
  it("keeps the main session primary while subagents start and run", () => {
    const registry = new SessionRegistry();
    register(registry, "main-1", MAIN);
    register(registry, "sub-1", sub("0-Explore", "Main"));
    registry.touch("sub-1", { dormant: false });
    expect(registry.primary()!.sessionId).toBe("main-1");
    register(registry, "sub-2", sub("0-Explore.1-Task", "0-Explore"));
    expect(registry.primary()!.sessionId).toBe("main-1");
    expect(registry.rootOf("sub-2")!.sessionId).toBe("main-1");
  });

  it("nests subagents under their spawning session and keeps ended ones visible", () => {
    const registry = new SessionRegistry();
    register(registry, "main-1", MAIN);
    register(registry, "sub-1", sub("0-Explore", "Main"));
    register(registry, "sub-2", sub("0-Explore.1-Task", "0-Explore"));
    registry.end("sub-1");

    const tree = registry.tree();
    expect(tree.map((n) => n.sessionId)).toEqual(["main-1"]);
    expect(tree[0]!.children.map((n) => n.sessionId)).toEqual(["sub-1"]);
    expect(tree[0]!.children[0]!.children.map((n) => n.sessionId)).toEqual(["sub-2"]);
    expect(registry.flatTree().map((s) => [s.sessionId, s.level, s.phase])).toEqual([
      ["main-1", 0, "active"],
      ["sub-1", 1, "ended"],
      ["sub-2", 2, "dormant"],
    ]);
    // The ended session keeps its last status snapshot for the UI.
    expect(registry.get("sub-1")!.lastStatus?.windowTokens).toBe(100_000);
  });

  it("falls back to another live session only when no main session is live", () => {
    const registry = new SessionRegistry();
    register(registry, "main-1", MAIN);
    register(registry, "sub-1", sub("0-Explore", "Main"));
    registry.end("main-1");
    expect(registry.primary()!.sessionId).toBe("sub-1");
    registry.end("sub-1");
    expect(registry.primary()).toBeDefined();
    expect(registry.hasLive()).toBe(false);
  });
});

describe("dashboard session routing", () => {
  it("serves the main session by default and any session by id", async () => {
    const registry = new SessionRegistry();
    register(registry, "main-1", MAIN, 200_000);
    register(registry, "sub-1", sub("0-Explore", "Main"), 50_000);
    registry.touch("sub-1", { dormant: false });
    const dashboard = await startDashboardServer({ port: 3900, registry, openBrowser: false });
    const base = `http://127.0.0.1:${dashboard.port}`;
    const headers = { "X-Origami-Token": dashboard.token };
    try {
      const status = async (q = "") => (await (await fetch(`${base}/api/status${q}`, { headers })).json()) as { sessionId: string; windowTokens: number };
      // A subagent being the latest-touched session must not move the default view.
      expect(await status()).toMatchObject({ sessionId: "main-1", windowTokens: 200_000 });
      expect(await status("?session=sub-1")).toMatchObject({ sessionId: "sub-1", windowTokens: 50_000 });
      expect((await fetch(`${base}/api/status?session=nope`, { headers })).status).toBe(404);

      const sessions = (await (await fetch(`${base}/api/sessions`, { headers })).json()) as {
        primary: string;
        tree: { sessionId: string; children: { sessionId: string }[] }[];
      };
      expect(sessions.primary).toBe("main-1");
      expect(sessions.tree.map((n) => [n.sessionId, n.children.map((c) => c.sessionId)])).toEqual([["main-1", ["sub-1"]]]);

      registry.end("sub-1");
      expect(await status("?session=sub-1")).toMatchObject({ sessionId: "sub-1", windowTokens: 50_000 });
      const unfold = await fetch(`${base}/api/unfold?session=sub-1`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "b1" }),
      });
      expect(unfold.status).toBe(409);
    } finally {
      dashboard.stop();
    }
  });
});
