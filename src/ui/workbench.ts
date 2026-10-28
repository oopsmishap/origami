import type { TspSpan } from "@oh-my-pi/pi-wire";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@oh-my-pi/pi-tui";
import { planContextMap } from "./context-map.ts";
import { OverlayPanel, PanelDivider, PanelRows } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { renderSegmentTrack } from "@oh-my-pi/pi-tui/chrome/segment-track";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
  actionBar,
  actionButton,
  hintsRow,
  item,
  itemIndex,
  kv,
  list,
  md,
  nativeAvailable,
  node,
  overlayCard,
  plainText,
  row,
  selectList,
  span,
  text,
} from "./native.ts";
import { Ellipsis } from "@oh-my-pi/pi-tui/render";
import { theme, type ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { formatTokens } from "../kernel/nudge.ts";
import { describeNativeTrajectory, renderAnsiTrajectory } from "./trajectory.ts";
import {
  handleWorkbenchKey,
  syncWorkbenchModel,
  WORKBENCH_TAB_IDS,
  WORKBENCH_TABS,
  type BlockRow,
  type WorkbenchActions,
  type WorkbenchCategory,
  type WorkbenchKeyOutcome,
  type WorkbenchModel,
} from "./workbench-model.ts";

export class WorkbenchComponent implements Component {
  readonly nativeOverlay = {
    role: "omp.overlay.origami",
    head: "Origami Context",
    size: "lg" as const,
    anchor: "center" as const,
  };

  private model: WorkbenchModel;
  private actions: WorkbenchActions;
  private tui: TUI;
  private onOutcome: (outcome: WorkbenchKeyOutcome) => void;
  readonly #panel = new OverlayPanel("Origami Context", "omp.overlay.origami");
  readonly #headerRows = new PanelRows();
  readonly #bodyRows = new PanelRows();
  readonly #footerRows = new PanelRows();

  constructor(opts: {
    model: WorkbenchModel;
    actions: WorkbenchActions;
    tui: TUI;
    onOutcome: (outcome: WorkbenchKeyOutcome) => void;
  }) {
    this.model = opts.model;
    this.actions = opts.actions;
    this.tui = opts.tui;
    this.onOutcome = opts.onOutcome;

    this.#panel.addChild(this.#headerRows);
    this.#panel.addChild(new PanelDivider());
    this.#panel.addChild(this.#bodyRows);
    this.#panel.addChild(new PanelDivider());
    this.#panel.addChild(this.#footerRows);
  }

  invalidate(): void {
    this.#panel.invalidate();
  }

  dispose(): void {
    this.#panel.dispose();
  }

  render(width: number): readonly string[] {
    const innerWidth = Math.max(24, width - 4);
    this.#panel.title = this.model.drillBlockId
      ? `Origami Context · Block ${this.model.drillBlockId}`
      : "Origami Context";

    this.#headerRows.setLines(this.#renderAnsiHeader(innerWidth));
    this.#bodyRows.setLines(this.#renderAnsiBody(innerWidth));
    this.#footerRows.setLines(this.#renderAnsiFooter(innerWidth));
    return this.#panel.render(width);
  }

  describe(cx: DescribeContext): NativeNode | null {
    if (!nativeAvailable) return null;
    const m = this.model;
    if (m.drillBlockId !== null) {
      const block = m.blocks.find((b) => b.id === m.drillBlockId);
      return this.#describeBlockDetail(block);
    }

    const liveBlockCount = m.blocks.filter((b) => b.status === "active").length;
    const tabItems = WORKBENCH_TABS.map((label, idx) => {
      const suffix =
        idx === 1 && m.trajectory.lines.length > 0
          ? ` (${m.trajectory.lines.length})`
          : idx === 2 && m.blocks.length > 0
            ? ` (${liveBlockCount}/${m.blocks.length})`
            : "";
      return { id: WORKBENCH_TAB_IDS[idx]!, label: `${label}${suffix}` };
    });

    const children: NativeChild[] = [
      ...this.#describeSessions(),
      ...this.#describeContextGauge(),
      node(
        "tabs",
        {
          items: tabItems,
          active: WORKBENCH_TAB_IDS[m.tab] ?? "overview",
        },
        undefined,
        "tabs",
      ),
      ...this.#describeTabBody(cx),
    ];

    if (m.statusMessage) {
      children.push(
        text([span("● ", "accent"), span(plainText(m.statusMessage), "muted")], {
          role: "omp.origami.status",
          wrap: "word",
        }),
      );
    }

    const selectedBlock = m.blocks[m.selected];
    const buttons: (NativeNode | null)[] = [];
    if (selectedBlock) {
      buttons.push(actionButton(`Inspect ${selectedBlock.id}`, "drill", { keys: "enter", tone: "accent" }));
      buttons.push(actionButton("Unfold to File", "unfold", { keys: "u" }));
      if (selectedBlock.status === "active") {
        buttons.push(actionButton("Unfold Inline", "unfold-inline", { keys: "i" }));
      }
    }
    buttons.push(actionButton(m.showPreview ? "Hide Fold Preview" : "Fold Preview", "fold-preview", { keys: "f" }));
    buttons.push(null);
    buttons.push(actionButton("Close", "close", { keys: "escape" }));

    children.push(actionBar(buttons));
    children.push(
      hintsRow([
        { keys: ["left", "right"], label: "tab" },
        { keys: ["up", "down"], label: "select" },
        { keys: ["enter"], label: "inspect" },
        { keys: ["u"], label: "unfold file" },
        { keys: ["i"], label: "unfold inline" },
        { keys: ["f"], label: "fold preview" },
        ...(m.sessions.length > 1 ? [{ keys: ["s"] as const, label: "session" }] : []),
        { keys: ["escape"], label: "close" },
      ]),
    );

    return overlayCard("omp.overlay.origami", "Origami Context", children);
  }

  /** Session tree strip (only when subagents exist); the focused session is highlighted. */
  #describeSessions(): NativeChild[] {
    const m = this.model;
    if (m.sessions.length < 2) return [];
    const spans = m.sessions.flatMap((s, idx) => {
      const focused = s.sessionId === m.sessionId;
      const name = `${s.level > 0 ? `${"└".repeat(s.level)} ` : ""}${s.label}`;
      const detail = s.phase === "active" ? ` ${s.occupancyPct}%` : ` ${s.phase}`;
      return [
        ...(idx > 0 ? [span("  ", "dim")] : []),
        span(plainText(`${focused ? "▶ " : ""}${name}`), focused ? "accent" : s.phase === "ended" ? "dim" : "muted"),
        span(plainText(detail), "dim"),
      ];
    });
    return [text(spans, { role: "omp.origami.sessions", wrap: "word" })];
  }

  handleInput(data: string): void {
    const normalized = matchesKey(data, "escape") ? "\x1b" : data;
    const outcome = handleWorkbenchKey(this.model, normalized, this.actions);
    if (outcome.pendingUnfold) {
      this.#runUnfold(outcome.pendingUnfold.id, outcome.pendingUnfold.mode);
      return;
    }
    if (outcome.handled) this.onOutcome(outcome);
    this.tui.requestRender();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "select") {
      const tabIdx = WORKBENCH_TAB_IDS.indexOf(event.item as (typeof WORKBENCH_TAB_IDS)[number]);
      if (tabIdx >= 0) {
        this.model.tab = tabIdx;
        this.model.drillBlockId = null;
        this.tui.requestRender();
        return;
      }
      const blockIdx = itemIndex(event.item, "block");
      if (blockIdx >= 0 && blockIdx < this.model.blocks.length) {
        this.model.selected = blockIdx;
        this.tui.requestRender();
        return;
      }
      return;
    }

    if (event.type === "activate") {
      const blockIdx = itemIndex(event.item, "block");
      const target = blockIdx >= 0 ? this.model.blocks[blockIdx] : this.model.blocks[this.model.selected];
      if (target) {
        if (blockIdx >= 0) this.model.selected = blockIdx;
        this.model.drillBlockId = target.id;
        this.model.scroll = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (event.type === "action") {
      if (event.act === "close") {
        this.onOutcome({ handled: true, close: true });
        return;
      }
      if (event.act === "back") {
        this.model.drillBlockId = null;
        this.model.scroll = 0;
        this.tui.requestRender();
        return;
      }
      if (event.act === "tab" && event.value) {
        const byId = WORKBENCH_TAB_IDS.indexOf(event.value as (typeof WORKBENCH_TAB_IDS)[number]);
        const byName = WORKBENCH_TABS.findIndex((t) => t.toLowerCase() === event.value!.toLowerCase());
        const nextTab = byId >= 0 ? byId : byName;
        if (nextTab >= 0) {
          this.model.tab = nextTab;
          this.model.drillBlockId = null;
        }
        this.tui.requestRender();
        return;
      }
      if (event.act === "fold-preview") {
        handleWorkbenchKey(this.model, "f", this.actions);
        this.tui.requestRender();
        return;
      }
      if (event.act === "drill") {
        const block = this.model.blocks[this.model.selected];
        if (block) {
          this.model.drillBlockId = block.id;
          this.model.scroll = 0;
        }
        this.tui.requestRender();
        return;
      }
      if (event.act === "unfold" || event.act === "unfold-inline") {
        const targetId = this.model.drillBlockId ?? this.model.blocks[this.model.selected]?.id;
        if (targetId) {
          this.#runUnfold(targetId, event.act === "unfold-inline" ? "inline" : "file");
        }
        return;
      }
    }
  }

  capturesInput(data: string): boolean {
    return (
      matchesKey(data, "escape") ||
      data === "\x7f" ||
      data === "\b" ||
      data === "s" ||
      data === "S" ||
      data === "q" ||
      data === "f" ||
      data === "u" ||
      data === "i" ||
      data === "h" ||
      data === "j" ||
      data === "k" ||
      data === "l" ||
      data === "1" ||
      data === "2" ||
      data === "3" ||
      data === "4" ||
      data === "\r" ||
      data === "\n" ||
      data === "\t" ||
      data.startsWith("\x1b[")
    );
  }

  #runUnfold(id: string, mode: "file" | "inline"): void {
    this.model.statusMessage = `Unfolding ${id} (${mode})…`;
    this.tui.requestRender();
    void this.actions.unfoldSelected(id, mode).then((msg) => {
      if (this.actions.refresh) {
        const refreshed = this.actions.refresh();
        syncWorkbenchModel(this.model, refreshed);
      }
      this.model.statusMessage = msg;
      this.tui.requestRender();
    });
  }

  #renderAnsiHeader(width: number): string[] {
    const m = this.model;
    const liveBlockCount = m.blocks.filter((b) => b.status === "active").length;
    const segments = WORKBENCH_TABS.map((label, idx) => {
      const count =
        idx === 1 && m.trajectory.lines.length > 0
          ? ` ${m.trajectory.lines.length}`
          : idx === 2 && m.blocks.length > 0
            ? ` ${liveBlockCount}/${m.blocks.length}`
            : "";
      return { label: `${idx + 1}:${label}${count}` };
    });
    const track = renderSegmentTrack(segments, m.tab);

    const winLabel =
      m.windowTokens > 0
        ? `${theme.bold(formatTokens(m.usedTokens))}${theme.fg("dim", ` / ${formatTokens(m.windowTokens)} tokens`)} ${theme.fg(m.occupancyPct >= 85 ? "error" : m.occupancyPct >= 70 ? "warning" : "accent", `(${m.occupancyPct}%)`)}`
        : `${theme.bold(formatTokens(m.usedTokens))} ${theme.fg("dim", "tokens")}`;

    const growth = `${formatTokens(m.growthSinceFold)}↑/${formatTokens(m.growthStep)}`;
    const rightSummary =
      `${theme.fg("success", `-${formatTokens(m.foldedSavings)}`)} ${theme.fg("muted", `reclaimed (${liveBlockCount}b)`)}` +
      `${theme.fg("dim", " · ")}` +
      `${theme.fg(m.growthSinceFold >= m.growthStep ? "warning" : "muted", `growth ${growth}`)}`;

    const lines = [
      truncateToWidth(track, width, Ellipsis.Omit),
      truncateToWidth(`${winLabel}   ${rightSummary}`, width, Ellipsis.Unicode),
    ];
    if (m.sessions.length > 1) {
      const strip = m.sessions
        .map((s) => {
          const focused = s.sessionId === m.sessionId;
          const name = `${s.level > 0 ? `${"└".repeat(s.level)} ` : ""}${s.label}`;
          const detail = s.phase === "active" ? `${s.occupancyPct}%` : s.phase;
          const label = `${focused ? "▶ " : ""}${name} ${detail}`;
          return focused ? theme.fg("accent", label) : theme.fg(s.phase === "ended" ? "dim" : "muted", label);
        })
        .join(theme.fg("dim", "  "));
      lines.unshift(truncateToWidth(`${theme.fg("dim", "sessions (s/S) ")}${strip}`, width, Ellipsis.Unicode));
    }
    return lines;
  }

  #renderAnsiBody(width: number): string[] {
    const m = this.model;
    if (m.drillBlockId !== null) {
      return this.#renderAnsiDrilldown(width);
    }
    if (m.tab === 0) return this.#renderAnsiOverview(width);
    if (m.tab === 1) return renderAnsiTrajectory(m.trajectory, width, 8);
    if (m.tab === 2) return this.#renderAnsiBlocks(width);
    return this.#renderAnsiZones(width);
  }

  #renderAnsiOverview(width: number): string[] {
    const m = this.model;
    const lines: string[] = [];
    const windowTotal = m.windowTokens > 0 ? m.windowTokens : Math.max(1, m.usedTokens);

    // 2D Context Map beside aligned Category Legend (mirrors omp's /context viewer)
    const mapCols = width >= 76 ? 12 : width >= 58 ? 8 : 0;
    const mapRows = m.categories.length;
    const cells =
      mapCols > 0
        ? planContextMap<WorkbenchCategory["id"]>(
            m.categories.map((c) => ({ id: c.id, tokens: c.tokens })),
            windowTotal,
            mapCols,
            mapRows,
          )
        : [];
    const catById = new Map(m.categories.map((c) => [c.id, c]));

    const tokW = Math.max(6, ...m.categories.map((c) => formatTokens(c.tokens).length));
    for (let r = 0; r < mapRows; r++) {
      const cat = m.categories[r]!;
      let mapPrefix = "";
      if (mapCols > 0) {
        const rowCells = cells.slice(r * mapCols, (r + 1) * mapCols);
        const renderedCells: string[] = [];
        for (let c = 0; c < mapCols; c++) {
          const cell = rowCells[c];
          if (!cell) {
            renderedCells.push(theme.fg("dim", "·"));
          } else {
            const owner = catById.get(cell.id)!;
            const sym = theme.symbol(owner.symbol as Parameters<typeof theme.symbol>[0]);
            const painted = theme.fg(owner.color, sym);
            renderedCells.push(cell.full ? painted : `\x1b[2m${painted}\x1b[22m`);
          }
        }
        mapPrefix = `${renderedCells.join(" ")}   `;
      }

      const swatch = theme.styledSymbol(cat.symbol as Parameters<typeof theme.styledSymbol>[0], cat.color);
      const tokCol = formatTokens(cat.tokens).padStart(tokW);
      const pctCol = `${cat.pct.toFixed(1)}%`.padStart(6);
      const suffix = ` ${theme.fg("text", tokCol)} ${theme.fg("dim", pctCol)}`;
      const labelBudget = Math.max(8, width - visibleWidth(mapPrefix) - visibleWidth(swatch) - 1 - visibleWidth(suffix));
      const labelTxt = truncateToWidth(cat.label, labelBudget, Ellipsis.Unicode);
      const pad = " ".repeat(Math.max(0, labelBudget - visibleWidth(labelTxt)));
      lines.push(truncateToWidth(`${mapPrefix}${swatch} ${theme.fg("muted", labelTxt)}${pad}${suffix}`, width, Ellipsis.Omit));
    }
    lines.push("");
    const v = m.vault;
    const ratioStr = v.archivedTokens > 0 ? `${v.compressionRatio}×` : "1.0×";
    const tile1 = `${theme.fg("muted", "Archived:")} ${theme.bold(theme.fg("text", formatTokens(v.archivedTokens)))}${theme.fg("dim", ` (${v.archivedMessages}m)`)}`;
    const tile2 = `${theme.fg("muted", "In-Context:")} ${theme.fg("success", formatTokens(v.summaryTokens))}${theme.fg("dim", ` (${v.activeBlocks}b)`)}`;
    const tile3 = `${theme.fg("muted", "Compression:")} ${theme.bold(theme.fg("accent", ratioStr))}${theme.fg("dim", ` (-${v.savingsPct}%)`)}`;
    const tile4 = `${theme.fg("muted", "Growth:")} ${theme.fg("warning", `${formatTokens(m.growthSinceFold)}↑`)}${theme.fg("dim", `/${formatTokens(m.growthStep)}`)}`;
    if (width >= 72) {
      lines.push(truncateToWidth(`  ${tile1}    ${tile2}    ${tile3}    ${tile4}`, width, Ellipsis.Unicode));
    } else {
      lines.push(truncateToWidth(`  ${tile1}    ${tile2}`, width, Ellipsis.Unicode));
      lines.push(truncateToWidth(`  ${tile3}    ${tile4}`, width, Ellipsis.Unicode));
    }

    lines.push("");
    const hitRate =
      m.trajectory.overallHitPct != null
        ? `${m.trajectory.overallHitPct.toFixed(1)}% (${formatTokens(m.trajectory.totalCached)}/${formatTokens(m.trajectory.totalInput)})`
        : "no rounds yet";
    lines.push(
      truncateToWidth(
        `${theme.fg("muted", "Compressible:")} ${theme.fg("text", formatTokens(m.compressibleTokens))}${theme.fg("dim", ` / floor ${formatTokens(m.compressibleFloor)}`)}   ` +
          `${theme.fg("muted", "Prompt cache hit:")} ${theme.fg("success", hitRate)}`,
        width,
        Ellipsis.Unicode,
      ),
    );

    if (m.showPreview || m.recommended.length > 0) {
      lines.push("");
      lines.push(theme.bold(theme.fg("accent", "Recommended Fold Candidates")));
      if (m.recommended.length === 0) {
        lines.push(theme.fg("dim", "  No candidate spans above compressible floor."));
      } else {
        for (const rec of m.recommended.slice(0, 5)) {
          lines.push(
            truncateToWidth(
              `  ${theme.fg("accent", `${rec.start}..${rec.end}`)}  ${theme.fg("muted", `${formatTokens(rec.tokens)} tokens`)}`,
              width,
              Ellipsis.Unicode,
            ),
          );
        }
      }
    }

    return lines;
  }

  #renderAnsiBlocks(width: number): string[] {
    const m = this.model;
    if (m.blocks.length === 0) {
      return [
        theme.fg("muted", "No fold blocks in this session yet."),
        theme.fg("dim", "Origami advertises fold ranges automatically once conversation growth crosses the step threshold."),
      ];
    }

    const lines: string[] = [];
    const cursorGlyph = theme.nav.cursor;
    const cursorBlank = " ".repeat(Math.max(1, visibleWidth(cursorGlyph)));

    for (let i = 0; i < m.blocks.length; i++) {
      const b = m.blocks[i]!;
      const selected = i === m.selected;
      const cursor = selected ? theme.fg("accent", cursorGlyph) : cursorBlank;
      const tierColor: ThemeColor = b.tier === 3 ? "warning" : b.tier === 2 ? "syntaxKeyword" : "accent";
      const tierTag = theme.fg(tierColor, `[T${b.tier}]`);
      const idStr = selected ? theme.bold(theme.fg("accent", b.id.padEnd(4))) : theme.fg("text", b.id.padEnd(4));
      const covStr = theme.fg("dim", b.coverage.padEnd(16));
      const ratioStr = `${theme.fg("muted", formatTokens(b.tokensBefore))}${theme.fg("dim", "→")}${theme.fg("success", formatTokens(b.tokensAfter))}`;
      const stateTag =
        b.status === "consumed"
          ? ` ${theme.fg("warning", `[consumed → ${b.consumedBy}]`)}`
          : b.status === "unfolded"
            ? ` ${theme.fg("warning", "[unfolded]")}`
            : "";
      const prefix = `${cursor} ${idStr} ${tierTag} ${covStr} ${ratioStr}  `;
      const topicBudget = Math.max(8, width - visibleWidth(prefix) - visibleWidth(stateTag));
      const topicStr = truncateToWidth(b.topic, topicBudget, Ellipsis.Unicode);
      const paintedTopic =
        b.status !== "active"
          ? theme.fg("dim", topicStr)
          : selected
            ? theme.bold(theme.fg("text", topicStr))
            : theme.fg("muted", topicStr);
      lines.push(truncateToWidth(`${prefix}${paintedTopic}${stateTag}`, width, Ellipsis.Omit));
    }
    return lines;
  }

  #renderAnsiDrilldown(width: number): string[] {
    const m = this.model;
    const block = m.blocks.find((b) => b.id === m.drillBlockId);
    if (!block) return [theme.fg("error", `Block ${m.drillBlockId} not found.`)];

    const savedPct =
      block.tokensBefore > 0
        ? Math.round(((block.tokensBefore - block.tokensAfter) / block.tokensBefore) * 100)
        : 0;
    const header = [
      truncateToWidth(
        `${theme.bold(theme.fg("accent", block.id))} · ${theme.fg("syntaxKeyword", `Tier ${block.tier}`)} · ` +
          `${block.status === "active" ? theme.fg("success", "LIVE") : theme.fg("warning", block.status === "consumed" ? "CONSUMED" : "UNFOLDED")} · ` +
          `${theme.bold(theme.fg("text", block.topic))}`,
        width,
        Ellipsis.Unicode,
      ),
      truncateToWidth(
        `${theme.fg("muted", "Coverage:")} ${theme.fg("text", block.coverage)}   ` +
          `${theme.fg("muted", "Tokens:")} ${theme.fg("text", `${formatTokens(block.tokensBefore)} → ${formatTokens(block.tokensAfter)}`)} ${theme.fg("success", `(-${savedPct}%)`)}` +
          (block.children.length > 0
            ? `   ${theme.fg("muted", "Children:")} ${theme.fg("accent", block.children.join(", "))}`
            : ""),
        width,
        Ellipsis.Unicode,
      ),
      theme.fg("border", "─".repeat(Math.min(width, 72))),
    ];

    const rawSummary = block.summary.split("\n");
    const maxScroll = Math.max(0, rawSummary.length - 12);
    if (m.scroll > maxScroll) m.scroll = maxScroll;
    const visible = rawSummary.slice(m.scroll, m.scroll + 14);
    for (const line of visible) {
      const styled = line.startsWith("#")
        ? theme.bold(theme.fg("accent", line))
        : line.startsWith("- ")
          ? `${theme.fg("accent", "  • ")}${theme.fg("text", line.slice(2))}`
          : theme.fg("muted", line);
      header.push(truncateToWidth(styled, width, Ellipsis.Unicode));
    }
    if (rawSummary.length > 14) {
      header.push(theme.fg("dim", `Lines ${m.scroll + 1}–${Math.min(rawSummary.length, m.scroll + 14)} of ${rawSummary.length} (↑/↓/PgUp/PgDn to scroll)`));
    }
    return header;
  }

  #renderAnsiZones(width: number): string[] {
    const m = this.model;
    if (m.zones.length === 0) {
      return [theme.fg("muted", "No context zones bound yet.")];
    }

    const lines: string[] = [];
    const totalZoneTokens = Math.max(1, m.zones.reduce((s, z) => s + Math.max(1, z.tokens), 0));
    const barW = Math.max(16, Math.min(width - 2, 68));

    // Token-weighted proportional ANSI zone bar
    let bar = "";
    let usedCols = 0;
    m.zones.forEach((z, idx) => {
      const share = Math.max(1, z.tokens) / totalZoneTokens;
      const cols =
        idx === m.zones.length - 1
          ? Math.max(1, barW - usedCols)
          : Math.max(1, Math.round(share * barW));
      usedCols += cols;
      const color: ThemeColor =
        z.kind === "folded" ? "syntaxKeyword" : z.kind === "compressible" ? "success" : "muted";
      bar += theme.fg(color, "█".repeat(Math.max(1, Math.min(cols, barW))));
    });
    lines.push(truncateToWidth(bar, width, Ellipsis.Omit));
    lines.push(
      `${theme.fg("muted", "█")} ${theme.fg("dim", "protected")}   ` +
        `${theme.fg("syntaxKeyword", "█")} ${theme.fg("dim", "folded")}   ` +
        `${theme.fg("success", "█")} ${theme.fg("dim", "compressible")}`,
    );
    lines.push("");

    for (const z of m.zones) {
      const color: ThemeColor =
        z.kind === "folded" ? "syntaxKeyword" : z.kind === "compressible" ? "success" : "muted";
      const pct = Math.round((z.tokens / totalZoneTokens) * 100);
      lines.push(
        truncateToWidth(
          `  ${theme.fg(color, z.kind.padEnd(14))} ${theme.fg("text", `${z.start}..${z.end}`.padEnd(18))} ` +
            `${theme.fg("muted", `${String(z.messages).padStart(3)} msg`)}   ` +
            `${theme.fg("text", formatTokens(z.tokens).padStart(7))} ${theme.fg("dim", `(${String(pct).padStart(2)}%)`)}`,
          width,
          Ellipsis.Unicode,
        ),
      );
    }
    return lines;
  }

  #renderAnsiFooter(width: number): string[] {
    const out: string[] = [];
    if (this.model.statusMessage) {
      out.push(truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("text", this.model.statusMessage)}`, width, Ellipsis.Unicode));
    }
    const hints =
      this.model.drillBlockId !== null
        ? `${theme.fg("accent", "↑/↓")} ${theme.fg("dim", "scroll")}  ${theme.fg("accent", "u")} ${theme.fg("dim", "unfold file")}  ${theme.fg("accent", "i")} ${theme.fg("dim", "unfold inline")}  ${theme.fg("accent", "Esc")} ${theme.fg("dim", "back")}`
        : `${theme.fg("accent", "←/→")} ${theme.fg("dim", "tab")}  ${theme.fg("accent", "↑/↓")} ${theme.fg("dim", "select")}  ${theme.fg("accent", "Enter")} ${theme.fg("dim", "inspect")}  ${theme.fg("accent", "u")} ${theme.fg("dim", "unfold file")}  ${theme.fg("accent", "i")} ${theme.fg("dim", "inline")}  ${theme.fg("accent", "f")} ${theme.fg("dim", "preview")}  ${theme.fg("accent", "Esc")} ${theme.fg("dim", "close")}`;
    out.push(truncateToWidth(hints, width, Ellipsis.Omit));
    return out;
  }

  #describeContextGauge(): NativeNode[] {
    const m = this.model;
    const windowTotal = m.windowTokens > 0 ? m.windowTokens : Math.max(1, m.usedTokens);
    const usedRatio = Math.min(1, m.usedTokens / windowTotal);
    const liveBlockCount = m.blocks.filter((b) => b.status === "active").length;

    const parts = m.categories
      .filter((c) => c.tokens > 0)
      .map((c) => ({
        value: c.tokens / windowTotal,
        token: c.id === "free" ? "track" : c.color,
        label: `${c.label} · ${formatTokens(c.tokens)} (${c.pct.toFixed(1)}%)`,
      }));

    const summary = node(
      "row",
      { role: "omp.context.summary", align: "baseline", wrap: true },
      [
        text(
          [
            span(formatTokens(m.usedTokens), "strong"),
            span(
              m.windowTokens > 0
                ? ` of ${formatTokens(m.windowTokens)} tokens · ${m.occupancyPct}%`
                : " tokens",
              "dim",
            ),
          ],
          { role: "omp.context.used", grow: 1, wrap: "none" },
        ),
        text(
          [
            span(`-${formatTokens(m.foldedSavings)}`, "success strong"),
            span(` reclaimed (${liveBlockCount}b) · growth ${formatTokens(m.growthSinceFold)}↑/${formatTokens(m.growthStep)}`, "muted"),
          ],
          { role: "omp.context.room", wrap: "none" },
        ),
      ],
      "summary",
    );

    const bar = node(
      "meter",
      {
        value: usedRatio,
        style: "bar",
        size: "lg",
        parts,
        thresholds: { warn: 0.7, bad: 0.85 },
        aria: "Origami context occupancy by category",
      },
      undefined,
      "bar",
    );

    return [summary, bar];
  }

  #describeTabBody(cx: DescribeContext): NativeNode[] {
    const m = this.model;
    if (m.tab === 0) {
      const v = m.vault;
      const ratioStr = v.archivedTokens > 0 ? `${v.compressionRatio}×` : "1.0×";
      const statTiles: NativeChild[] = [
        node(
          "col",
          { role: "omp.origami.vault.stat", gap: "xs", title: "Original conversation tokens preserved in Origami's archive" },
          [
            text([span("Archived Stored", "muted")], { role: "omp.origami.stat.label", truncate: "end" }),
            text([span(formatTokens(v.archivedTokens), "strong mono")], { role: "omp.origami.stat.value", truncate: "end" }),
            text([span(`${v.archivedMessages} msgs · ${v.activeBlocks}b`, "dim")], { role: "omp.origami.stat.sub", truncate: "end" }),
          ],
          "tile-stored",
        ),
        node(
          "col",
          { role: "omp.origami.vault.stat", gap: "xs", title: "Summary tokens currently occupying prompt context" },
          [
            text([span("Active Summaries", "muted")], { role: "omp.origami.stat.label", truncate: "end" }),
            text([span(formatTokens(v.summaryTokens), "success strong mono")], { role: "omp.origami.stat.value", truncate: "end" }),
            text([span(`${v.activeBlocks} live blocks`, "dim")], { role: "omp.origami.stat.sub", truncate: "end" }),
          ],
          "tile-summaries",
        ),
        node(
          "col",
          { role: "omp.origami.vault.stat", gap: "xs", title: "Ratio of archived original tokens to in-context summaries" },
          [
            text([span("Compression", "muted")], { role: "omp.origami.stat.label", truncate: "end" }),
            text([span(ratioStr, "accent strong mono")], { role: "omp.origami.stat.value", truncate: "end" }),
            text([span(`-${formatTokens(v.reclaimedTokens)} (${v.savingsPct}%)`, "success")], { role: "omp.origami.stat.sub", truncate: "end" }),
          ],
          "tile-ratio",
        ),
        node(
          "col",
          { role: "omp.origami.vault.stat", gap: "xs", title: "Tokens accumulated toward next automatic fold step" },
          [
            text([span("Growth / Step", "muted")], { role: "omp.origami.stat.label", truncate: "end" }),
            text([span(formatTokens(m.growthSinceFold), "warning strong mono")], { role: "omp.origami.stat.value", truncate: "end" }),
            text([span(`of ${formatTokens(m.growthStep)} step`, "dim")], { role: "omp.origami.stat.sub", truncate: "end" }),
          ],
          "tile-growth",
        ),
      ];
      const vaultGrid = node("row", { gap: "lg", role: "omp.origami.vault.stats" }, statTiles, "vault-stats");
      const catItems = m.categories.map((c) =>
        item(c.id, {
          label: [span(`${c.id === "free" ? "□" : "■"} `, c.color), span(c.label)],
          value: `${formatTokens(c.tokens)} · ${c.pct.toFixed(1)}%`,
        }),
      );
      const hitStr =
        m.trajectory.overallHitPct != null
          ? `${m.trajectory.overallHitPct.toFixed(1)}% (${formatTokens(m.trajectory.totalCached)} / ${formatTokens(m.trajectory.totalInput)})`
          : "No rounds yet";
      const telemetry = kv([
        ["Growth Since Fold", `${formatTokens(m.growthSinceFold)} / ${formatTokens(m.growthStep)} step`],
        ["Compressible Pool", `${formatTokens(m.compressibleTokens)} / ${formatTokens(m.compressibleFloor)} floor`],
        ["Prompt Cache Hit Rate", hitStr],
      ]);
      const out: NativeNode[] = [vaultGrid, list(catItems, undefined, "cat-list")];
      if (telemetry) out.push(telemetry);
      if (m.showPreview || m.recommended.length > 0) {
        out.push(
          node(
            "section",
            { head: "Recommended Fold Candidates", role: "omp.origami.preview" },
            m.recommended.length > 0
              ? [
                  list(
                    m.recommended.slice(0, 6).map((r, i) =>
                      item(`rec-${i}`, {
                        label: [span(`${r.start}..${r.end}`, "accent mono strong")],
                        value: `${formatTokens(r.tokens)} tokens`,
                      }),
                    ),
                  ),
                ]
              : [text([span("No candidate spans above compressible floor yet.", "muted")])],
            "preview-sec",
          ),
        );
      }
      return out;
    }

    if (m.tab === 1) {
      if (cx.supports("chart")) {
        const maxBars = Math.max(24, Math.min(Math.floor((cx.cols - 16) / 2), 50));
        return describeNativeTrajectory(m.trajectory, maxBars);
      }
      const ansiLines = renderAnsiTrajectory(m.trajectory, Math.max(40, cx.cols - 8), 8);
      return [node("rows", { cols: Math.max(40, cx.cols - 8), lines: ansiLines }, undefined, "traj-fallback")];
    }

    if (m.tab === 2) {
      if (m.blocks.length === 0) {
        return [
          text([span("No fold blocks in this session yet.", "muted")], {
            role: "omp.origami.empty",
          }),
        ];
      }
      const items = m.blocks.map((b, i) => {
        const selected = i === m.selected;
        const tierToken = b.tier === 3 ? "warning strong" : b.tier === 2 ? "syntaxKeyword strong" : "accent strong";
        const labelSpans: TspSpan[] = [
          span(`${b.id} `, selected ? "accent mono strong" : "mono strong"),
          span(`T${b.tier} `, tierToken),
          span(plainText(b.topic), b.status !== "active" ? "dim" : selected ? "strong" : undefined),
        ];
        if (b.status === "consumed") labelSpans.push(span(` · consumed → ${b.consumedBy}`, "warning"));
        if (b.status === "unfolded") labelSpans.push(span(" · unfolded", "warning"));
        return item(`block${i}`, {
          label: labelSpans,
          detail: b.coverage,
          value: [
            span(formatTokens(b.tokensBefore), "muted mono"),
            span(" → ", "dim"),
            span(formatTokens(b.tokensAfter), "success mono"),
          ],
        });
      });
      return [
        selectList("blocks", items, {
          selected: `block${m.selected}`,
        }),
      ];
    }

    // Tab 3: Zones
    if (m.zones.length === 0) {
      return [text([span("No context zones bound yet.", "muted")])];
    }
    const totalZoneTokens = Math.max(1, m.zones.reduce((s, z) => s + Math.max(1, z.tokens), 0));
    const zoneMeter = node(
      "meter",
      {
        value: 1,
        style: "bar",
        size: "md",
        parts: m.zones.map((z) => ({
          value: Math.max(1, z.tokens) / totalZoneTokens,
          token: z.kind === "folded" ? "syntaxKeyword" : z.kind === "compressible" ? "success" : "muted",
          label: `${z.kind} (${z.start}..${z.end}) · ${formatTokens(z.tokens)}`,
        })),
        aria: "Context zone token distribution",
      },
      undefined,
      "zone-meter",
    );

    const zoneTable = node(
      "table",
      {
        cols: [
          { id: "kind", head: "Zone" },
          { id: "span", head: "Span" },
          { id: "msgs", head: "Messages", align: "end" },
          { id: "tokens", head: "Tokens", align: "end" },
          { id: "share", head: "Share", align: "end" },
        ],
        rows: m.zones.map((z, idx) => {
          const pct = `${((z.tokens / totalZoneTokens) * 100).toFixed(1)}%`;
          const tone = z.kind === "folded" ? "syntaxKeyword" : z.kind === "compressible" ? "success" : "muted";
          return {
            id: `z-${idx}`,
            cells: {
              kind: [span(z.kind, tone)],
              span: [span(`${z.start}..${z.end}`, "mono")],
              msgs: [span(String(z.messages), "mono muted")],
              tokens: [span(formatTokens(z.tokens), "mono")],
              share: [span(pct, "mono muted")],
            },
          };
        }),
      },
      undefined,
      "zone-table",
    );

    return [zoneMeter, zoneTable];
  }

  #describeBlockDetail(block: BlockRow | undefined): NativeNode {
    if (!block) {
      return overlayCard("omp.overlay.origami", "Origami Block Detail", [
        text([span("Block not found.", "error")]),
        actionBar([actionButton("Back", "back", { keys: "escape" })]),
      ]);
    }

    const savedPct =
      block.tokensBefore > 0
        ? Math.round(((block.tokensBefore - block.tokensAfter) / block.tokensBefore) * 100)
        : 0;

    const meta = kv([
      ["Block", `${block.id} · Tier ${block.tier} · ${block.status === "active" ? "LIVE" : block.status === "consumed" ? "CONSUMED" : "UNFOLDED"}`],
      ["Topic", block.topic],
      ["Coverage", block.coverage],
      [
        "Compression",
        `${formatTokens(block.tokensBefore)} → ${formatTokens(block.tokensAfter)} (-${formatTokens(block.reclaimed)}, ${savedPct}%)`,
      ],
      ...(block.children.length > 0 ? ([["Distilled From", block.children.join(", ")]] as [string, string][]) : []),
    ]);

    const actions: (NativeNode | null)[] = [
      actionButton("Back to Blocks", "back", { keys: "escape" }),
      actionButton("Unfold to File", "unfold", { keys: "u", tone: "accent" }),
      ...(block.status === "active" ? [actionButton("Unfold Inline", "unfold-inline", { keys: "i" })] : []),
      null,
      actionButton("Close", "close"),
    ];

    return overlayCard("omp.overlay.origami", `Origami Block ${block.id} — ${block.topic}`, [
      ...(meta ? [meta] : []),
      md(block.summary),
      ...(this.model.statusMessage
        ? [row([text([span("● ", "accent"), span(plainText(this.model.statusMessage), "muted")])])]
        : []),
      actionBar(actions, "detail-actions"),
    ]);
  }
}
