import type { StatusReport } from "../engine.ts";
import { formatTokens } from "../kernel/nudge.ts";

/**
 * Compact status-line chip: `origami 41% · 12.4K↑/50K · 3b`. Never the
 * window-percentage growth voice — growth is shown as tokens vs its step.
 */
export function formatStatusChip(report: StatusReport): string {
  const growth = `${formatTokens(report.growthSinceFold)}↑/${formatTokens(report.growthStep)}`;
  const blocks = `${report.blocks.filter((b) => !b.superseded).length}b`;
  return `origami ${report.occupancyPct}% · ${growth} · ${blocks}`;
}