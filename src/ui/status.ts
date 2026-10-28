import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { StatusReport } from "../engine.ts";
import { formatTokens } from "../kernel/nudge.ts";

/**
 * Compact status-line chip: `origami 9% · 12.4K↑/50K · 2b -50.8K`.
 * Supports optional omp Theme styling for footer status bars while remaining
 * clean plain text when no theme is supplied.
 */
export function formatStatusChip(report: StatusReport, theme?: Theme): string {
  const liveBlocks = report.blocks.filter((b) => !b.superseded).length;
  const saved = report.tokenSplit.foldedSavings;
  const growth = `${formatTokens(report.growthSinceFold)}↑/${formatTokens(report.growthStep)}`;
  const blocksLabel = saved > 0 ? `${liveBlocks}b -${formatTokens(saved)}` : `${liveBlocks}b`;

  if (!theme) {
    return `origami ${report.occupancyPct}% · ${growth} · ${blocksLabel}`;
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
      ? `${theme.fg("muted", `${liveBlocks}b`)} ${theme.fg("success", `-${formatTokens(saved)}`)}`
      : theme.fg("dim", `${liveBlocks}b`);
  return `${icon} ${theme.fg("muted", "origami")} ${pctPart}${sep}${growthPart}${sep}${blocksPart}`;
}