import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getAgentDir, settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { countTokens, Encoding as NativeEncoding } from "@oh-my-pi/pi-natives";
import { join } from "node:path";
import { handleRecallToolResult } from "./federation/recall-hook.ts";
import { loadOrigamiConfig } from "./config-load.ts";
import { configFromPreset, type OrigamiConfig } from "./config.ts";
import { doctrinePrompt } from "./kernel/doctrine.ts";
import type { StatusReport } from "./engine.ts";
import type { OrigamiDb } from "./persist/db.ts";
import { OrigamiRuntime, type HostBinding } from "./runtime.ts";
import { agentInfoFrom, sessionDisplayName, sessionRegistry, type SessionRecord } from "./sessions.ts";
import { OrigamiFoldMessageComponent, type OrigamiFoldMessageDetails } from "./tools/display.ts";
import { registerTools } from "./tools/index.ts";
import { startDashboardServer } from "./ui/dashboard-server.ts";
import { formatStatusChip } from "./ui/status.ts";
import { buildWorkbenchModel, type WorkbenchKeyOutcome, type WorkbenchModel, type WorkbenchSession } from "./ui/workbench-model.ts";
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

/** A registered session that is still running. */
interface LiveSession {
  record: SessionRecord;
  rt: OrigamiRuntime;
}

