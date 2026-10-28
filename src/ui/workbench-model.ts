import type { CacheRound, StatusBlockRow, StatusReport, StatusVaultReport, StatusZoneRow } from "../engine.ts";
import type { NudgeRange } from "../kernel/nudge.ts";
import { formatTokens } from "../kernel/nudge.ts";
import type { SessionPhase } from "../sessions.ts";
import { buildTrajectoryData, type TrajectoryData } from "./trajectory.ts";

export type BlockRow = StatusBlockRow;
export type ZoneRow = StatusZoneRow;

export const WORKBENCH_TABS = ["Overview", "Trajectory", "Blocks", "Zones"] as const;
export const WORKBENCH_TAB_IDS = ["overview", "trajectory", "blocks", "zones"] as const;

export interface WorkbenchCategory {
  id: "overhead" | "conversation" | "tools" | "summaries" | "free";
  label: string;
  tokens: number;
  pct: number;
  color: "syntaxKeyword" | "accent" | "warning" | "success" | "dim";
  symbol: "context.content" | "context.messages" | "context.buffer" | "context.compaction" | "context.free";
}

/** One row of the session tree (depth-first order) shown in the workbench header. */
export interface WorkbenchSession {
  sessionId: string;
  label: string;
  /** Depth in the session tree (0 = root). */
  level: number;
  phase: SessionPhase;
  occupancyPct: number;
}

export interface WorkbenchModel {
  tab: number;
  selected: number;
  drillBlockId: string | null;
  scroll: number;
  showPreview: boolean;
  statusMessage: string | null;
  occupancyPct: number;
  windowTokens: number;
  usedTokens: number;
  freeTokens: number;
  liveTokens: number;
  foldedSavings: number;
  growthSinceFold: number;
  growthStep: number;
  compressibleTokens: number;
  compressibleFloor: number;
  tokenSplit: StatusReport["tokenSplit"];
  vault: StatusVaultReport;
  categories: WorkbenchCategory[];
  blocks: BlockRow[];
  zones: ZoneRow[];
  rounds: CacheRound[];
  recommended: NudgeRange[];
  trajectory: TrajectoryData;
  /** Session tree; the model's numbers describe `sessionId`. */
  sessions: WorkbenchSession[];
  sessionId: string;
}

export function buildWorkbenchModel(
  report: StatusReport,
  rounds: readonly CacheRound[],
  windowTokens: number,
  tab = 0,
  selected = 0,
  recommended: readonly NudgeRange[] = [],
  sessions: readonly WorkbenchSession[] = [],
  sessionId = "",
): WorkbenchModel {
  const effectiveWindow = Math.max(0, windowTokens || report.windowTokens || 0);
  const usedTokens = report.usedTokens;
  const freeTokens = effectiveWindow > 0 ? Math.max(0, effectiveWindow - usedTokens) : 0;
  const denom = effectiveWindow > 0 ? effectiveWindow : Math.max(1, usedTokens);
  const pctOf = (v: number) => Math.round((v / denom) * 1000) / 10;

  const sysAndSchema = report.tokenSplit.overhead + report.tokenSplit.system;
  const categories: WorkbenchCategory[] = [
    {
      id: "overhead",
      label: "System & Tool Schemas",
      tokens: sysAndSchema,
      pct: pctOf(sysAndSchema),
      color: "syntaxKeyword",
      symbol: "context.content",
    },
    {
      id: "conversation",
      label: "Conversation",
      tokens: report.tokenSplit.conversation,
      pct: pctOf(report.tokenSplit.conversation),
      color: "accent",
      symbol: "context.messages",
    },
    {
      id: "tools",
      label: "Tool Outputs",
      tokens: report.tokenSplit.tools,
      pct: pctOf(report.tokenSplit.tools),
      color: "warning",
      symbol: "context.buffer",
    },
    {
      id: "summaries",
      label: "Fold Summaries",
      tokens: report.tokenSplit.summaries,
      pct: pctOf(report.tokenSplit.summaries),
      color: "success",
      symbol: "context.compaction",
    },
    {
      id: "free",
      label: "Free Window",
      tokens: freeTokens,
      pct: pctOf(freeTokens),
      color: "dim",
      symbol: "context.free",
    },
  ];

  const trajectory = buildTrajectoryData({
    rounds,
    blocks: report.blocks,
    windowTokens: effectiveWindow,
    baselineTokens: sysAndSchema,
  });

  return {
    tab: Math.max(0, Math.min(tab, WORKBENCH_TABS.length - 1)),
    selected: report.blocks.length > 0 ? Math.max(0, Math.min(selected, report.blocks.length - 1)) : 0,
    drillBlockId: null,
    scroll: 0,
    showPreview: false,
    statusMessage: null,
    occupancyPct: report.occupancyPct,
    windowTokens: effectiveWindow,
    usedTokens,
    freeTokens,
    liveTokens: usedTokens,
    foldedSavings: report.tokenSplit.foldedSavings,
    growthSinceFold: report.growthSinceFold,
    growthStep: report.growthStep,
    compressibleTokens: report.compressibleTokens,
    compressibleFloor: report.compressibleFloor,
    tokenSplit: report.tokenSplit,
    vault: report.vault,
    categories,
    blocks: report.blocks,
    zones: report.zones,
    rounds: [...rounds],
    recommended: [...recommended],
    trajectory,
    sessions: [...sessions],
    sessionId,
  };
}

