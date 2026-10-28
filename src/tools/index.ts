import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { expandRefRange } from "../kernel/render.ts";
import { formatTokens, parseRangeList, type FoldSpec } from "../engine.ts";
import type { OrigamiRuntime } from "../runtime.ts";
import {
  cacheCallView,
  cacheResultView,
  foldCallView,
  foldResultView,
  formatCacheRounds,
  formatFoldOutcome,
  formatSearchHits,
  formatStatusReport,
  renderInlineToolCall,
  renderInlineToolResult,
  searchCallView,
  searchResultView,
  statusCallView,
  statusResultView,
  textResult,
  type ToolDetail,
  recallCallView,
  recallResultView,
  unfoldCallView,
  unfoldResultView,
} from "./display.ts";
import { nativeAvailable } from "../ui/native.ts";
import { recordToolTelemetry } from "../telemetry.ts";

export type ToolMutationListener = (
  event: "fold" | "unfold" | "telemetry",
  payload: unknown,
  ctx?: ExtensionContext,
) => void;

type ToolSchema = ToolDefinition extends ToolDefinition<infer P, unknown> ? P : never;

const RECALL_MAX_REFS = 64;

function registerInlineTool<TParams extends ToolSchema, TDetails = unknown>(
  api: ExtensionAPI,
  def: ToolDefinition<TParams, TDetails>,
): void {
  // Native tool views exist only on Tern-capable hosts; older hosts render ANSI.
  if (!nativeAvailable) {
    delete (def as { describeCall?: unknown }).describeCall;
    delete (def as { describeResult?: unknown }).describeResult;
  }
  api.registerTool(Object.assign(def, { inline: true, mergeCallAndResult: true }));
}

