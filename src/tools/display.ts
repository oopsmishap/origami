import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Text, type Component } from "@oh-my-pi/pi-tui";
import { Box } from "@oh-my-pi/pi-tui/components/box";
import { Disclosure } from "@oh-my-pi/pi-tui/components/disclosure";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
  createMemo,
  createOwnerMemo,
  errorView,
  item,
  kv,
  list,
  md,
  node,
  plainText,
  resultText,
  rootToggleExpanded,
  span,
  toolHead,
} from "../ui/native.ts";
import type { CacheReport } from "../kernel/cache-report.ts";
import { Ellipsis, renderStatusLine, truncateToWidth } from "@oh-my-pi/pi-tui/render";
import {
  createCachedComponent,
  expandKeyHint,
  formatErrorMessage,
  formatExpandHint,
  PREVIEW_LIMITS,
  replaceTabs,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { getMarkdownTheme, getThemeEpoch, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { Memo, OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import type {
  CacheRound,
  FoldCreatedBlock,
  FoldOutcome,
  FoldSpec,
  StatusReport,
} from "../engine.ts";
import { formatTokens } from "../engine.ts";

export interface ToolDetail {
  summary: string;
  rows?: string[];
  kvPairs?: [string, string][];
}

export interface OrigamiFoldMessageDetails {
  blockId?: string;
  tier?: number;
  topic?: string;
  coverage?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export function textResult(text: string, details: ToolDetail, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
    useless: false,
  };
}

interface ParsedFoldBanner {
  blockId?: string;
  tier: number;
  topic: string;
  coverage?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  bodyMarkdown: string;
}

function parseFoldBanner(content: string, details?: OrigamiFoldMessageDetails): ParsedFoldBanner {
  const lines = content.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  let refTag: string | undefined;
  let restFirst = firstLine;
  const refMatch = /^\[#(m\d{5,})\]\s*(.*)$/.exec(firstLine);
  if (refMatch) {
    refTag = refMatch[1];
    restFirst = refMatch[2] ?? "";
  }

  let parsedTier = details?.tier ?? 1;
  let parsedTopic = details?.topic ?? "";
  const headerMatch = /^\[(Compressed|Distilled|Ultra-condensed)[^\]]*\]\s*(?:—|-)\s*(.+)$/i.exec(restFirst);
  if (headerMatch) {
    const kind = headerMatch[1]!.toLowerCase();
    if (!details?.tier) {
      parsedTier = kind === "ultra-condensed" ? 3 : kind === "distilled" ? 2 : 1;
    }
    if (!parsedTopic) parsedTopic = headerMatch[2]!.trim();
  } else if (!parsedTopic) {
    parsedTopic = restFirst || "folded context";
  }

  const bodyLines = lines.slice(1);
  const bodyMarkdown = bodyLines.join("\n").trim() || content.trim();

  return {
    blockId: details?.blockId,
    tier: parsedTier,
    topic: parsedTopic,
    coverage: details?.coverage ?? refTag,
    tokensBefore: details?.tokensBefore,
    tokensAfter: details?.tokensAfter,
    bodyMarkdown,
  };
}

/**
 * Width-aware horizontal rule banner matching omp's `CompactionSummaryMessageComponent`:
 * `──────── ✂ folded b1 (T1) · 50.8K→960 · Topic · ctrl+o ────────`
 */
class OrigamiDividerSummary implements Component {
  readonly #label: () => string;
  #cache: { width: number; lines: readonly string[] } | undefined;

  constructor(label: () => string) {
    this.#label = label;
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  releaseRenderCaches(): void {
    this.#cache = undefined;
  }

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    if (this.#cache?.width === w) return this.#cache.lines;
    const rule = theme.tree.horizontal;
    const label = this.#label();
    const hint = `${theme.sep.dot.trim()} ${expandKeyHint()}`;
    const plainWidth = Bun.stringWidth(`${label} ${hint}`, { countAnsiEscapeCodes: false });
    const remaining = w - plainWidth - 2;
    let line: string;
    if (remaining < 4) {
      line = truncateToWidth(label, w, Ellipsis.Unicode);
    } else {
      const left = Math.floor(remaining / 2);
      const right = remaining - left;
      line =
        theme.fg("dim", rule.repeat(left)) +
        ` ${label} ${theme.fg("dim", hint)} ` +
        theme.fg("dim", rule.repeat(right));
    }
    const lines = ["", line, ""];
    this.#cache = { width: w, lines };
    return lines;
  }
}

/**
 * First-party transcript fold divider + lazy Markdown disclosure body, with
 * native Tern `section` (`role: "omp.compaction"`) twin.
 */
export class OrigamiFoldMessageComponent implements Component {
  #disclosure: Disclosure;
  #ignoreTight: boolean | undefined;
  #disposed = false;
  #expanded: boolean;
  readonly #parsed: ParsedFoldBanner;
  #native: Memo | undefined;

  constructor(content: string, details?: OrigamiFoldMessageDetails, expanded = false) {
    this.#parsed = parseFoldBanner(content, details);
    this.#expanded = expanded;
    this.#disclosure = this.#createDisclosure(expanded);
  }

  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.#disclosure.setExpanded(expanded);
  }

  describe(): NativeNode {
    this.#native ??= createMemo();
    return this.#native.get([this.#expanded, getThemeEpoch()], () => {
      const p = this.#parsed;
      const tierLabel = p.tier === 3 ? "Ultra-condensed" : p.tier === 2 ? "Distilled" : "Folded";
      const head: TspSpan[] = [
        span(
          `${tierLabel}${p.blockId ? ` ${p.blockId}` : ""} (T${p.tier})`,
          p.tier >= 2 ? "accent strong" : "muted strong",
        ),
      ];
      if (p.tokensBefore !== undefined && p.tokensAfter !== undefined && p.tokensBefore > 0) {
        head.push(
          span(` · ${formatTokens(p.tokensBefore)}`, "muted mono"),
          span(" → ", "dim"),
          span(`${formatTokens(p.tokensAfter)}`, "success mono"),
        );
      } else if (p.coverage) {
        head.push(span(` · ${p.coverage}`, "dim mono"));
      }
      if (p.topic) {
        head.push(span(` · ${plainText(p.topic)}`, "muted"));
      }
      return node(
        "section",
        {
          role: "omp.compaction",
          head,
          collapsible: true,
          collapsed: !this.#expanded,
        },
        [md(p.bodyMarkdown)],
      );
    });
  }

  handleNativeEvent(event: NativeUiEvent): void {
    const expanded = rootToggleExpanded(event);
    if (expanded !== undefined) this.setExpanded(expanded);
  }

  setIgnoreTight(ignore: boolean): this {
    if (this.#disposed || this.#ignoreTight === ignore) return this;
    this.#ignoreTight = ignore;
    this.#disclosure.setIgnoreTight(ignore);
    return this;
  }

  invalidate(): void {
    if (this.#disposed) return;
    const expanded = this.#disclosure.expanded;
    this.#disclosure.dispose();
    this.#disclosure = this.#createDisclosure(expanded);
    if (this.#ignoreTight !== undefined) this.#disclosure.setIgnoreTight(this.#ignoreTight);
  }

  releaseRenderCaches(): void {
    const disclosure = this.#disclosure as Disclosure & { releaseRenderCaches?: () => void };
    disclosure.releaseRenderCaches?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disclosure.dispose();
  }

  render(width: number): readonly string[] {
    return this.#disclosure.render(width);
  }

  #ansiLabel(): string {
    const p = this.#parsed;
    const glyph = theme.styledSymbol("context.compaction", "accent");
    const kind = p.tier === 3 ? "ultra-folded" : p.tier === 2 ? "distilled" : "folded";
    const idTag = p.blockId ? ` ${p.blockId}` : "";
    const parts: string[] = [`${glyph} ${theme.fg("muted", `${kind}${idTag} (T${p.tier})`)}`];
    if (p.tokensBefore !== undefined && p.tokensAfter !== undefined && p.tokensBefore > 0) {
      parts.push(
        `${theme.fg("muted", formatTokens(p.tokensBefore))}${theme.fg("dim", "→")}${theme.fg("success", formatTokens(p.tokensAfter))}`,
      );
    } else if (p.coverage) {
      parts.push(theme.fg("dim", p.coverage));
    }
    if (p.topic) {
      parts.push(theme.fg("muted", truncateToWidth(replaceTabs(p.topic), 44, Ellipsis.Unicode)));
    }
    return parts.join(theme.fg("dim", ` ${theme.sep.dot.trim()} `));
  }

  #createDisclosure(expanded: boolean): Disclosure {
    return new Disclosure({
      summary: new OrigamiDividerSummary(() => this.#ansiLabel()),
      body: () => {
        const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
        box.setIgnoreTight(true);
        const headerMd = this.#parsed.topic ? `**${this.#parsed.topic}**\n\n` : "";
        box.addChild(
          new Markdown(`${headerMd}${this.#parsed.bodyMarkdown}`, 0, 0, getMarkdownTheme(), {
            color: (t: string) => theme.fg("customMessageText", t),
          }),
        );
        return box;
      },
      expanded,
    });
  }
}

/** Inline bulleted component shared by origami's frameless inline tool renderers. */
export function inlineRowsComponent(
  header: string,
  rows: readonly string[],
  options: RenderResultOptions | undefined,
  uiTheme: Theme,
): Component {
  const cleanRows = rows.map((r) => replaceTabs(r.trim())).filter((r) => r.length > 0);
  if (cleanRows.length === 0) {
    return new Text(header, 0, 0);
  }
  return createCachedComponent(
    () => Boolean(options?.expanded),
    (width, expanded) => {
      const lines = [header];
      const limit = expanded ? cleanRows.length : PREVIEW_LIMITS.COLLAPSED_ITEMS;
      const shown = cleanRows.slice(0, limit);
      const bullet = uiTheme.format.bullet;
      const contentWidth = Math.max(8, width - 2 - Bun.stringWidth(bullet) - 1);
      for (const rowText of shown) {
        const value = truncateToWidth(rowText, contentWidth, Ellipsis.Unicode);
        lines.push(`  ${uiTheme.fg("muted", bullet)} ${uiTheme.fg("toolOutput", value)}`);
      }
      const remaining = cleanRows.length - shown.length;
      if (remaining > 0) {
        lines.push(`  ${uiTheme.fg("dim", `… ${remaining} more`)} ${formatExpandHint(uiTheme, expanded, true)}`);
      }
      return lines.map((line) => truncateToWidth(line, width, Ellipsis.Omit));
    },
  );
}

export function renderInlineToolCall(
  title: string,
  description: string | undefined,
  rows: readonly string[],
  options: RenderResultOptions | undefined,
  uiTheme: Theme,
  meta?: string[],
): Component {
  const desc = description ? truncateToWidth(replaceTabs(description.trim()), 72, Ellipsis.Unicode) : undefined;
  const header = renderStatusLine({ icon: "pending", title, description: desc, meta }, uiTheme);
  return inlineRowsComponent(header, rows, options, uiTheme);
}

export function renderInlineToolResult(
  title: string,
  symbol: "context.compaction" | "tool.webSearch" | "tool.eval",
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
  options: RenderResultOptions | undefined,
  uiTheme: Theme,
  description?: string,
): Component {
  if (result.isError) {
    const errText = resultText(result as never).trim() || `${title} failed`;
    return new Text(formatErrorMessage(errText, uiTheme), 0, 0);
  }
  const d = result.details as ToolDetail | undefined;
  const summary = d?.summary?.trim();
  const desc = description ? truncateToWidth(replaceTabs(description.trim()), 64, Ellipsis.Unicode) : undefined;
  const header = renderStatusLine(
    {
      iconOverride: uiTheme.styledSymbol(symbol, "accent"),
      title,
      description: desc,
      meta: summary ? [summary] : undefined,
    },
    uiTheme,
  );
  return inlineRowsComponent(header, d?.rows ?? [], options, uiTheme);
}

type ViewMemos = Record<"fold" | "unfold" | "recall" | "search" | "status" | "cache", OwnerMemo<NativeToolView>>;

// Created on first native use: older hosts have no native memo module.
let memos: { call: ViewMemos; result: ViewMemos } | undefined;

function viewMemos(): { call: ViewMemos; result: ViewMemos } {
  const create = (): ViewMemos => ({
    fold: createOwnerMemo(),
    unfold: createOwnerMemo(),
    recall: createOwnerMemo(),
    search: createOwnerMemo(),
    status: createOwnerMemo(),
    cache: createOwnerMemo(),
  });
  memos ??= { call: create(), result: create() };
  return memos;
}

export function foldCallView(args: { folds?: FoldSpec[]; range?: string; topic?: string; summary?: string; tier?: number | string }): NativeToolView {
  const folds = args.folds ?? (args.range ? [{ range: args.range, topic: args.topic ?? "Summary", summary: args.summary ?? "" }] : []);
  const tier = Number(args.tier ?? 1) || 1;
  return viewMemos().call.fold.get(args, [tier, folds.length, args.range ?? ""], () => {
    const ranges = folds.map((f) => f.range).join(", ");
    return {
      head: toolHead("Fold", `tier ${tier}`, ranges || undefined),
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body:
        folds.length > 0
          ? [
              list(
                folds.map((f, i) =>
                  item(`fold-${i}`, {
                    label: [span(plainText(f.range), "mono strong"), span(` — ${plainText(f.topic)}`, "muted")],
                  }),
                ),
              ),
            ]
          : [],
    };
  });
}

export function foldResultView(
  resultObj: object,
  details: ToolDetail | undefined,
  isError: boolean,
  fallbackError?: string,
): NativeToolView {
  return viewMemos().result.fold.get(resultObj, [isError], () => {
    if (isError) {
      return { ...errorView("Fold", fallbackError || details?.summary || "Fold failed"), inline: true };
    }
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Fold", details?.summary),
      tone: "success",
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body:
        rows.length > 0
          ? [list(rows.map((r, i) => item(`b-${i}`, { label: plainText(r) })))]
          : [],
    };
  });
}

export function unfoldCallView(args: { id?: string; mode?: string }): NativeToolView {
  return viewMemos().call.unfold.get(args, [args.id ?? "", args.mode ?? "file"], () => ({
    head: toolHead("Unfold", args.id, args.mode ?? "file"),
    inline: true,
    body: [],
  }));
}

export function unfoldResultView(
  resultObj: object,
  details: ToolDetail | undefined,
  isError: boolean,
  id?: string,
): NativeToolView {
  return viewMemos().result.unfold.get(resultObj, [isError, id ?? ""], () => {
    if (isError) {
      return { ...errorView("Unfold", details?.summary || "Unfold failed", id), inline: true };
    }
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Unfold", id, details?.summary),
      tone: "success",
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body:
        rows.length > 0
          ? [list(rows.map((r, i) => item(`ref-${i}`, { label: plainText(r) })))]
          : [],
    };
  });
}

export function recallCallView(args: { refs?: string }): NativeToolView {
  return viewMemos().call.recall.get(args, [args.refs ?? ""], () => ({
    head: toolHead("Fold Recall", args.refs),
    inline: true,
    body: [],
  }));
}

export function recallResultView(
  resultObj: object,
  details: ToolDetail | undefined,
  isError: boolean,
  refs?: string,
): NativeToolView {
  return viewMemos().result.recall.get(resultObj, [isError, refs ?? ""], () => {
    if (isError) {
      return { ...errorView("Fold Recall", details?.summary || "Recall failed", refs), inline: true };
    }
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Fold Recall", refs, details?.summary),
      tone: "success",
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body: rows.length > 0 ? [list(rows.map((r, i) => item(`ref-${i}`, { label: plainText(r) })))] : [],
    };
  });
}

