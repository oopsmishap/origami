import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import { plainToolCard } from "@oh-my-pi/pi-tui/render/tool-card";
import type { Component } from "@oh-my-pi/pi-tui";
import type { FoldSpec, CacheRound, StatusReport, FoldCreatedBlock, FoldOutcome } from "../engine.ts";
import { formatTokens } from "../engine.ts";

export interface ToolDetail {
  summary: string;
  rows?: string[];
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  summary: string;
  rows: string[];
}

export function textResult(text: string, details: ToolDetail, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
    useless: false,
  };
}

export function foldCallView(args: { folds?: FoldSpec[]; tier?: number }): NativeToolView {
  const folds = args.folds ?? [];
  const tier = args.tier ?? 1;
  return {
    tool: {
      title: "fold",
      badges: [{ text: `tier ${tier}` }],
      meta: folds.map((f) => f.range),
    },
    open: false,
    preview: { lines: 1 },
    body: [md(folds.map((f) => `**${f.range}** — ${f.topic}\n${f.summary}`).join("\n\n"))],
  };
}

export function foldResultView(details: ToolDetail | undefined, tone: "success" | "error"): NativeToolView {
  return {
    tool: {
      title: "fold",
      meta: details?.rows?.length ? [`${details.rows.length} block(s)`] : [],
    },
    tone,
    open: false,
    preview: { lines: 1 },
    body: [
      md(details?.summary ?? ""),
      ...(details?.rows?.length ? [md(details.rows.map((r) => `- ${r}`).join("\n"))] : []),
    ],
  };
}

export function unfoldResultView(details: ToolDetail | undefined, isError: boolean): NativeToolView {
  return {
    tool: { title: "unfold", meta: details?.rows?.length ? [`${details.rows.length} refs`] : [] },
    tone: isError ? "error" : "success",
    open: false,
    preview: { lines: 1 },
    body: [md(details?.summary ?? ""), ...(details?.rows?.length ? [md(details.rows.map((r) => `- ${r}`).join("\n"))] : [])],
  };
}

export function searchResultView(details: ToolDetail | undefined): NativeToolView {
  return {
    tool: { title: "fold_search", meta: details?.rows?.length ? [`${details.rows.length} hit(s)`] : [] },
    open: false,
    preview: { lines: 1 },
    body: [md(details?.summary ?? ""), ...(details?.rows?.length ? [md(details.rows.join("\n"))] : [])],
  };
}

export function statusResultView(details: ToolDetail | undefined): NativeToolView {
  return {
    tool: { title: "fold_status" },
    open: false,
    preview: { lines: 1 },
    body: [md(details?.summary ?? "")],
  };
}

export function cacheResultView(details: ToolDetail | undefined): NativeToolView {
  return {
    tool: { title: "fold_cache" },
    open: false,
    preview: { lines: 1 },
    body: [md(details?.summary ?? "")],
  };
}

export function plainFoldCard(theme: Theme, title: string, lines: readonly string[], tone?: "success" | "error"): Component {
  return plainToolCard(theme, () => ({
    status: {
      title,
      titleColor: tone === "error" ? "error" : tone === "success" ? "success" : "accent",
    },
    body: [...lines],
  }));
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`occupancy ${report.occupancyPct}% · folded ${report.folded} · live ${report.live}`);
  lines.push(
    `tokens: live ${formatTokens(report.tokenSplit.live)} · tools ${formatTokens(report.tokenSplit.tools)} · saved ${formatTokens(report.tokenSplit.foldedSavings)}`,
  );
  lines.push(
    `growth ${formatTokens(report.growthSinceFold)} / ${formatTokens(report.growthStep)} · compressible ${formatTokens(report.compressibleTokens)} / ${formatTokens(report.compressibleFloor)}`,
  );
  if (report.blocks.length > 0) {
    lines.push("");
    lines.push("blocks:");
    for (const b of report.blocks) {
      lines.push(`  ${b.id} (tier ${b.tier}) ${b.coverage} · ${formatTokens(b.tokens)}t · ${b.topic}${b.superseded ? " [superseded]" : ""}`);
    }
  }
  if (report.zones.length > 0) {
    lines.push("");
    lines.push("zones:");
    for (const z of report.zones) lines.push(`  ${z.kind} ${z.start}..${z.end}`);
  }
  return lines.join("\n");
}

export function formatCacheRounds(rounds: readonly CacheRound[]): string {
  if (rounds.length === 0) return "no cache rounds recorded";
  const lines = ["ts | total_in | cache_read | cache_write | fold"];
  for (const r of rounds) {
    lines.push(`${new Date(r.ts).toISOString()} | ${r.totalIn} | ${r.cacheRead} | ${r.cacheWrite} | ${r.foldEventId ?? "-"}`);
  }
  return lines.join("\n");
}

export function formatSearchHits(hits: readonly { blockId: string; tier: number; topic: string; snippet: string }[]): string {
  if (hits.length === 0) return "no matches";
  return hits
    .map((h) => {
      const snip = h.snippet ? h.snippet.replace(/\n/g, " ") : "";
      return `${h.blockId} (tier ${h.tier}) ${h.topic}${snip ? `\n  ${snip}` : ""}`;
    })
    .join("\n");
}

export function formatFoldOutcome(outcome: FoldOutcome): string {
  const lines = outcome.blocks.map(
    (b: FoldCreatedBlock) => `${b.id} (tier ${b.tier}) ${b.refs[0]}..${b.refs[b.refs.length - 1]} · ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.topic}`,
  );
  return `${outcome.foldCount} block(s) folded · reclaimed ${formatTokens(outcome.tokensReclaimed)}t\n${lines.join("\n")}`;
}

export function formatFoldUnfoldRows(refs: readonly string[]): string[] {
  return refs.map((r) => `- ${r}`);
}