export default function origamiExtension(api: ExtensionAPI): void {
  // Process-global: every extension instance (main + subagents) shares one view,
  // so UIs never follow "whichever session fired a hook last".
  const registry = sessionRegistry();

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

  /**
   * The status chip always describes the root main session (plus a live-subagent
   * count). Subagent activity refreshes the root's chip; it never replaces it.
   */
  function refreshStatusChip(sessionId: string, known?: { sessionId: string; status: StatusReport }): void {
    const root = registry.rootOf(sessionId);
    if (!root?.runtime || root.agent.kind !== "main" || !root.ctx?.hasUI) return;
    try {
      const status = known?.sessionId === root.sessionId ? known.status : root.runtime.engine.status();
      const subagents = registry.descendants(root.sessionId).filter((r) => r.endedAt === null).length;
      root.ctx.ui.setStatus("origami", formatStatusChip(status, root.ctx.ui.theme, subagents));
    } catch {
      // UI status update optional
    }
  }

  function isSubagentDormant(ctx: ExtensionContext, config: OrigamiConfig): boolean {
    if (ctx.agent.kind !== "sub") return false;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    return tokens < config.subagentActivateTokens;
  }

  function getOrInitRuntime(ctx: ExtensionContext): LiveSession {
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = registry.live(sessionId);
    if (existing?.runtime) {
      registry.touch(sessionId, { ctx });
      return { record: existing, rt: existing.runtime };
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

    const rt = new OrigamiRuntime({
      host: makeHost(ctx),
      modelId: ctx.model?.id ?? "",
      config,
      countFn: countTokensFn,
    });

    // One handle per process; recovery notice and retention pruning run only when it is first opened.
    // A database that cannot be opened (newer schema, I/O error) must not take the host down:
    // folding keeps working, only the archive/search persistence is lost for this process.
    let db: OrigamiDb | null = null;
    try {
      db = registry.acquireDb(join(getAgentDir(), "origami.db"), (opened) => {
        if (opened.recovered && ctx.hasUI) {
          ctx.ui.notify(`origami: fold database was corrupt; moved to ${opened.recovered} and recreated`, "warning");
        }
        if (config.retentionDays > 0) {
          opened.prune(Date.now() - config.retentionDays * 86_400_000);
        }
      });
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `origami: fold database unavailable, running without persistence: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    }
    rt.attachDb(db, (error) => {
      if (db) registry.releaseDb(db);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `origami: fold database write failed; persistence disabled for this session: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    });

    const record = registry.register({ sessionId, agent: agentInfoFrom(ctx), runtime: rt, config, ctx });
    return { record, rt };
  }

  function resolveRuntimeForTool(ctx?: ExtensionContext): OrigamiRuntime {
    if (!ctx) {
      const primary = registry.primary()?.runtime;
      if (!primary) throw new Error("origami: runtime not initialized");
      return primary;
    }
    const { record, rt } = getOrInitRuntime(ctx);
    if (isSubagentDormant(ctx, record.config)) {
      throw new Error("origami inactive below 40K in subagents");
    }
    return rt;
  }

  // 1. Register inline tools; mutations are published per session through the registry.
  registerTools(
    api,
    (ctx) => resolveRuntimeForTool(ctx),
    (event, payload, ctx) => {
      const sessionId = ctx?.sessionManager.getSessionId() ?? registry.primary()?.sessionId ?? null;
      registry.emit(event, sessionId, payload);
      if (sessionId) refreshStatusChip(sessionId);
    },
  );

  // 2. Register first-party transcript fold divider renderer (role: omp.compaction)
  api.registerMessageRenderer<OrigamiFoldMessageDetails>("origami:fold", (message, options) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new OrigamiFoldMessageComponent(content, message.details, Boolean(options?.expanded));
  });

  // 3. Hooks
  api.on("before_agent_start", (event, ctx) => {
    const { record } = getOrInitRuntime(ctx);
    const dormant = isSubagentDormant(ctx, record.config);
    registry.touch(record.sessionId, { dormant });
    // Dormant subagents pay no doctrine tokens; if one wakes up, the context hook adds it.
    record.doctrineInSystemPrompt = !dormant;
    if (dormant) return;
    const existing = event.systemPrompt ?? [];
    return {
      systemPrompt: [...existing, doctrinePrompt()],
    };
  });

  api.on("turn_start", (_event, ctx) => {
    getOrInitRuntime(ctx).rt.engine.onTurnStart();
  });

  api.on("context", (event, ctx) => {
    const { record, rt } = getOrInitRuntime(ctx);
    const dormant = isSubagentDormant(ctx, record.config);
    registry.touch(record.sessionId, { dormant });
    if (dormant) {
      return { messages: event.messages };
    }

    rt.sync();
    const makeFoldMessage = (text: string, blockId: string, refTag?: string) => {
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
    };


    const status = rt.engine.status();
    registry.touch(record.sessionId, { status });
    refreshStatusChip(record.sessionId, { sessionId: record.sessionId, status });

    const rendered = rt.engine.render(event.messages, makeFoldMessage);

    if (!record.doctrineInSystemPrompt) {
      rendered.push({
        role: "developer",
        content: [{ type: "text", text: doctrinePrompt() }],
        timestamp: Date.now(),
      } as never);
    }

    const decision = rt.engine.decideNudge();
    const nudgeText = decision.text ?? rt.engine.nudgeText;
    if (nudgeText) {
      rendered.push({
        role: "developer",
        content: [{ type: "text", text: nudgeText }],
        timestamp: Date.now(),
      } as never);
    }
    const hint = rt.engine.recallHintText();
    if (hint) {
      rendered.push({ role: "developer", content: [{ type: "text", text: hint }], timestamp: Date.now() } as never);
    }

    return { messages: rendered as never };
  });

  // Origami is the single compaction authority. The host cannot be cancelled from this event,
  // so record the rewrite for cache attribution and warn once instead of racing it with a fold.
  api.on("auto_compaction_start", (event, ctx) => {
    const { record, rt } = getOrInitRuntime(ctx);
    if (isSubagentDormant(ctx, record.config)) return;
    rt.engine.noteHostRewrite();
    if (ctx.hasUI && !record.hostCompactionWarned) {
      record.hostCompactionWarned = true;
      ctx.ui.notify(`origami: omp host compaction ran (${event.action}); Origami cannot stop it. Check compaction.* settings.`, "warning");
    }
  });

  api.on("assistant_message", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const record = registry.live(sessionId);
    if (!record?.runtime) return;
    registry.touch(sessionId, { ctx });

    const usage = event.message.usage;
    if (!usage) return;

    const rawUsage = usage as unknown as Record<string, unknown>;
    const cacheRead = Number(usage.cacheRead ?? rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens ?? 0) || 0;
    const cacheWrite = Number(usage.cacheWrite ?? rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationInputTokens ?? rawUsage.cache_write ?? 0) || 0;
    const totalIn = (usage.input ?? 0) + cacheRead + cacheWrite;

    const round = {
      ts: Date.now(),
      totalIn,
      cacheRead,
      cacheWrite,
      foldEventId: null,
      hostRewrite: false,
    };
    record.runtime.engine.recordRound(round);
    refreshStatusChip(sessionId);
    registry.emit("round", sessionId, round);
  });
  api.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const record = registry.live(sessionId);
    if (!record?.runtime || isSubagentDormant(ctx, record.config)) return;
    return handleRecallToolResult(event, sessionId, record.runtime);
  });


  api.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const record = registry.live(sessionId);
    if (!record) return;
    const root = registry.rootOf(sessionId);
    const db = record.runtime?.db;
    registry.end(sessionId);
    if (db) registry.releaseDb(db);
    if (root && root.sessionId !== sessionId) refreshStatusChip(root.sessionId);
    if (!registry.hasLive() && registry.dashboard) {
      registry.dashboard.stop();
      registry.dashboard = null;
    }
  });

  // 4. Workbench overlay: opens on the invoking session; `s`/`S` walks the session tree.
  async function openWorkbench(ctx: ExtensionContext, initialTab = 0): Promise<void> {
    if (!ctx.hasUI) return;
    let focusId = getOrInitRuntime(ctx).record.sessionId;

    const sessionRows = (): WorkbenchSession[] =>
      registry.flatTree().map((s) => ({
        sessionId: s.sessionId,
        label: sessionDisplayName(s.agent),
        level: s.level,
        phase: s.phase,
        occupancyPct: s.occupancyPct,
      }));

    const buildFor = (sessionId: string): WorkbenchModel | null => {
      const record = registry.get(sessionId);
      if (!record) return null;
      const rt = record.runtime;
      if (rt) {
        rt.sync();
        const report = rt.engine.status();
        return buildWorkbenchModel(
          report,
          rt.engine.cacheRounds(),
          report.windowTokens,
          initialTab,
          0,
          rt.engine.recommendedRanges(),
          sessionRows(),
          sessionId,
        );
      }
      // Ended session: last snapshot, read-only.
      if (!record.lastStatus) return null;
      return buildWorkbenchModel(record.lastStatus, [], record.lastStatus.windowTokens, initialTab, 0, [], sessionRows(), sessionId);
    };

    const model = buildFor(focusId);
    if (!model) return;
    const focusedRuntime = () => registry.live(focusId)?.runtime ?? null;

    await ctx.ui.custom<WorkbenchKeyOutcome>(
      (tui, _theme, _kb, done) =>
        new WorkbenchComponent({
          model,
          actions: {
            model: () => model,
            refresh: () => buildFor(focusId) ?? model,
            focusSession: (sessionId) => {
              const next = buildFor(sessionId);
              if (next) focusId = sessionId;
              return next;
            },
            previewFold: () =>
              (focusedRuntime()?.engine.recommendedRanges() ?? []).map(
                (r) => `${r.start}..${r.end} (${formatStatusTokens(r.tokens)})`,
              ),
            unfoldSelected: async (id, mode = "file") => {
              const rt = focusedRuntime();
              if (!rt) return "Unfold failed: session has ended";
              rt.sync();
              if (mode === "inline") {
                const res = rt.engine.executeUnfold(id);
                if (!res.ok) return `Unfold failed: ${res.error}`;
                refreshStatusChip(focusId);
                registry.emit("unfold", focusId, { id, mode: "inline" });
                return `Unfolded ${res.unfolded.join(", ")} inline (${res.refs.length} refs)`;
              }
              const res = await rt.engine.unfoldArtifact(id);
              if (!res.ok) return `Unfold failed: ${res.error}`;
              registry.emit("unfold", focusId, { id, mode: "file", path: res.path });
              return `Unfolded ${id} → ${res.path}`;
            },
            drill: (id) => {
              const block = focusedRuntime()?.engine.state.tree.get(id);
              if (!block) return [`block ${id} not found in a running session`];
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
    getOrInitRuntime(ctx);
    if (!registry.dashboard) {
      registry.dashboard = await startDashboardServer({ registry, openBrowser: true });
      if (ctx.hasUI) ctx.ui.notify(`Origami dashboard running at ${registry.dashboard.url}`, "info");
    } else {
      registry.emit("refresh", null, {});
      if (ctx.hasUI) ctx.ui.notify(`Origami dashboard live at ${registry.dashboard.url}`, "info");
    }
  }

  const foldSubcommands = [
    { label: "trajectory", value: "trajectory", description: "Open the context trajectory graph" },
    { label: "blocks", value: "blocks", description: "Open the fold block browser" },
    { label: "zones", value: "zones", description: "Open the context zones view" },
    { label: "web", value: "web", description: "Open the browser dashboard" },
    { label: "export", value: "export", description: "Write this session's blocks, rounds, and archived messages to a JSON artifact" },
  ];

  api.registerCommand("fold", {
    description: "Open the Origami context workbench ('/fold trajectory' for graph, '/fold web' for browser UI, '/fold export' for JSON)",
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
      if (sub === "export") {
        const { record, rt } = getOrInitRuntime(ctx);
        if (!rt.db) {
          if (ctx.hasUI) ctx.ui.notify("Origami export failed: no fold database", "error");
          return;
        }
        const dump = rt.db.exportSession(record.sessionId);
        const path = await ctx.sessionManager.saveArtifact(JSON.stringify(dump, null, 2), "origami-export");
        if (ctx.hasUI) ctx.ui.notify(path ? `Origami export written to ${path}` : "Origami export failed: no artifact path", path ? "info" : "error");
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
