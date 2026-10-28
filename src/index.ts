import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getAgentDir, settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { countTokens, Encoding as NativeEncoding } from "@oh-my-pi/pi-natives";
import { join } from "node:path";

import { loadOrigamiConfig } from "./config-load.ts";
import { configFromPreset, type OrigamiConfig } from "./config.ts";
import { doctrinePrompt } from "./kernel/doctrine.ts";
import { openDb, type OrigamiDb } from "./persist/db.ts";
import { getRuntime, OrigamiRuntime, setRuntime, type HostBinding } from "./runtime.ts";
import { OrigamiFoldMessageComponent, type OrigamiFoldMessageDetails } from "./tools/display.ts";
import { registerTools } from "./tools/index.ts";
import { startDashboardServer, type DashboardInstance } from "./ui/dashboard-server.ts";
import { formatStatusChip } from "./ui/status.ts";
import { buildWorkbenchModel, type WorkbenchKeyOutcome } from "./ui/workbench-model.ts";
import { WorkbenchComponent } from "./ui/workbench.ts";

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

  function updateUiStatus(rt: OrigamiRuntime, ctx?: ExtensionContext | null): void {
    const target = ctx ?? lastContext;
    if (!target?.hasUI) return;
    try {
      target.ui.setStatus("origami", formatStatusChip(rt.engine.status(), target.ui.theme));
    } catch {
      // UI status update optional
    }
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

  // 1. Register inline tools + live SSE/status broadcast hook
  registerTools(
    api,
    (ctx) => resolveRuntimeForTool(ctx),
    (event, payload, ctx) => {
      const activeRt = getRuntime();
      if (activeRt) updateUiStatus(activeRt, ctx);
      dashboard?.broadcast(event, payload);
    },
  );

  // 2. Register first-party transcript fold divider renderer (role: omp.compaction)
  api.registerMessageRenderer<OrigamiFoldMessageDetails>("origami:fold", (message, options) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new OrigamiFoldMessageComponent(content, message.details, Boolean(options?.expanded));
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
    updateUiStatus(rt, ctx);

    const rendered = rt.engine.render(event.messages, (text: string, blockId: string, refTag?: string) => {
      const block = rt.engine.state.tree.get(blockId);
      const details: OrigamiFoldMessageDetails = {
        blockId,
        ...(block
          ? {
              tier: block.tier,
              topic: block.topic,
              coverage: block.ranges.map((r) => `${r.start}..${r.end}`).join(", "),
              tokensBefore: block.tokensBefore,
              tokensAfter: block.tokensAfter,
            }
          : {}),
      };
      return {
        role: "custom",
        customType: "origami:fold",
        content: refTag ? `${refTag} ${text}` : text,
        display: true,
        details,
        timestamp: Date.now(),
      };
    });

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
    const res = rt.engine.executeFold({ folds: specs, tier: 1 });
    if (res.ok) {
      updateUiStatus(rt, ctx);
      dashboard?.broadcast("fold", res.outcome);
    }
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

    const round = {
      ts: Date.now(),
      totalIn,
      cacheRead,
      cacheWrite,
      foldEventId: null,
    };
    entry.runtime.engine.recordRound(round);
    updateUiStatus(entry.runtime, ctx);
    dashboard?.broadcast("round", round);
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
  async function openWorkbench(ctx: ExtensionContext, initialTab = 0): Promise<void> {
    if (!ctx.hasUI) return;
    const entry = getOrInitRuntime(ctx);
    const rt = entry.runtime;

    const buildCurrentModel = () => {
      rt.sync();
      const report = rt.engine.status();
      const rounds = rt.engine.cacheRounds();
      const windowTokens = ctx.getContextUsage()?.contextWindow ?? 0;
      const recommended = rt.engine.recommendedRanges();
      return buildWorkbenchModel(report, rounds, windowTokens, initialTab, 0, recommended);
    };

    const model = buildCurrentModel();

    await ctx.ui.custom<WorkbenchKeyOutcome>(
      (tui, _theme, _kb, done) =>
        new WorkbenchComponent({
          model,
          actions: {
            model: () => model,
            refresh: () => buildCurrentModel(),
            previewFold: () =>
              rt.engine.recommendedRanges().map((r) => `${r.start}..${r.end} (${formatStatusTokens(r.tokens)})`),
            unfoldSelected: async (id, mode = "file") => {
              rt.sync();
              if (mode === "inline") {
                const res = rt.engine.executeUnfold(id);
                if (!res.ok) return `Unfold failed: ${res.error}`;
                updateUiStatus(rt, ctx);
                dashboard?.broadcast("unfold", { id, mode: "inline" });
                return `Unfolded ${id} inline (${res.refs.length} messages reactivated)`;
              }
              const res = await rt.engine.unfoldArtifact(id);
              if (!res.ok) return `Unfold failed: ${res.error}`;
              dashboard?.broadcast("unfold", { id, mode: "file", path: res.path });
              return `Unfolded ${id} → ${res.path}`;
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
      if (ctx.hasUI) ctx.ui.notify(`Origami dashboard running at ${dashboard.url}`, "info");
    } else {
      dashboard.broadcast("refresh", {});
      if (ctx.hasUI) ctx.ui.notify(`Origami dashboard live at ${dashboard.url}`, "info");
    }
  }

  const foldSubcommands = [
    { label: "trajectory", value: "trajectory", description: "Open the context trajectory graph" },
    { label: "blocks", value: "blocks", description: "Open the fold block browser" },
    { label: "zones", value: "zones", description: "Open the context zones view" },
    { label: "web", value: "web", description: "Open the browser dashboard" },
  ];

  api.registerCommand("fold", {
    description: "Open the Origami context workbench ('/fold trajectory' for graph, '/fold web' for browser UI)",
    getArgumentCompletions(argumentPrefix) {
      if (argumentPrefix.trimStart().includes(" ")) return null;
      const normalized = argumentPrefix.trim().toLowerCase();
      const matches = foldSubcommands.filter((item) => item.label.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().toLowerCase();
      if (sub === "web" || sub === "dashboard") {
        await openWebDashboard(ctx);
        return;
      }
      if (sub === "trajectory" || sub === "graph" || sub === "chart") {
        await openWorkbench(ctx, 1);
        return;
      }
      if (sub === "blocks") {
        await openWorkbench(ctx, 2);
        return;
      }
      if (sub === "zones") {
        await openWorkbench(ctx, 3);
        return;
      }
      await openWorkbench(ctx, 0);
    },
  });

  api.registerShortcut("alt+f", {
    description: "Open the Origami context workbench",
    handler: async (ctx: ExtensionContext) => {
      await openWorkbench(ctx, 0);
    },
  });
}

function formatStatusTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}t`;
}
