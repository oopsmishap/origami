import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { StatusReport } from "../engine.ts";
import { formatTokens } from "../kernel/nudge.ts";

/**
 * Compact status-line chip: `origami 9% · 12.4K↑/50K · 2b -50.8K · 1 sub`.
 * Always describes the root (main) session; `subagents` counts its live,
 * folding-active descendants so their activity is visible without stealing the chip.
 * Supports optional omp Theme styling for footer status bars while remaining
 * clean plain text when no theme is supplied.
 */
export function formatStatusChip(report: StatusReport, theme?: Theme, subagents = 0): string {
  const liveBlocks = report.blocks.filter((b) => b.status === "active").length;
  const saved = report.tokenSplit.foldedSavings;
  const growth = `${formatTokens(report.growthSinceFold)}↑/${formatTokens(report.growthStep)}`;
  const v = report.vault;
  const ratioLabel = v && v.archivedTokens > 0 && v.compressionRatio > 1 ? ` (${v.compressionRatio}×)` : "";
  const blocksLabel = saved > 0 ? `${liveBlocks}b -${formatTokens(saved)}${ratioLabel}` : `${liveBlocks}b`;
  const subLabel = subagents > 0 ? `${subagents} sub` : "";

  if (!theme) {
    return `origami ${report.occupancyPct}% · ${growth} · ${blocksLabel}${subLabel ? ` · ${subLabel}` : ""}`;
  }

  const icon = theme.styledSymbol("context.compaction", "accent");
  const pctColor =
    report.occupancyPct >= 85 ? "error" : report.occupancyPct >= 70 ? "warning" : "statusLineContext";
  const sep = theme.fg("dim", theme.sep.dot);
  const pctPart = theme.fg(pctColor, `${report.occupancyPct}%`);
  const growthColor = report.growthSinceFold >= report.growthStep ? "warning" : "muted";
  const growthPart = theme.fg(growthColor, growth);
  const blocksPart =
    saved > 0
      ? `${theme.fg("muted", `${liveBlocks}b`)} ${theme.fg("success", `-${formatTokens(saved)}`)}${ratioLabel ? ` ${theme.fg("accent", ratioLabel.trim())}` : ""}`
      : theme.fg("dim", `${liveBlocks}b`);
  const subPart = subLabel ? `${sep}${theme.fg("accent", subLabel)}` : "";
  return `${icon} ${theme.fg("muted", "origami")} ${pctPart}${sep}${growthPart}${sep}${blocksPart}${subPart}`;
}