export function searchCallView(args: { query?: string; limit?: number }): NativeToolView {
  return viewMemos().call.search.get(args, [args.query ?? "", args.limit ?? 10], () => ({
    head: toolHead("Fold Search", args.query),
    inline: true,
    body: [],
  }));
}

export function searchResultView(
  resultObj: object,
  details: ToolDetail | undefined,
  isError: boolean,
  query?: string,
): NativeToolView {
  return viewMemos().result.search.get(resultObj, [isError, query ?? ""], () => {
    if (isError) {
      return { ...errorView("Fold Search", details?.summary || "Search failed", query), inline: true };
    }
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Fold Search", query ? `"${plainText(query)}"` : undefined, details?.summary),
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body:
        rows.length > 0
          ? [list(rows.map((r, i) => item(`hit-${i}`, { label: plainText(r) })))]
          : [],
    };
  });
}

export function statusCallView(args: object): NativeToolView {
  return viewMemos().call.status.get(args, [], () => ({
    head: toolHead("Fold Status"),
    inline: true,
    body: [],
  }));
}

export function statusResultView(resultObj: object, details: ToolDetail | undefined, isError: boolean): NativeToolView {
  return viewMemos().result.status.get(resultObj, [isError], () => {
    if (isError) {
      return { ...errorView("Fold Status", details?.summary || "Status failed"), inline: true };
    }
    const kvNode = details?.kvPairs?.length ? kv(details.kvPairs) : undefined;
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Fold Status", details?.summary),
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body: [
        ...(kvNode ? [kvNode] : []),
        ...(rows.length > 0 ? [list(rows.map((r, i) => item(`st-${i}`, { label: plainText(r) })))] : []),
      ],
    };
  });
}