export function registerTools(
  api: ExtensionAPI,
  getRuntime: (ctx?: ExtensionContext) => OrigamiRuntime,
  onMutation?: ToolMutationListener,
): void {
  const t = api.typebox.Type;

  registerInlineTool(api, {
    name: "fold",
    label: "Fold",
    description:
      'Fold conversation ranges into compact summary blocks. Tier 1 compresses message ranges ("m00012..m00048"); tier 2/3 distill whole blocks ("b1..b5" / "b1,b3"). Call with EXACTLY the ranges an [origami] nudge advertises.',
    parameters: t.Object({
      folds: t.Array(
        t.Object({
          range: t.String({ description: 'Range spec: "m00012..m00048" (tier 1) or "b1..b5" (tier 2/3)' }),
          topic: t.String({ description: "One-line domain topic (≤60 chars), e.g. 'Auth token refresh refactor'" }),
          summary: t.String({ description: "Distilled summary adhering to origami doctrine (lossless on decisions)" }),
        }),
        { description: "One or more disjoint fold ranges" },
      ),
      tier: t.Optional(
        t.Union([t.Literal(1), t.Literal(2), t.Literal(3)], {
          description: "Fold tier: 1=message compression, 2=distillation, 3=ultra-dense",
        }),
      ),
    }),
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const inputSummary = `${params.folds.length} range(s) · T${params.tier ?? 1}`;
      const result = rt.engine.executeFold({ folds: params.folds as FoldSpec[], tier: params.tier });
      const durationMs = performance.now() - t0;
      if (!result.ok) {
        const row = recordToolTelemetry(rt, {
          tool: "fold",
          durationMs,
          ok: false,
          error: `${result.error} (fold ${result.foldIndex})`,
          inputSummary,
          outputSummary: `Fold rejected at index ${result.foldIndex}`,
          metrics: { tier: params.tier ?? 1, requestedFolds: params.folds.length, foldIndex: result.foldIndex },
        });
        if (row) onMutation?.("telemetry", row, ctx);
        return textResult(`error: ${result.error} (fold ${result.foldIndex})`, { summary: result.error, rows: [] }, true);
      }
      onMutation?.("fold", result.outcome, ctx);
      const text = formatFoldOutcome(result.outcome);
      const outSummary = `${result.outcome.foldCount} block(s) · -${formatTokens(result.outcome.tokensReclaimed)}t`;
      const row = recordToolTelemetry(rt, {
        tool: "fold",
        durationMs,
        ok: true,
        inputSummary,
        outputSummary: outSummary,
        metrics: {
          tier: params.tier ?? 1,
          blocksCreated: result.outcome.blocks.length,
          tokensReclaimed: result.outcome.tokensReclaimed,
        },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      return textResult(text, {
        summary: outSummary,
        rows: result.outcome.blocks.map(
          (b) => `${b.id} (T${b.tier}) ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.topic}`,
        ),
      });
    },
    describeCall(args) {
      const a = (args ?? {}) as { folds?: FoldSpec[]; tier?: number };
      return foldCallView({ folds: a.folds ?? [], tier: a.tier ?? 1 });
    },
    describeResult(result) {
      return foldResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError));
    },
    renderCall(args, options, uiTheme) {
      const a = (args ?? {}) as { folds?: FoldSpec[]; tier?: number };
      const folds = a.folds ?? [];
      return renderInlineToolCall(
        "Fold",
        `tier ${a.tier ?? 1}`,
        folds.map((f) => `${f.range} · ${f.topic}`),
        options,
        uiTheme,
        folds.length > 0 ? [`${folds.length} range(s)`] : undefined,
      );
    },
    renderResult(result, options, uiTheme, args) {
      const a = (args ?? {}) as { tier?: number };
      return renderInlineToolResult("Fold", "context.compaction", result, options, uiTheme, `tier ${a.tier ?? 1}`);
    },
  });

  registerInlineTool(api, {
    name: "unfold",
    label: "Unfold",
    description:
      "Unfold a folded block: reconstruct its original message bytes to an artifact file (default, cache-safe) or reactivate it inline in context. Inline unfold of a merged (tier 2/3) block restores its child blocks; deep=true restores raw messages.",
    parameters: t.Object({
      id: t.String({ description: 'Block id to unfold, e.g. "b7"' }),
      mode: t.Optional(
        t.Union([t.Literal("file"), t.Literal("inline")], {
          description: "file = artifact (default, cache-safe); inline = reactivate in context",
        }),
      ),
      deep: t.Optional(t.Boolean({ description: "inline only: also unfold every restored child block, down to raw messages" })),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const inputSummary = `${params.id} (${params.mode ?? "file"}${params.deep ? ", deep" : ""})`;
      if (params.mode === "inline") {
        const result = rt.engine.executeUnfold(params.id, { deep: params.deep === true });
        const durationMs = performance.now() - t0;
        if (!result.ok) {
          const row = recordToolTelemetry(rt, {
            tool: "unfold",
            durationMs,
            ok: false,
            error: result.error,
            inputSummary,
            outputSummary: `Inline unfold failed for ${params.id}`,
            metrics: { blockId: params.id, mode: "inline", deep: Boolean(params.deep) },
          });
          if (row) onMutation?.("telemetry", row, ctx);
          return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
        }
        onMutation?.("unfold", { id: params.id, mode: "inline", unfolded: result.unfolded }, ctx);
        const outSummary = `${result.unfolded.length} block(s) unfolded inline`;
        const row = recordToolTelemetry(rt, {
          tool: "unfold",
          durationMs,
          ok: true,
          inputSummary,
          outputSummary: outSummary,
          metrics: { blockId: params.id, mode: "inline", unfoldedCount: result.unfolded.length, refsCovered: result.refs.length },
        });
        if (row) onMutation?.("telemetry", row, ctx);
        return textResult(`unfolded inline: ${result.unfolded.join(", ")} · ${result.refs.length} refs covered`, {
          summary: outSummary,
          rows: result.refs,
        });
      }
      const result = await rt.engine.unfoldArtifact(params.id);
      const durationMs = performance.now() - t0;
      if (!result.ok) {
        const row = recordToolTelemetry(rt, {
          tool: "unfold",
          durationMs,
          ok: false,
          error: result.error,
          inputSummary,
          outputSummary: `Artifact unfold failed for ${params.id}`,
          metrics: { blockId: params.id, mode: "file" },
        });
        if (row) onMutation?.("telemetry", row, ctx);
        return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
      }
      onMutation?.("unfold", { id: params.id, mode: "file", path: result.path }, ctx);
      const outSummary = `artifact ${result.path}`;
      const row = recordToolTelemetry(rt, {
        tool: "unfold",
        durationMs,
        ok: true,
        inputSummary,
        outputSummary: outSummary,
        metrics: { blockId: params.id, mode: "file", artifactPath: result.path, refsCount: result.refs.length },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      return textResult(`block ${params.id} written to ${result.path}\n${result.toc}`, {
        summary: outSummary,
        rows: result.refs,
      });
    },
    describeCall(args) {
      return unfoldCallView((args ?? {}) as { id?: string; mode?: string });
    },
    describeResult(result, _options, args) {
      const a = (args ?? {}) as { id?: string };
      return unfoldResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError), a.id);
    },
    renderCall(args, options, uiTheme) {
      const a = (args ?? {}) as { id?: string; mode?: string };
      return renderInlineToolCall("Unfold", a.id, [], options, uiTheme, [a.mode ?? "file"]);
    },
    renderResult(result, options, uiTheme, args) {
      const a = (args ?? {}) as { id?: string };
      return renderInlineToolResult("Unfold", "context.compaction", result, options, uiTheme, a.id);
    },
  });

  registerInlineTool(api, {
    name: "fold_recall",
    label: "Fold Recall",
    description:
      "Read the original text of specific refs (e.g. \"m00042..m00045,m00051\") without changing context. Works for folded refs and for refs archived off the current branch. Use it to check exact wording a summary dropped.",
    parameters: t.Object({
      refs: t.String({ description: `Ref ranges, comma-separated; at most ${RECALL_MAX_REFS} refs` }),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const inputSummary = `${params.refs}`;
      let refs: string[];
      try {
        refs = parseRangeList(params.refs).flatMap((r) => expandRefRange(r.start, r.end));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const durationMs = performance.now() - t0;
        const row = recordToolTelemetry(rt, {
          tool: "fold_recall",
          durationMs,
          ok: false,
          error,
          inputSummary,
          outputSummary: `Failed to parse ref ranges`,
          metrics: { rawRefs: params.refs },
        });
        if (row) onMutation?.("telemetry", row, ctx);
        return textResult(`error: ${error}`, { summary: error, rows: [] }, true);
      }
      if (refs.length === 0 || refs.length > RECALL_MAX_REFS) {
        const error = `expected 1-${RECALL_MAX_REFS} refs, got ${refs.length}`;
        const durationMs = performance.now() - t0;
        const row = recordToolTelemetry(rt, {
          tool: "fold_recall",
          durationMs,
          ok: false,
          error,
          inputSummary,
          outputSummary: `Ref count out of bounds (${refs.length})`,
          metrics: { count: refs.length, max: RECALL_MAX_REFS },
        });
        if (row) onMutation?.("telemetry", row, ctx);
        return textResult(`error: ${error}`, { summary: error, rows: [] }, true);
      }
      const hits = rt.engine.recall(refs);
      const found = hits.filter((h) => h.source !== "missing").length;
      const missing = hits.filter((h) => h.source === "missing").length;
      const durationMs = performance.now() - t0;
      const outSummary = `${found}/${refs.length} ref(s) recalled`;
      const row = recordToolTelemetry(rt, {
        tool: "fold_recall",
        durationMs,
        ok: true,
        inputSummary,
        outputSummary: outSummary,
        metrics: {
          requestedCount: refs.length,
          foundCount: found,
          missingRefs: missing,
          missingRefList: hits.filter((h) => h.source === "missing").map((h) => h.ref),
        },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      const text = hits
        .map((h) =>
          h.source === "missing"
            ? `## ${h.ref}\n<not in current branch or archive>`
            : `## ${h.ref} (${h.role}${h.source === "archive" ? ", archived" : ""})\n${h.text}`,
        )
        .join("\n\n");
      return textResult(text, {
        summary: outSummary,
        rows: hits.map((h) => `${h.ref} · ${h.source}`),
      });
    },
    describeCall(args) {
      return recallCallView((args ?? {}) as { refs?: string });
    },
    describeResult(result, _options, args) {
      const a = (args ?? {}) as { refs?: string };
      return recallResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError), a.refs);
    },
    renderCall(args, options, uiTheme) {
      const a = (args ?? {}) as { refs?: string };
      return renderInlineToolCall("Fold Recall", a.refs, [], options, uiTheme);
    },
    renderResult(result, options, uiTheme, args) {
      const a = (args ?? {}) as { refs?: string };
      return renderInlineToolResult("Fold Recall", "context.compaction", result, options, uiTheme, a.refs);
    },
  });

  registerInlineTool(api, {
    name: "fold_search",
    label: "Fold Search",
    description:
      'Search folded history with full-text ranking: block topics/summaries plus archived original messages (recall exact text with fold_recall). Supports "tier:" (blocks only) and "session:" filter prefixes.',
    parameters: t.Object({
      query: t.String({ description: "FTS5 search terms" }),
      limit: t.Optional(t.Integer({ description: "Max hits (default 10)" })),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const limit = params.limit ?? 10;
      const inputSummary = `"${params.query}" (limit ${limit})`;
      const hits = rt.engine.search(params.query, limit);
      const messages = rt.engine.searchMessages(params.query, limit);
      const durationMs = performance.now() - t0;
      const outSummary = `${hits.length} block(s) · ${messages.length} message(s)`;
      const row = recordToolTelemetry(rt, {
        tool: "fold_search",
        durationMs,
        ok: true,
        inputSummary,
        outputSummary: outSummary,
        metrics: {
          query: params.query,
          limit,
          blockHits: hits.length,
          messageHits: messages.length,
        },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      return textResult(formatSearchHits(hits, messages), {
        summary: outSummary,
        rows: [
          ...hits.map((h) => `${h.blockId} (T${h.tier}) · ${h.topic}`),
          ...messages.map((m) => `${m.ref} ${m.role} · turn ${m.turn}`),
        ],
      });
    },
    describeCall(args) {
      return searchCallView((args ?? {}) as { query?: string; limit?: number });
    },
    describeResult(result, _options, args) {
      const a = (args ?? {}) as { query?: string };
      return searchResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError), a.query);
    },
    renderCall(args, options, uiTheme) {
      const a = (args ?? {}) as { query?: string };
      return renderInlineToolCall("Fold Search", a.query, [], options, uiTheme);
    },
    renderResult(result, options, uiTheme, args) {
      const a = (args ?? {}) as { query?: string };
      return renderInlineToolResult("Fold Search", "tool.webSearch", result, options, uiTheme, a.query);
    },
  });

  registerInlineTool(api, {
    name: "fold_status",
    label: "Fold Status",
    description: "Report context occupancy, token split, growth since last fold, fold blocks, and protected zones.",
    parameters: t.Object({}),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const st = rt.engine.status();
      const text = formatStatusReport(st);
      const liveBlocks = st.blocks.filter((b) => b.status === "active").length;
      const durationMs = performance.now() - t0;
      const outSummary = `${st.occupancyPct}% (${formatTokens(st.usedTokens)}/${formatTokens(st.windowTokens)}) · ${liveBlocks}b -${formatTokens(st.tokenSplit.foldedSavings)}t`;
      const row = recordToolTelemetry(rt, {
        tool: "fold_status",
        durationMs,
        ok: true,
        inputSummary: "Status check",
        outputSummary: outSummary,
        metrics: {
          occupancyPct: st.occupancyPct,
          usedTokens: st.usedTokens,
          liveBlocks,
          growthSinceFold: st.growthSinceFold,
          compressibleTokens: st.compressibleTokens,
        },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      return textResult(text, {
        summary: outSummary,
        kvPairs: [
          ["Occupancy", `${st.occupancyPct}% (${formatTokens(st.usedTokens)} / ${formatTokens(st.windowTokens)})`],
          ["Growth", `${formatTokens(st.growthSinceFold)} / ${formatTokens(st.growthStep)}`],
          ["Compressible", `${formatTokens(st.compressibleTokens)} / ${formatTokens(st.compressibleFloor)}`],
          ["Reclaimed", `${formatTokens(st.tokenSplit.foldedSavings)} across ${liveBlocks} live block(s)`],
        ],
        rows: st.blocks.map(
          (b) => `${b.id} (T${b.tier}) ${b.coverage} · ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.topic}${b.status === "consumed" ? ` [consumed → ${b.consumedBy}]` : b.status === "unfolded" ? " [unfolded]" : ""}`,
        ),
      });
    },
    describeCall(args) {
      return statusCallView((args ?? {}) as object);
    },
    describeResult(result) {
      return statusResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError));
    },
    renderCall(_args, options, uiTheme) {
      return renderInlineToolCall("Fold Status", undefined, [], options, uiTheme);
    },
    renderResult(result, options, uiTheme) {
      return renderInlineToolResult("Fold Status", "tool.eval", result, options, uiTheme);
    },
  });

  registerInlineTool(api, {
    name: "fold_cache",
    label: "Fold Cache",
    description: "Cache-economics ledger: per-round cache hit rates, fold re-pay cost vs stable-prefix savings, breakeven.",
    parameters: t.Object({}),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const t0 = performance.now();
      const rt = getRuntime(ctx);
      rt.sync();
      const rounds = rt.engine.cacheRounds();
      const text = formatCacheRounds(rounds);
      const firstLine = text.split("\n")[0] ?? "no cache rounds";
      const durationMs = performance.now() - t0;
      const row = recordToolTelemetry(rt, {
        tool: "fold_cache",
        durationMs,
        ok: true,
        inputSummary: "Cache check",
        outputSummary: firstLine,
        metrics: {
          roundsCount: rounds.length,
        },
      });
      if (row) onMutation?.("telemetry", row, ctx);
      return textResult(text, {
        summary: firstLine,
        rows: rounds.slice(-8).map((r, i) => {
          const hit = r.totalIn > 0 ? `${Math.round((r.cacheRead / r.totalIn) * 100)}%` : "—";
          return `#${rounds.length - Math.min(8, rounds.length) + i + 1} · in ${formatTokens(r.totalIn)} · hit ${hit}${r.foldEventId ? ` · ${r.foldEventId}` : ""}`;
        }),
      });
    },
    describeCall(args) {
      return cacheCallView((args ?? {}) as object);
    },
    describeResult(result) {
      return cacheResultView(result, result.details as ToolDetail | undefined, Boolean(result.isError));
    },
    renderCall(_args, options, uiTheme) {
      return renderInlineToolCall("Fold Cache", undefined, [], options, uiTheme);
    },
    renderResult(result, options, uiTheme) {
      return renderInlineToolResult("Fold Cache", "tool.eval", result, options, uiTheme);
    },
  });
}
