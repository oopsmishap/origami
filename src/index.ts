import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { settings, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { countTokens, Encoding as NativeEncoding } from "@oh-my-pi/pi-natives";
import { join } from "node:path";

import { OrigamiRuntime, setRuntime, getRuntime } from "./runtime.ts";
import type { HostBinding } from "./runtime.ts";
import { openDb } from "./persist/db.ts";
import type { OrigamiDb } from "./persist/db.ts";
import { loadOrigamiConfig } from "./config-load.ts";
import type { OrigamiConfig } from "./config.ts";
import { configFromPreset } from "./config.ts";
import { doctrinePrompt } from "./kernel/doctrine.ts";
import { registerTools } from "./tools/index.ts";
import { formatStatusChip } from "./ui/status.ts";
import { buildWorkbenchModel } from "./ui/workbench-model.ts";
import type { WorkbenchKeyOutcome } from "./ui/workbench-model.ts";
import { WorkbenchComponent } from "./ui/workbench.ts";
import { plainFoldCard } from "./tools/display.ts";
import { startDashboardServer, type DashboardInstance } from "./ui/dashboard-server.ts";

const NATIVE_ENCODINGS: Readonly<Record<string, NativeEncoding>> = {
  O200kBase: NativeEncoding.O200kBase,
  Cl100kBase: NativeEncoding.Cl100kBase,
  ClaudeV3: NativeEncoding.ClaudeV3,
  ClaudeV47: NativeEncoding.ClaudeV47,
  ClaudeV5: NativeEncoding.ClaudeV5,
  ClaudeV5Sonnet: NativeEncoding.ClaudeV5Sonnet,
  Qwen3: NativeEncoding.Qwen3,
  DeepSeekV3: NativeEncoding.DeepSeekV3,
  KimiK2: NativeEncoding.KimiK2,
  Glm5: NativeEncoding.Glm5,
  Jev: NativeEncoding.Jev,
};

function countTokensFn(input: string, encoding?: string): number {
  const native = encoding ? NATIVE_ENCODINGS[encoding] : undefined;
  return countTokens(input, native ?? NativeEncoding.O200kBase);
}

const COMPACTION_SETTING_KEYS = [
  "compaction.enabled",
  "compaction.idleEnabled",
  "compaction.supersedeReads",
  "compaction.dropUseless",
] as const;

let disarmed = false;

function disarmCompaction(): void {
  if (disarmed) return;
  for (const key of COMPACTION_SETTING_KEYS) {
    const s = lookup(key);
    if (s) s.override(settings, false);
  }
  disarmed = true;
}

interface SessionRuntimeEntry {
  sessionId: string;
  runtime: OrigamiRuntime;
  db: OrigamiDb;
  config: OrigamiConfig;
}

export default function origamiExtension(api: ExtensionAPI): void {
  const sessions = new Map<string, SessionRuntimeEntry>();
  let lastContext: ExtensionContext | null = null;
  let dashboard: DashboardInstance | null = null;

  function makeHost(ctx: ExtensionContext): HostBinding {
    return {
      sessionId: () => ctx.sessionManager.getSessionId(),
      appendEvent: (op) => {
        api.appendEntry("origami:event", op);
      },
      saveArtifact: (content, toolType) => ctx.sessionManager.saveArtifact(content, toolType),
      windowTokens: () => ctx.getContextUsage()?.contextWindow ?? 0,
      projectedTokens: () => ctx.getContextUsage()?.tokens ?? 0,
      entries: () => ctx.sessionManager.getEntries(),
    };
  }

  function isSubagentDormant(ctx: ExtensionContext, config: OrigamiConfig): boolean {
    if (ctx.agent.kind !== "sub") return false;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    return tokens < config.subagentActivateTokens;
  }

  function getOrInitRuntime(ctx: ExtensionContext): SessionRuntimeEntry {
    lastContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    let entry = sessions.get(sessionId);
    if (entry) {
      setRuntime(entry.runtime);
      return entry;
    }

    let config: OrigamiConfig;
    try {
      config = loadOrigamiConfig({
        agentDir: getAgentDir(),
        projectDir: ctx.cwd,
      });
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `origami config error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
      config = configFromPreset("balanced");
    }

    if (ctx.agent.kind === "main") {
      disarmCompaction();
    }

    const host = makeHost(ctx);
    const modelId = ctx.model?.id ?? "";
    const runtime = new OrigamiRuntime({
      host,
      modelId,
      config,
      countFn: countTokensFn,
    });

    const dbPath = join(getAgentDir(), "origami.db");
    const db = openDb(dbPath);
    runtime.attachDb(db);

    entry = { sessionId, runtime, db, config };
    sessions.set(sessionId, entry);
    setRuntime(runtime);
    return entry;
  }

  function resolveRuntimeForTool(ctx?: ExtensionContext): OrigamiRuntime {
    const c = ctx ?? lastContext;
    if (!c) {
      const active = getRuntime();
      if (!active) throw new Error("origami: runtime not initialized");
      return active;
    }

    const entry = getOrInitRuntime(c);
    if (isSubagentDormant(c, entry.config)) {
      throw new Error("origami inactive below 40K in subagents");
    }
    return entry.runtime;
  }

  // 1. Register tools
  registerTools(api, (ctx) => resolveRuntimeForTool(ctx));

  // 2. Register fold message renderer
  api.registerMessageRenderer<{ blockId?: string }>("origami:fold", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const lines = content.split("\n");
    const header = lines[0] ?? "origami fold";
    const rest = lines.slice(1).filter((l) => l.trim().length > 0);
    return plainFoldCard(theme, header, rest);
  });

  // 3. Hooks
  api.on("before_agent_start", (event, ctx) => {
    lastContext = ctx;
    getOrInitRuntime(ctx);
    const existing = event.systemPrompt ?? [];
    return {
      systemPrompt: [...existing, doctrinePrompt()],
    };
  });

  api.on("turn_start", (_event, ctx) => {
    lastContext = ctx;
    const entry = getOrInitRuntime(ctx);
    entry.runtime.engine.onTurnStart();
  });

  api.on("context", (event, ctx) => {
    lastContext = ctx;
    const entry = getOrInitRuntime(ctx);

    if (isSubagentDormant(ctx, entry.config)) {
      return { messages: event.messages };
    }

    const rt = entry.runtime;
    rt.sync();

    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus("origami", formatStatusChip(rt.engine.status()));
      } catch {
        // UI status update optional
      }
    }

    const rendered = rt.engine.render(event.messages, (text: string, blockId: string, refTag?: string) => ({
      role: "custom",
      customType: "origami:fold",
      content: refTag ? `${refTag} ${text}` : text,
      display: true,
      details: { blockId },
      timestamp: Date.now(),
    }));

    const decision = rt.engine.decideNudge();
    const nudgeText = decision.text ?? rt.engine.nudgeText;
    if (nudgeText) {
      rendered.push({
        role: "developer",
        content: [{ type: "text", text: nudgeText }],
        timestamp: Date.now(),
      } as never);
    }

    return { messages: rendered as never };
  });

  api.on("auto_compaction_start", (_event, ctx) => {
    lastContext = ctx;
    const entry = getOrInitRuntime(ctx);
    if (isSubagentDormant(ctx, entry.config)) return;

    const rt = entry.runtime;
    rt.sync();

    const ranges = rt.engine.recommendedRanges(64);
    if (ranges.length === 0) return;

    const refRanges = ranges.map((r) => ({ start: r.start, end: r.end }));
    const summary = rt.engine.archiveText(refRanges);
    const specs = [
      {
        range: ranges.map((r) => `${r.start}..${r.end}`).join(","),
        topic: "context archive (host compaction)",
        summary: summary || "emergency archive before host compaction",
      },
    ];
    rt.engine.executeFold({ folds: specs, tier: 1 });
  });

  api.on("assistant_message", (event, ctx) => {
    lastContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const entry = sessions.get(sessionId);
    if (!entry) return;

    const usage = event.message.usage;
    if (!usage) return;

    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const totalIn = (usage.input ?? 0) + cacheRead + cacheWrite;

    entry.runtime.engine.recordRound({
      ts: Date.now(),
      totalIn,
      cacheRead,
      cacheWrite,
      foldEventId: null,
    });
  });

  api.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const entry = sessions.get(sessionId);
    if (entry) {
      try {
        entry.db.close();
      } catch {
        // ignore close error on shutdown
      }
      sessions.delete(sessionId);
      if (getRuntime() === entry.runtime) {
        setRuntime(null);
      }
      if (sessions.size === 0 && dashboard) {
        dashboard.stop();
        dashboard = null;
      }
    }
  });

  // 4. Workbench overlay
  async function openWorkbench(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const entry = getOrInitRuntime(ctx);
    const rt = entry.runtime;
    rt.sync();

    const report = rt.engine.status();
    const rounds = rt.engine.cacheRounds();
    const windowTokens = ctx.getContextUsage()?.contextWindow ?? 0;
    const model = buildWorkbenchModel(report, rounds, windowTokens);

    await ctx.ui.custom<WorkbenchKeyOutcome>(
      (tui, _theme, _kb, done) =>
        new WorkbenchComponent({
          model,
          actions: {
            model: () => model,
            previewFold: () => rt.engine.recommendedRanges().map((r) => `${r.start}..${r.end} (${r.tokens}t)`),
            unfoldSelected: async (id) => {
              const res = await rt.engine.unfoldArtifact(id);
              return res.ok ? `unfolded ${id} to ${res.path}` : `error: ${res.error}`;
            },
            drill: (id) => {
              const block = rt.engine.state.tree.get(id);
              if (!block) return [`block ${id} not found`];
              return [
                `${block.id} · tier ${block.tier} · ${block.topic}`,
                `ranges: ${block.ranges.map((r) => `${r.start}..${r.end}`).join(", ")}`,
                `tokens: ${block.tokensBefore} -> ${block.tokensAfter}`,
                "",
                block.summary,
              ];
            },
          },
          tui,
          onOutcome: (outcome) => {
            if (outcome.close) done(outcome);
            else if (outcome.message) ctx.ui.notify(outcome.message, "info");
          },
        }),
      { overlay: true },
    );
  }
  async function openWebDashboard(ctx: ExtensionContext): Promise<void> {
    if (!dashboard) {
      dashboard = await startDashboardServer({
        getRuntime: () => getRuntime(),
        openBrowser: true,
      });
      if (ctx.hasUI) ctx.ui.notify(`origami dashboard running at ${dashboard.url}`, "info");
    } else {
      dashboard.broadcast("refresh", {});
    }
  }

  api.registerCommand("fold", {
    description: "Open the origami fold workbench (or '/fold web' for browser dashboard)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "web") {
        await openWebDashboard(ctx);
        return;
      }
      await openWorkbench(ctx);
    },
  });

  api.registerShortcut("alt+f", {
    description: "Open the origami fold workbench",
    handler: async (ctx: ExtensionContext) => {
      await openWorkbench(ctx);
    },
  });
}