export function cacheCallView(args: object): NativeToolView {
  return viewMemos().call.cache.get(args, [], () => ({
    head: toolHead("Fold Cache"),
    inline: true,
    body: [],
  }));
}

export function cacheResultView(resultObj: object, details: ToolDetail | undefined, isError: boolean): NativeToolView {
  return viewMemos().result.cache.get(resultObj, [isError], () => {
    if (isError) {
      return { ...errorView("Fold Cache", details?.summary || "Cache report failed"), inline: true };
    }
    const rows = details?.rows ?? [];
    return {
      head: toolHead("Fold Cache", details?.summary),
      inline: true,
      preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
      body:
        rows.length > 0
          ? [list(rows.map((r, i) => item(`cr-${i}`, { label: plainText(r) })))]
          : [],
    };
  });
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  const winStr = report.windowTokens > 0 ? ` (${formatTokens(report.usedTokens)} / ${formatTokens(report.windowTokens)})` : "";
  lines.push(`occupancy ${report.occupancyPct}%${winStr} · folded ${report.folded} · live ${report.live}`);
  lines.push(
    `tokens: used ${formatTokens(report.usedTokens)} · live ${formatTokens(report.tokenSplit.live)} · tools ${formatTokens(report.tokenSplit.tools)} · summaries ${formatTokens(report.tokenSplit.summaries)} · saved ${formatTokens(report.tokenSplit.foldedSavings)}`,
  );
  lines.push(
    `growth ${formatTokens(report.growthSinceFold)} / ${formatTokens(report.growthStep)} · compressible ${formatTokens(report.compressibleTokens)} / ${formatTokens(report.compressibleFloor)} · protected tail from turn ${report.protectedFromTurn}`,
  );
  const gate = report.foldGate;
  lines.push(
    gate.blockedBy === null
      ? `Fold gate: open (boundary: ${gate.boundary})`
      : gate.blockedBy === "fill-floor"
        ? `Fold gate: blocked by fill floor (context ${formatTokens(report.projectedTokens)} < ${formatTokens(gate.fillFloorTokens)})`
        : gate.blockedBy === "mid-task"
          ? "Fold gate: blocked mid-task (waiting for a user turn, idle cache, or 2× growth step)"
          : `Fold gate: blocked by cost (break-even ${gate.breakevenTurns === null ? "never" : gate.breakevenTurns.toFixed(1)} turns > ${gate.paybackHorizonTurns})`,
  );
  if (report.invariantViolations.length > 0) {
    lines.push("");
    lines.push("invariant violations:");
    for (const v of report.invariantViolations) lines.push(`  ${v.kind}: ${v.detail}`);
  }
  if (report.blocks.length > 0) {
    lines.push("");
    lines.push("blocks:");
    for (const b of report.blocks) {
      lines.push(
        `  ${b.id} (tier ${b.tier}) ${b.coverage} · ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.generation} (${b.survivedFolds} later folds) · ${b.topic}${b.status === "consumed" ? ` [consumed → ${b.consumedBy}]` : b.status === "unfolded" ? " [unfolded]" : ""}`,
      );
    }
  }
  if (report.zones.length > 0) {
    lines.push("");
    lines.push("zones:");
    for (const z of report.zones) {
      const cache = z.cacheCoverage === "none" ? "uncached" : `${formatTokens(z.cachedTokens)}t cached${z.cacheCoverage === "partial" ? " (partial)" : ""}`;
      lines.push(`  ${z.kind} ${z.start}..${z.end} (${formatTokens(z.tokens)}t · ${cache})`);
    }
  }
  if (report.uncoveredRuns && report.uncoveredRuns.length > 0) {
    lines.push("");
    lines.push("uncovered history runs:");
    for (const u of report.uncoveredRuns) {
      const adv = u.advertised ? " [in current nudge]" : " [unadvertised]";
      lines.push(`  ${u.startRef}..${u.endRef} (${u.count} msgs, ${formatTokens(u.tokens)}t)${adv}`);
    }
  }
  return lines.join("\n");
}

