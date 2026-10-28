import type { CacheRound, StatusReport } from "../engine.ts";
import { formatTokens } from "../kernel/nudge.ts";

export interface BlockRow {
  id: string;
  tier: number;
  coverage: string;
  tokens: number;
  topic: string;
  superseded: boolean;
}

export interface ZoneRow {
  kind: string;
  start: string;
  end: string;
}

export interface WorkbenchModel {
  tab: number;
  selected: number;
  occupancyPct: number;
  windowTokens: number;
  liveTokens: number;
  foldedSavings: number;
  growthSinceFold: number;
  growthStep: number;
  compressibleTokens: number;
  compressibleFloor: number;
  blocks: BlockRow[];
  zones: ZoneRow[];
  rounds: CacheRound[];
}

export const WORKBENCH_TABS = ["Blocks", "Cache", "Zones"] as const;

export function buildWorkbenchModel(
  report: StatusReport,
  rounds: readonly CacheRound[],
  windowTokens: number,
  tab = 0,
  selected = 0,
): WorkbenchModel {
  const liveTokens = report.tokenSplit.live + report.tokenSplit.tools + report.tokenSplit.system;
  return {
    tab,
    selected: Math.max(0, Math.min(selected, report.blocks.length - 1)),
    occupancyPct: report.occupancyPct,
    windowTokens,
    liveTokens,
    foldedSavings: report.tokenSplit.foldedSavings,
    growthSinceFold: report.growthSinceFold,
    growthStep: report.growthStep,
    compressibleTokens: report.compressibleTokens,
    compressibleFloor: report.compressibleFloor,
    blocks: report.blocks,
    zones: report.zones,
    rounds: rounds.slice(-20),
  };
}

function band(model: WorkbenchModel): string {
  const window = model.windowTokens || 1;
  const live = Math.round((model.liveTokens / window) * 100);
  const folded = Math.round((model.foldedSavings / window) * 100);
  const free = Math.max(0, 100 - live - folded);
  return `context band   live ${live}% · folded ${folded}% · free ${free}%`;
}

function blocksLines(model: WorkbenchModel): string[] {
  const lines: string[] = [];
  for (let i = 0; i < model.blocks.length; i++) {
    const b = model.blocks[i]!;
    const marker = i === model.selected ? "▶ " : "  ";
    const dim = b.superseded ? " (superseded)" : "";
    lines.push(`${marker}${b.id}  tier ${b.tier}  ${b.coverage}  ${formatTokens(b.tokens)}  ${b.topic}${dim}`);
  }
  if (lines.length === 0) lines.push("  (no fold blocks yet)");
  return lines;
}

function cacheLines(model: WorkbenchModel): string[] {
  const lines = ["ts              total_in   cache_read  cache_write  fold"];
  for (const r of model.rounds) {
    lines.push(
      `${new Date(r.ts).toISOString().slice(11, 19)}  ${String(r.totalIn).padStart(8)}  ` +
        `${String(r.cacheRead).padStart(10)}  ${String(r.cacheWrite).padStart(11)}  ${r.foldEventId ?? ""}`,
    );
  }
  if (model.rounds.length === 0) lines.push("(no rounds recorded yet)");
  const last = model.rounds[model.rounds.length - 1];
  if (last && last.totalIn > 0) {
    const hit = Math.round((last.cacheRead / last.totalIn) * 100);
    lines.push(`latest cache hit rate ${hit}%`);
  }
  return lines;
}

function zonesLines(model: WorkbenchModel): string[] {
  const lines: string[] = [];
  for (const z of model.zones) {
    lines.push(`${z.kind.padEnd(12)} ${z.start}..${z.end}`);
  }
  if (lines.length === 0) lines.push("  (no zones)");
  return lines;
}

export function workbenchLines(model: WorkbenchModel): string[] {
  const growth = `${formatTokens(model.growthSinceFold)}↑/${formatTokens(model.growthStep)}`;
  const lines = [
    band(model),
    `growth ${growth}   compressible ${formatTokens(model.compressibleTokens)} / floor ${formatTokens(model.compressibleFloor)}`,
    "",
  ];
  if (model.tab === 0) lines.push(...blocksLines(model));
  else if (model.tab === 1) lines.push(...cacheLines(model));
  else lines.push(...zonesLines(model));
  lines.push("");
  lines.push("[←/→] tab  [↑/↓] select  [f] fold preview  [u] unfold  [Enter] drill  [Esc] close");
  return lines;
}

export interface WorkbenchActions {
  model(): WorkbenchModel;
  previewFold(): string[];
  unfoldSelected(id: string): Promise<string>;
  drill(id: string): string[];
}

export interface WorkbenchKeyOutcome {
  handled: boolean;
  close?: boolean;
  message?: string;
}

export function handleWorkbenchKey(model: WorkbenchModel, data: string, actions: WorkbenchActions): WorkbenchKeyOutcome {
  if (data === "\x1b" || data === "q") return { handled: true, close: true };
  if (data === "\x1b[D" || data === "h") {
    model.tab = (model.tab + WORKBENCH_TABS.length - 1) % WORKBENCH_TABS.length;
    return { handled: true };
  }
  if (data === "\x1b[C" || data === "l" || data === "\t") {
    model.tab = (model.tab + 1) % WORKBENCH_TABS.length;
    return { handled: true };
  }
  if (data === "1" || data === "2" || data === "3") {
    model.tab = Number(data) - 1;
    return { handled: true };
  }
  if (data === "\x1b[A" || data === "k") {
    model.selected = Math.max(0, model.selected - 1);
    return { handled: true };
  }
  if (data === "\x1b[B" || data === "j") {
    model.selected = Math.min(model.blocks.length - 1, model.selected + 1);
    return { handled: true };
  }
  if (data === "f") {
    return { handled: true, message: actions.previewFold().join("\n") };
  }
  if (data === "u") {
    const block = model.blocks[model.selected];
    if (!block) return { handled: true, message: "no block selected" };
    return { handled: true, message: `unfold ${block.id} requested` };
  }
  if (data === "\r" || data === "\n") {
    const block = model.blocks[model.selected];
    if (!block) return { handled: true, message: "no block selected" };
    return { handled: true, message: actions.drill(block.id).join("\n") };
  }
  return { handled: false };
}