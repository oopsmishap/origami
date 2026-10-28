import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { FoldSpec } from "../engine.ts";
import type { OrigamiRuntime } from "../runtime.ts";
import {
  formatFoldOutcome,
  foldCallView,
  foldResultView,
  textResult,
  searchResultView,
  statusResultView,
  cacheResultView,
  unfoldResultView,
  formatStatusReport,
  formatCacheRounds,
  formatSearchHits,
  plainFoldCard,
} from "./display.ts";

interface Detail {
  summary: string;
  rows: string[];
}

export function registerTools(api: ExtensionAPI, getRuntime: (ctx?: ExtensionContext) => OrigamiRuntime): void {
  const t = api.typebox.Type;

  api.registerTool({
    name: "fold",
    label: "fold",
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
      tier: t.Optional(t.Union([t.Literal(1), t.Literal(2), t.Literal(3)], { description: "Fold tier: 1=message compression, 2=distillation, 3=ultra-dense" })),
    }),
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const rt = getRuntime(_ctx);
      rt.sync();
      const result = rt.engine.executeFold({ folds: params.folds as FoldSpec[], tier: params.tier });
      if (!result.ok) {
        return textResult(`error: ${result.error} (fold ${result.foldIndex})`, { summary: result.error, rows: [] }, true);
      }
      const text = formatFoldOutcome(result.outcome);
      return textResult(text, {
        summary: `${result.outcome.foldCount} block(s) · reclaimed ${result.outcome.tokensReclaimed}t`,
        rows: result.outcome.blocks.map((b) => `${b.id} · tier ${b.tier} · ${b.topic}`),
      });
    },
    describeCall(args) {
      const a = args as { folds?: FoldSpec[]; tier?: number };
      return foldCallView({ folds: a.folds ?? [], tier: a.tier ?? 1 });
    },
    describeResult(result) {
      return foldResultView(result.details as Detail | undefined, result.isError ? "error" : "success");
    },
    renderCall(args, _options, theme) {
      const a = args as { folds?: FoldSpec[]; tier?: number };
      return plainFoldCard(
        theme,
        `fold (tier ${a.tier ?? 1})`,
        (a.folds ?? []).map((f) => `${f.range} · ${f.topic}`),
      );
    },
    renderResult(result, _options, theme) {
      const d = result.details as Detail | undefined;
      return plainFoldCard(
        theme,
        result.isError ? "fold failed" : "fold",
        [d?.summary ?? "", ...(d?.rows ?? [])].filter((s) => s.length > 0),
        result.isError ? "error" : "success",
      );
    },
  });

  api.registerTool({
    name: "unfold",
    label: "unfold",
    description: "Unfold a folded block: reconstruct its original message bytes to an artifact file (default, cache-safe) or reactivate it inline in context.",
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const rt = getRuntime(_ctx);
      rt.sync();
      if (params.mode === "inline") {
        const result = rt.engine.executeUnfold(params.id);
        if (!result.ok) return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
        return textResult(`block ${params.id} unfolded inline · ${result.refs.length} refs reactivated`, {
          summary: `unfolded ${params.id} inline`,
          rows: result.refs,
        });
      }
      const result = await rt.engine.unfoldArtifact(params.id);
      if (!result.ok) return textResult(`error: ${result.error}`, { summary: result.error, rows: [] }, true);
      return textResult(`block ${params.id} written to ${result.path}\n${result.toc}`, {
        summary: `artifact: ${result.path}`,
        rows: result.refs,
      });
    },
    describeResult(result) {
      return unfoldResultView(result.details as Detail | undefined, Boolean(result.isError));
    },
    renderCall(args, _options, theme) {
      const a = args as { id: string; mode?: string };
      return plainFoldCard(theme, "unfold", [`${a.id}${a.mode ? ` · ${a.mode}` : ""}`]);
    },
    renderResult(result, _options, theme) {
      const d = result.details as Detail | undefined;
      return plainFoldCard(
        theme,
        result.isError ? "unfold failed" : "unfold",
        [d?.summary ?? "", ...(d?.rows ?? [])].filter((s) => s.length > 0),
        result.isError ? "error" : "success",
      );
    },
  });

  api.registerTool({
    name: "fold_search",
    label: "fold_search",
    description: 'Search folded block history (topics + summaries) with full-text ranking. Supports "tier:" and "session:" filter prefixes.',
    parameters: t.Object({
      query: t.String({ description: "FTS5 search terms" }),
      limit: t.Optional(t.Integer({ description: "Max hits (default 10)" })),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const rt = getRuntime(_ctx);
      rt.sync();
      const hits = rt.engine.search(params.query, params.limit ?? 10);
      return textResult(formatSearchHits(hits), {
        summary: `${hits.length} hit(s) for ${params.query}`,
        rows: hits.map((h) => `${h.blockId} · tier ${h.tier} · ${h.topic}`),
      });
    },
    describeResult(result) {
      return searchResultView(result.details as Detail | undefined);
    },
    renderCall(args, _options, theme) {
      const a = args as { query: string };
      return plainFoldCard(theme, "fold_search", [a.query]);
    },
    renderResult(result, _options, theme) {
      const d = result.details as Detail | undefined;
      return plainFoldCard(theme, "fold_search", [d?.summary ?? "", ...(d?.rows ?? [])].filter((s) => s.length > 0));
    },
  });

  api.registerTool({
    name: "fold_status",
    label: "fold_status",
    description: "Report context occupancy, token split, growth since last fold, fold blocks, and protected zones.",
    parameters: t.Object({}),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const rt = getRuntime(_ctx);
      rt.sync();
      const text = formatStatusReport(rt.engine.status());
      return textResult(text, { summary: text.split("\n")[0] ?? "", rows: text.split("\n").slice(1) });
    },
    describeResult(result) {
      return statusResultView(result.details as Detail | undefined);
    },
    renderCall(_args, _options, theme) {
      return plainFoldCard(theme, "fold_status", ["…"]);
    },
    renderResult(result, _options, theme) {
      const d = result.details as Detail | undefined;
      return plainFoldCard(theme, "fold_status", [d?.summary ?? "", ...(d?.rows ?? [])].filter((s) => s.length > 0));
    },
  });

  api.registerTool({
    name: "fold_cache",
    label: "fold_cache",
    description: "Cache-economics ledger: per-round cache hit rates, fold re-pay cost vs stable-prefix savings, breakeven.",
    parameters: t.Object({}),
    loadMode: "discoverable",
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const rt = getRuntime(_ctx);
      rt.sync();
      const text = formatCacheRounds(rt.engine.cacheRounds());
      return textResult(text, { summary: text.split("\n")[0] ?? "", rows: text.split("\n").slice(1) });
    },
    describeResult(result) {
      return cacheResultView(result.details as Detail | undefined);
    },
    renderCall(_args, _options, theme) {
      return plainFoldCard(theme, "fold_cache", ["…"]);
    },
    renderResult(result, _options, theme) {
      const d = result.details as Detail | undefined;
      return plainFoldCard(theme, "fold_cache", [d?.summary ?? "", ...(d?.rows ?? [])].filter((s) => s.length > 0));
    },
  });
}