export function formatCacheRounds(
  rounds: readonly CacheRound[],
  collapseWarning?: string | null,
  cacheReport?: CacheReport | null,
): string {
  if (rounds.length === 0) return "no cache rounds recorded";
  let totalIn = 0;
  let totalRead = 0;
  let totalWrite = 0;
  for (const r of rounds) {
    totalIn += r.totalIn;
    totalRead += r.cacheRead;
    totalWrite += r.cacheWrite;
  }
  const hitPct = totalIn > 0 ? ((totalRead / totalIn) * 100).toFixed(1) : "0.0";
  const lines: string[] = [];
  if (collapseWarning) {
    lines.push(`⚠️ WARNING: ${collapseWarning}\n`);
  }
  lines.push(
    `${rounds.length} round(s) · cache hit ${hitPct}% (${formatTokens(totalRead)} read / ${formatTokens(totalIn)} in · ${formatTokens(totalWrite)} write)`,
  );

  if (cacheReport && cacheReport.summary) {
    const s = cacheReport.summary;
    const totalMiss = Math.max(0, s.totalInput - s.totalCached);
    const freshPct = totalMiss > 0 ? Math.round((s.newContent / totalMiss) * 100) : 0;
    const repayPct = totalMiss > 0 ? Math.round((s.compRepay / totalMiss) * 100) : 0;
    const ttlPct = totalMiss > 0 ? Math.round((s.ttlRepay / totalMiss) * 100) : 0;

    lines.push(
      "",
      "--- Cache Miss Decomposition (Ground Truth) ---",
      `Fresh Content:       ${formatTokens(s.newContent)} (${freshPct}% of misses · normal turn growth)`,
      `Compression Re-pay:  ${formatTokens(s.compRepay)} (${repayPct}% of misses · prefix invalidation)`,
      `Host rewrite:        ${formatTokens(s.hostRepay)} (${totalMiss > 0 ? Math.round((s.hostRepay / totalMiss) * 100) : 0}% of misses · omp compaction/shake outside Origami)`,
      `Unattributed:        ${formatTokens(s.ttlRepay)} (${ttlPct}% of misses · TTL expiry or provider eviction)`,
      `Net saving:          ${formatTokens(Math.round(s.netUnits))} units (${s.paidBackCount}/${s.foldsCount} folds paid back · 1 unit = 1 uncached input token)`,
    );

    if (cacheReport.folds.length > 0) {
      lines.push(
        "",
        "--- Per-Fold Payback & Cadence Ledger ---",
        "fold | compressed | summary | repay_T | breakeven | requests | payback | cadence",
      );
      for (const f of cacheReport.folds) {
        const b = f.breakevenTurns;
        const status = f.paidBack ? "PAID_BACK ✓" : b === null ? "NEVER_PAYS" : `BREAKEVEN_IN_${Math.max(1, Math.ceil(b - f.requestsAfter))}T`;
        const cadence = f.cadenceOk === null ? "ACTIVE" : f.cadenceOk ? "OK ✓" : "THRASHED ✗";
        lines.push(
          `${f.id.padEnd(4)} | ${formatTokens(f.S).padEnd(10)} | ${formatTokens(f.sigma).padEnd(7)} | ${formatTokens(f.T).padEnd(7)} | ` +
          `${(b === null ? "never" : `${b.toFixed(1)} turns`).padEnd(9)} | ${(f.requestsAfter + " post").padEnd(8)} | ` +
          `${status.padEnd(11)} | ${cadence}`,
        );
      }
    }
  }

  lines.push(
    "",
    "--- Recent Rounds ---",
    "ts | total_in | cache_read | cache_write | hit% | fold",
  );
  for (const r of rounds.slice(-10)) {
    const rHit = r.totalIn > 0 ? `${((r.cacheRead / r.totalIn) * 100).toFixed(1)}%` : "0.0%";
    lines.push(`${new Date(r.ts).toLocaleTimeString()} | ${r.totalIn} | ${r.cacheRead} | ${r.cacheWrite} | ${rHit.padEnd(6)} | ${r.foldEventId ?? "-"}`);
  }
  return lines.join("\n");
}