export function syncWorkbenchModel(target: WorkbenchModel, next: WorkbenchModel): void {
  const prevTab = target.tab;
  const prevSelectedId = target.blocks[target.selected]?.id;
  const prevDrill = target.drillBlockId;
  const prevScroll = target.scroll;
  const prevPreview = target.showPreview;
  const prevStatus = target.statusMessage;

  Object.assign(target, next);
  target.tab = prevTab;
  target.showPreview = prevPreview;
  target.statusMessage = prevStatus;

  if (prevSelectedId) {
    const idx = target.blocks.findIndex((b) => b.id === prevSelectedId);
    target.selected = idx >= 0 ? idx : Math.max(0, Math.min(target.selected, target.blocks.length - 1));
  }
  if (prevDrill && target.blocks.some((b) => b.id === prevDrill)) {
    target.drillBlockId = prevDrill;
    target.scroll = prevScroll;
  } else {
    target.drillBlockId = null;
    target.scroll = 0;
  }
}

export function workbenchLines(model: WorkbenchModel): string[] {
  const winStr =
    model.windowTokens > 0
      ? `${formatTokens(model.usedTokens)} / ${formatTokens(model.windowTokens)} (${model.occupancyPct}%)`
      : `${formatTokens(model.usedTokens)} tokens`;
  const growth = `${formatTokens(model.growthSinceFold)}↑/${formatTokens(model.growthStep)}`;
  const liveBlocks = model.blocks.filter((b) => b.status === "active").length;
  const lines: string[] = [];
  const focusIdx = model.sessions.findIndex((s) => s.sessionId === model.sessionId);
  if (model.sessions.length > 1 && focusIdx >= 0) {
    const s = model.sessions[focusIdx]!;
    lines.push(`session ${s.label} · ${s.phase} (${focusIdx + 1}/${model.sessions.length}) · s/S switch`);
  }
  lines.push(
    `window ${winStr} · reclaimed ${formatTokens(model.foldedSavings)} across ${liveBlocks} block(s)`,
    `growth ${growth} · compressible ${formatTokens(model.compressibleTokens)} / floor ${formatTokens(model.compressibleFloor)}`,
    "",
  );
  if (model.tab === 0) {
    for (const c of model.categories) {
      lines.push(`  ${c.label.padEnd(24)} ${formatTokens(c.tokens).padStart(8)}  ${c.pct.toFixed(1).padStart(5)}%`);
    }
  } else if (model.tab === 1) {
    if (model.trajectory.lines.length === 0) {
      lines.push("  (no request rounds recorded yet)");
    } else {
      for (const l of model.trajectory.lines.slice(-12)) {
        const hit = l.hitPct != null ? `${l.hitPct.toFixed(1)}%` : "—";
        lines.push(`  #${l.seq}  in ${formatTokens(l.input)}  cached ${formatTokens(l.cached)}  hit ${hit}`);
      }
    }
  } else if (model.tab === 2) {
    if (model.blocks.length === 0) {
      lines.push("  (no fold blocks yet)");
    } else {
      for (let i = 0; i < model.blocks.length; i++) {
        const b = model.blocks[i]!;
        const marker = i === model.selected ? "▶ " : "  ";
        lines.push(
          `${marker}${b.id}  T${b.tier}  ${b.coverage}  ${formatTokens(b.tokensBefore)}→${formatTokens(b.tokensAfter)}  ${b.topic}${b.status === "consumed" ? ` [consumed → ${b.consumedBy}]` : b.status === "unfolded" ? " [unfolded]" : ""}`,
        );
      }
    }
  } else {
    if (model.zones.length === 0) {
      lines.push("  (no zones)");
    } else {
      for (const z of model.zones) {
        lines.push(`  ${z.kind.padEnd(14)} ${z.start}..${z.end}  ${formatTokens(z.tokens)}t`);
      }
    }
  }
  return lines;
}

export interface WorkbenchActions {
  model(): WorkbenchModel;
  refresh?(): WorkbenchModel;
  previewFold(): string[];
  unfoldSelected(id: string, mode?: "file" | "inline"): Promise<string>;
  drill(id: string): string[];
  /** Rebuild the model for another session in the tree; null if it cannot be shown. */
  focusSession?(sessionId: string): WorkbenchModel | null;
}

