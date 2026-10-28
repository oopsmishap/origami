import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { formatTokens, type FoldSpec } from "../engine.ts";
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
  unfoldCallView,
  unfoldResultView,
} from "./display.ts";

export type ToolMutationListener = (
  event: "fold" | "unfold",
  payload: unknown,
  ctx?: ExtensionContext,
) => void;

type ToolSchema = ToolDefinition extends ToolDefinition<infer P, unknown> ? P : never;

function registerInlineTool<TParams extends ToolSchema, TDetails = unknown>(
  api: ExtensionAPI,
  def: ToolDefinition<TParams, TDetails>,
): void {
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
      const rt = getRuntime(ctx);
      rt.sync();
      const result = rt.engine.executeFold({ folds: params.folds as FoldSpec[], tier: params.tier });
      if (!result.ok) {
        return textResult(`error: ${result.error} (fold ${result.foldIndex})`, { summary: result.error, rows: [] }, true);
      }
      onMutation?.("fold", result.outcome, ctx);
      const text = formatFoldOutcome(result.outcome);
      return textResult(text, {
        summary: `${result.outcome.foldCount} block(s) · -${formatTokens(result.outcome.tokensReclaimed)}t`,
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
      "Unfold a folded block: reconstruct its original message bytes to an artifact file (default, cache-safe) or reactivate it inline in context.",
    parameters: t.Object({
      id: t.String({ description: 'Block id to unfold, e.g. "b7"' }),
      mode: t.Optional(
        t.Union([t.Literal("file"), t.Literal("inline")], {
          description: "file = artifact (default, cache-safe); inline = reactivate in context",
        }),
      ),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = getRuntime(ctx);
      rt.sync();
      if (params.mode === "inline") {
        const result = rt.engine.executeUnfold(params.id);
        if (!result.ok) return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
        onMutation?.("unfold", { id: params.id, mode: "inline" }, ctx);
        return textResult(`block ${params.id} unfolded inline · ${result.refs.length} refs reactivated`, {
          summary: `${result.refs.length} refs reactivated inline`,
          rows: result.refs,
        });
      }
      const result = await rt.engine.unfoldArtifact(params.id);
      if (!result.ok) return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
      onMutation?.("unfold", { id: params.id, mode: "file", path: result.path }, ctx);
      return textResult(`block ${params.id} written to ${result.path}\n${result.toc}`, {
        summary: `artifact ${result.path}`,
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
    name: "fold_search",
    label: "Fold Search",
    description:
      'Search folded block history (topics + summaries) with full-text ranking. Supports "tier:" and "session:" filter prefixes.',
    parameters: t.Object({
      query: t.String({ description: "FTS5 search terms" }),
      limit: t.Optional(t.Integer({ description: "Max hits (default 10)" })),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = getRuntime(ctx);
      rt.sync();
      const hits = rt.engine.search(params.query, params.limit ?? 10);
      return textResult(formatSearchHits(hits), {
        summary: `${hits.length} hit(s)`,
        rows: hits.map((h) => `${h.blockId} (T${h.tier}) · ${h.topic}`),
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
      const rt = getRuntime(ctx);
      rt.sync();
      const st = rt.engine.status();
      const text = formatStatusReport(st);
      const liveBlocks = st.blocks.filter((b) => !b.superseded).length;
      return textResult(text, {
        summary: `${st.occupancyPct}% (${formatTokens(st.usedTokens)}/${formatTokens(st.windowTokens)}) · ${liveBlocks}b -${formatTokens(st.tokenSplit.foldedSavings)}t`,
        kvPairs: [
          ["Occupancy", `${st.occupancyPct}% (${formatTokens(st.usedTokens)} / ${formatTokens(st.windowTokens)})`],
          ["Growth", `${formatTokens(st.growthSinceFold)} / ${formatTokens(st.growthStep)}`],
          ["Compressible", `${formatTokens(st.compressibleTokens)} / ${formatTokens(st.compressibleFloor)}`],
          ["Reclaimed", `${formatTokens(st.tokenSplit.foldedSavings)} across ${liveBlocks} live block(s)`],
        ],
        rows: st.blocks.map(
          (b) => `${b.id} (T${b.tier}) ${b.coverage} · ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.topic}${b.superseded ? " [superseded]" : ""}`,
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
      const rt = getRuntime(ctx);
      rt.sync();
      const rounds = rt.engine.cacheRounds();
      const text = formatCacheRounds(rounds);
      const firstLine = text.split("\n")[0] ?? "no cache rounds";
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