export function formatSearchHits(
  hits: readonly { blockId: string; tier: number; topic: string; status: string; snippet: string }[],
  messages: readonly { ref: string; role: string; turn: number; snippet: string; ownSession: boolean; sessionId: string }[] = [],
): string {
  if (hits.length === 0 && messages.length === 0) return "no matches";
  const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ");
  const lines: string[] = [];
  if (hits.length > 0) {
    lines.push("blocks:");
    for (const h of hits) {
      const state = h.status === "active" ? "" : ` [${h.status}]`;
      lines.push(`${h.blockId} (tier ${h.tier})${state} ${h.topic}${h.snippet ? `\n  ${oneLine(h.snippet)}` : ""}`);
    }
  }
  if (messages.length > 0) {
    lines.push("archived messages (exact text via fold_recall):");
    for (const m of messages) {
      const where = m.ownSession ? "" : ` [session ${m.sessionId}]`;
      lines.push(`${m.ref} ${m.role} · turn ${m.turn}${where}${m.snippet ? `\n  ${oneLine(m.snippet)}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function formatFoldOutcome(outcome: FoldOutcome): string {
  const lines = outcome.blocks.map(
    (b: FoldCreatedBlock) =>
      `${b.id} (tier ${b.tier}) ${b.refs[0]}..${b.refs[b.refs.length - 1]} · ${formatTokens(b.tokensBefore)}t → ${formatTokens(b.tokensAfter)}t · ${b.topic}`,
  );
  for (const b of outcome.blocks) {
    if (b.missing.length === 0) continue;
    lines.push(
      `${b.id}: summary omitted ${b.missing.length} source item(s) (${b.missing.slice(0, 3).join(", ")}); attached as "Also covered".`,
    );
  }
  return `${outcome.foldCount} block(s) folded · reclaimed ${formatTokens(outcome.tokensReclaimed)}t\n${lines.join("\n")}`;
}