export interface WorkbenchKeyOutcome {
  handled: boolean;
  close?: boolean;
  message?: string;
  pendingUnfold?: { id: string; mode: "file" | "inline" };
}

export function handleWorkbenchKey(
  model: WorkbenchModel,
  data: string,
  actions: WorkbenchActions,
): WorkbenchKeyOutcome {
  // In-overlay block detail sub-view navigation
  if (model.drillBlockId !== null) {
    if (data === "\x1b" || data === "\x7f" || data === "\b" || data === "q" || data === "\r" || data === "\n") {
      model.drillBlockId = null;
      model.scroll = 0;
      return { handled: true };
    }
    if (data === "\x1b[A" || data === "k") {
      model.scroll = Math.max(0, model.scroll - 1);
      return { handled: true };
    }
    if (data === "\x1b[B" || data === "j") {
      model.scroll += 1;
      return { handled: true };
    }
    if (data === "\x1b[5~") {
      model.scroll = Math.max(0, model.scroll - 8);
      return { handled: true };
    }
    if (data === "\x1b[6~") {
      model.scroll += 8;
      return { handled: true };
    }
    if (data === "u") {
      return { handled: true, pendingUnfold: { id: model.drillBlockId, mode: "file" } };
    }
    if (data === "i") {
      return { handled: true, pendingUnfold: { id: model.drillBlockId, mode: "inline" } };
    }
    return { handled: false };
  }

  if (data === "\x1b" || data === "q") return { handled: true, close: true };
  if ((data === "s" || data === "S") && actions.focusSession) {
    const n = model.sessions.length;
    if (n < 2) {
      model.statusMessage = "No other sessions to switch to.";
      return { handled: true };
    }
    const cur = Math.max(0, model.sessions.findIndex((s) => s.sessionId === model.sessionId));
    const target = model.sessions[(cur + (data === "s" ? 1 : n - 1)) % n]!;
    const next = actions.focusSession(target.sessionId);
    if (!next) {
      model.statusMessage = `Session ${target.label} is not available.`;
      return { handled: true };
    }
    const tab = model.tab;
    Object.assign(model, next);
    model.tab = tab;
    model.selected = 0;
    model.drillBlockId = null;
    model.scroll = 0;
    model.showPreview = false;
    model.statusMessage = `Focused ${target.label} (${target.phase}).`;
    return { handled: true };
  }
  if (data === "\x1b[D" || data === "h" || data === "\x1b[Z") {
    model.tab = (model.tab + WORKBENCH_TABS.length - 1) % WORKBENCH_TABS.length;
    return { handled: true };
  }
  if (data === "\x1b[C" || data === "l" || data === "\t") {
    model.tab = (model.tab + 1) % WORKBENCH_TABS.length;
    return { handled: true };
  }
  if (data === "1" || data === "2" || data === "3" || data === "4") {
    model.tab = Number(data) - 1;
    return { handled: true };
  }
  if (data === "\x1b[A" || data === "k") {
    if (model.blocks.length > 0) {
      model.selected = Math.max(0, model.selected - 1);
    }
    return { handled: true };
  }
  if (data === "\x1b[B" || data === "j") {
    if (model.blocks.length > 0) {
      model.selected = Math.min(model.blocks.length - 1, model.selected + 1);
    }
    return { handled: true };
  }
  if (data === "f") {
    model.showPreview = !model.showPreview;
    if (model.showPreview) {
      model.tab = 0;
      const ranges = actions.previewFold();
      model.statusMessage =
        ranges.length > 0
          ? `Fold preview: ${ranges.slice(0, 3).join(", ")}${ranges.length > 3 ? ` (+${ranges.length - 3} more)` : ""}`
          : "No compressible ranges above floor yet.";
    } else {
      model.statusMessage = null;
    }
    return { handled: true };
  }
  if (data === "u" || data === "i") {
    const block = model.blocks[model.selected];
    if (!block) {
      model.statusMessage = "No fold block selected.";
      return { handled: true };
    }
    const mode = data === "i" ? "inline" : "file";
    if (mode === "inline" && block.status !== "active") {
      const reason = block.status === "consumed" ? `consumed by ${block.consumedBy}` : "unfolded";
      model.statusMessage = `Block ${block.id} is not active (${reason}).`;
      return { handled: true };
    }
    return { handled: true, pendingUnfold: { id: block.id, mode } };
  }
  if (data === "\r" || data === "\n") {
    const block = model.blocks[model.selected];
    if (!block) {
      if (model.tab !== 2) {
        model.tab = 2;
        return { handled: true };
      }
      model.statusMessage = "No fold block selected.";
      return { handled: true };
    }
    model.drillBlockId = block.id;
    model.scroll = 0;
    return { handled: true };
  }
  return { handled: false };
}
