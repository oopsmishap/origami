import type { AgenticRunResult } from "./agent.ts";
import type { RunnerCliArgs } from "./runner.ts";
import { SCALE_TURNS, type ScenarioMode } from "./scenarios.ts";
import type { CompactionStrategyName } from "./strategy-runtime.ts";
import { getChartJsScriptTag } from "./chart-bundle.ts";

export interface ReportMetadata {
  title?: string;
  generatedAt: string;
  totalWallClockMs: number;
  model: string;
  scales: string[];
  modes: ScenarioMode[];
  strategies: CompactionStrategyName[];
}

export function generateReportHtml(
  results: AgenticRunResult[],
  cliArgs: Partial<RunnerCliArgs>,
  meta?: Partial<ReportMetadata>
): string {
  const generatedAt = meta?.generatedAt ?? new Date().toISOString();
  const model = meta?.model ?? cliArgs.model ?? "Unknown Model";
  const pricingModel = results[0]?.pricingModel ?? "gpt-5.6-sol";
  const scales = meta?.scales ?? cliArgs.scales ?? ["low"];
  const totalMs = meta?.totalWallClockMs ?? results.reduce((acc, r) => acc + r.wallClockMs, 0);
  const totalMin = (totalMs / 60_000).toFixed(1);

  // Strategy aggregate rollups
  const stratMap = new Map<
    CompactionStrategyName,
    {
      name: CompactionStrategyName;
      runs: AgenticRunResult[];
      totalBilled: number;
      totalCacheWrite: number;
      totalCompletedTurns: number;
      peakContext: number;
      finalContext: number;
      avgRubric: number | null;
      avgProbe: number | null;
      avgCacheHit: number;
      totalCost: number;
    }
  >();

  for (const r of results) {
    let s = stratMap.get(r.strategy);
    if (!s) {
      s = {
        name: r.strategy,
        runs: [],
        totalBilled: 0,
        totalCacheWrite: 0,
        totalCompletedTurns: 0,
        peakContext: 0,
        finalContext: 0,
        avgRubric: 0,
        avgProbe: 0,
        avgCacheHit: 0,
        totalCost: 0
      };
      stratMap.set(r.strategy, s);
    }
    s.runs.push(r);
    s.totalBilled += r.tokens.billedTokens;
    s.totalCacheWrite += r.tokens.totalCacheWrite;
    s.totalCompletedTurns += Math.max(1, r.completedTurns);
    if (r.tokens.peakContextTokens > s.peakContext) {
      s.peakContext = r.tokens.peakContextTokens;
    }
    s.finalContext = r.tokens.finalContextTokens;
    s.totalCost += r.cost;
  }

  for (const s of stratMap.values()) {
    const validRubrics = s.runs.filter((r) => r.rubricScore != null && !isNaN(r.rubricScore));
    s.avgRubric = validRubrics.length > 0
      ? validRubrics.reduce((acc, r) => acc + (r.rubricScore as number), 0) / validRubrics.length
      : null;
    const validProbes = s.runs.filter((r) => r.probeScore != null && !isNaN(r.probeScore));
    s.avgProbe = validProbes.length > 0
      ? validProbes.reduce((acc, r) => acc + (r.probeScore as number), 0) / validProbes.length
      : null;
    const n = s.runs.length || 1;
    s.avgCacheHit = s.runs.reduce((acc, r) => acc + r.tokens.cacheHitPct, 0) / n;
  }

  const stratList = Array.from(stratMap.values()).sort((a, b) => {
    const aProbe = a.avgProbe != null ? a.avgProbe : -1;
    const bProbe = b.avgProbe != null ? b.avgProbe : -1;
    if (Math.abs(bProbe - aProbe) > 1e-6) return bProbe - aProbe;
    const aRubric = a.avgRubric != null ? a.avgRubric : -1;
    const bRubric = b.avgRubric != null ? b.avgRubric : -1;
    if (Math.abs(bRubric - aRubric) > 1e-6) return bRubric - aRubric;
    return a.totalCost - b.totalCost;
  });

  const maxProbeScore = stratList.reduce((m, s) => Math.max(m, s.avgProbe ?? -1), -1);
  const tiedRecallWinners = maxProbeScore >= 0
    ? stratList.filter((s) => s.avgProbe != null && Math.abs(s.avgProbe - maxProbeScore) <= 1e-6)
    : [];
  const recallWinnerLabel = tiedRecallWinners.length > 1
    ? `${tiedRecallWinners.map((s) => s.name.toUpperCase()).join(" · ")} (TIE)`
    : (tiedRecallWinners[0]?.name ?? stratList[0]?.name ?? "origami").toUpperCase();

  const maxRubricScore = stratList.reduce((m, s) => Math.max(m, s.avgRubric ?? -1), -1);
  const tiedRubricWinners = maxRubricScore >= 0
    ? stratList.filter((s) => s.avgRubric != null && Math.abs(s.avgRubric - maxRubricScore) <= 1e-6)
    : [];
  const rubricWinnerLabel = tiedRubricWinners.length > 1
    ? `${tiedRubricWinners.map((s) => s.name.toUpperCase()).join(" · ")} (TIE)`
    : (tiedRubricWinners[0]?.name ?? stratList[0]?.name ?? "origami").toUpperCase();

  // Rank cache efficiency by lowest uncached/cache-write overhead per turn (preventing tool-loop prompt bloat from winning)
  const bestCache = stratList.reduce(
    (best, s) => {
      const sWritePerTurn = s.totalCacheWrite / Math.max(1, s.totalCompletedTurns);
      const bestWritePerTurn = best.totalCacheWrite / Math.max(1, best.totalCompletedTurns);
      return sWritePerTurn < bestWritePerTurn ? s : best;
    },
    stratList[0] || { name: "origami" as CompactionStrategyName, avgCacheHit: 0, totalCacheWrite: 0, totalCompletedTurns: 1 }
  );
  const minCostStrat = stratList.reduce(
    (min, s) => (s.totalCost < min.totalCost ? s : min),
    stratList[0] || { name: "origami" as CompactionStrategyName, totalCost: 0, totalBilled: 0 }
  );
  // Mode rollups
  const modesPresent = Array.from(new Set(results.map((r) => r.mode)));

  // Color constants
  const STRAT_COLORS: Record<string, string> = {
    origami: "#38bdf8",
    soft: "#a855f7",
    handover: "#fbbf24"
  };

  const MODE_COLORS: Record<string, string> = {
    programming: "#38bdf8",
    research: "#f43f5e",
    general: "#10b981",
    memory: "#a855f7"
  };

  const MODE_ICONS: Record<string, string> = {
    programming: "🎮",
    research: "🔬",
    general: "📐",
    memory: "🧠"
  };

  const MODE_TITLES: Record<string, string> = {
    programming: "Pac-Man Game Engine",
    research: "Vulnerability Audit & Exploit Hardening",
    general: "Linear Algebra Library & Docs",
    memory: "Deep Needle Retention & Precision Recall"
  };

  // Trajectory datasets for Chart.js
  const STRAT_DASH_ARRAYS: Record<string, number[]> = {
    origami: [],
    soft: [7, 4],
    handover: [3, 3]
  };

  let maxTurn = 10;
  for (const r of results) {
    if (r.completedTurns > maxTurn) maxTurn = r.completedTurns;
    for (const pt of r.trajectory) {
      if (pt.turnIndex > maxTurn) maxTurn = pt.turnIndex;
    }
  }

  const chartDatasets = results
    .filter((r) => r.trajectory && r.trajectory.length > 0)
    .map((r) => {
      const isOrigami = r.strategy === "origami";
      const color = STRAT_COLORS[r.strategy] || "#38bdf8";
      const dash = STRAT_DASH_ARRAYS[r.strategy] || [];
      const pts = r.trajectory.map((pt) => ({
        x: pt.turnIndex,
        y: pt.contextTokens,
        cacheHitRate: pt.cacheHitRate,
        isProbe: pt.isProbe,
        probePassed: pt.probeOutcome ? pt.probeOutcome.passed : undefined,
        maintenanceNote: pt.maintenanceNote
      }));
      return {
        label: `${r.strategy} (${r.mode})`,
        strategy: r.strategy,
        mode: r.mode,
        borderColor: color,
        borderDash: dash,
        borderWidth: isOrigami ? 3 : 2,
        pointStyle: pts.map((p) => (p.isProbe ? "triangle" : p.maintenanceNote ? "rectRot" : "circle")),
        pointRotation: pts.map((p) => (p.isProbe && !p.probePassed ? 180 : 0)),
        pointRadius: pts.map((p, idx) => (p.isProbe || p.maintenanceNote || idx === pts.length - 1 ? 5 : 0)),
        pointHoverRadius: 6,
        pointBackgroundColor: pts.map((p) => (p.isProbe ? (p.probePassed ? "#34d399" : "#f87171") : p.maintenanceNote ? "#fbbf24" : color)),
        pointBorderColor: "#070a12",
        pointBorderWidth: pts.map((p, idx) => (p.isProbe || p.maintenanceNote || idx === pts.length - 1 ? 1.5 : 0)),
        data: pts
      };
    });
  // Comparison Matrix rows
  const tableRowsHtml = results
    .map((r, i) => {
      const hasRubric = r.rubricScore != null && !isNaN(r.rubricScore);
      const rubricPct = hasRubric ? Math.round(r.rubricScore! * 100) : null;
      const rubricDisplay = hasRubric ? `${rubricPct}%` : "N/A";
      const rubricColor = !hasRubric
        ? "var(--muted)"
        : rubricPct! >= 80
        ? "var(--success)"
        : rubricPct! >= 50
        ? "var(--warning)"
        : "var(--danger)";

      const ext = r as unknown as Record<string, unknown>;
      const evalN = typeof ext.rubricEvaluatedCount === "number" ? ext.rubricEvaluatedCount : r.rubricPassedCount;
      const unavailN = typeof ext.rubricUnavailableCount === "number" ? ext.rubricUnavailableCount : 0;
      const errN = typeof ext.rubricErrorCount === "number" ? ext.rubricErrorCount : 0;
      let rubricSub = `(${r.rubricPassedCount}/${evalN} of ${r.rubricTotalCount}`;
      if (unavailN > 0) rubricSub += ` · ${unavailN} unavail`;
      if (errN > 0) rubricSub += ` · ${errN} err`;
      rubricSub += `)`;

      const hasProbe = r.probeScore != null && !isNaN(r.probeScore);
      const probePct = hasProbe ? Math.round(r.probeScore! * 100) : null;
      const probeDisplay = hasProbe ? `${probePct}%` : "N/A";
      const probeColor = !hasProbe
        ? "var(--muted)"
        : probePct! >= 80
        ? "var(--success)"
        : probePct! >= 50
        ? "var(--warning)"
        : "var(--danger)";
      const probeSub = `(${r.probePassedCount}/${r.probeTotalCount})`;
      const cachePct = Math.round(r.tokens.cacheHitPct);
      const topScore = Math.max(
        ...results.filter((x) => x.mode === r.mode && x.scale === r.scale).map((x) => (x.rubricScore ?? 0) + (x.probeScore ?? 0))
      );
      const rowScore = (r.rubricScore ?? 0) + (r.probeScore ?? 0);
      const isWinner = Math.abs(rowScore - topScore) <= 1e-6;
      const highlightCls = isWinner ? 'style="background: rgba(56, 189, 248, 0.05); font-weight: 600;"' : "";
      const compactions = r.strategyTelemetry?.compactionEvents ?? 0;

      return `
      <tr ${highlightCls}>
        <td><span class="strat-pill strat-${r.strategy}">${r.strategy}</span></td>
        <td><span class="mode-pill mode-${r.mode}">${MODE_ICONS[r.mode] || ""} ${r.mode.toUpperCase()}</span></td>
        <td style="color: var(--muted);">${r.scale} (${r.completedTurns}t)</td>
        <td class="mono font-semibold" style="color: ${rubricColor};">
          ${rubricDisplay} <span class="sub-score">${rubricSub}</span>
        </td>
        <td class="mono font-semibold" style="color: ${probeColor};">
          ${probeDisplay} <span class="sub-score">${probeSub}</span>
        </td>
        <td class="mono">${r.tokens.billedTokens.toLocaleString()} t</td>
        <td class="mono">${r.tokens.peakContextTokens.toLocaleString()} t</td>
        <td class="mono">${r.tokens.finalContextTokens.toLocaleString()} t</td>
        <td class="mono" style="color: ${cachePct >= 70 ? "var(--success)" : cachePct >= 40 ? "var(--warning)" : "var(--muted)"};">
          ${cachePct}%
        </td>
        <td class="mono">${r.tokens.totalCacheWrite.toLocaleString()} t</td>
        <td class="mono">${compactions}</td>
        <td class="mono">$${r.cost.toFixed(4)}</td>
        <td class="mono" style="color: var(--muted);">${(r.wallClockMs / 1000).toFixed(1)}s</td>
      </tr>`;
    })
    .join("\n");

  // Mode deep dive cards
  const modeCardsHtml = modesPresent
    .map((mode) => {
      const modeRuns = results.filter((r) => r.mode === mode);
      const modeColor = MODE_COLORS[mode] || "#38bdf8";
      const modeIcon = MODE_ICONS[mode] || "📌";
      const modeTitle = MODE_TITLES[mode] || mode;

      const origamiRun = modeRuns.find((r) => r.strategy === "origami");
      const handoverRun = modeRuns.find((r) => r.strategy === "handover");
      const softRun = modeRuns.find((r) => r.strategy === "soft");

      const bestScoreVal = Math.max(
        ...modeRuns.map((curr) => (curr.rubricScore ?? 0) + (curr.probeScore ?? 0))
      );
      const modeWinners = modeRuns
        .filter((curr) => Math.abs(((curr.rubricScore ?? 0) + (curr.probeScore ?? 0)) - bestScoreVal) <= 1e-6)
        .sort((a, b) => a.cost - b.cost);
      const bestRun = modeWinners[0];
      const bestModeLabel = modeWinners.length > 1
        ? modeWinners.map((w) => w.strategy).join(" / ")
        : (bestRun?.strategy || "origami");

      return `
      <div class="mode-card" style="border-top: 3px solid ${modeColor};">
        <div class="mode-card-header">
          <div class="mode-card-title">
            <span style="font-size: 20px;">${modeIcon}</span>
            <div>
              <h3>${mode.toUpperCase()}</h3>
              <div class="mode-card-sub">${modeTitle}</div>
            </div>
          </div>
          <span class="mode-pill mode-${mode}">${modeRuns.length} strategies</span>
        </div>

        <div class="mode-stats-row">
          <div class="mode-mini-stat">
            <div class="mini-label">Top Performer</div>
            <div class="mini-val" style="color: ${STRAT_COLORS[bestRun?.strategy || "origami"]};">${bestModeLabel}</div>
          </div>
          <div class="mode-mini-stat">
            <div class="mini-label">Origami Recall</div>
            <div class="mini-val" style="color: var(--success);">${origamiRun ? Math.round(origamiRun.probeScore * 100) + "%" : "-"}</div>
          </div>
          <div class="mode-mini-stat">
            <div class="mini-label">Handover Recall</div>
            <div class="mini-val" style="color: var(--danger);">${handoverRun ? Math.round(handoverRun.probeScore * 100) + "%" : "-"}</div>
          </div>
          <div class="mode-mini-stat">
            <div class="mini-label">Cache Hit (Origami)</div>
            <div class="mini-val" style="color: var(--primary);">${origamiRun ? Math.round(origamiRun.tokens.cacheHitPct) + "%" : "-"}</div>
          </div>
        </div>

        <div class="mode-summary-text">
          ${getModeEditorial(mode, origamiRun, handoverRun, softRun)}
        </div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Origami Agentic Context Benchmark Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
  ${getChartJsScriptTag()}
  <style>
    :root {
      --bg: #070a12;
      --card-bg: #0e1422;
      --card-border: #1a2336;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #a855f7;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --strat-origami: #38bdf8;
      --strat-soft: #a855f7;
      --strat-handover: #fbbf24;
      --mode-programming: #38bdf8;
      --mode-research: #f43f5e;
      --mode-general: #10b981;
      --mode-memory: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', system-ui, sans-serif;
      padding: 32px 24px 64px 24px;
      line-height: 1.5;
      max-width: 1280px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 28px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .subtitle {
      font-size: 13px;
      color: var(--muted);
      margin-top: 4px;
    }
    .status-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 6px 14px;
      border-radius: 9999px;
      background: rgba(52, 211, 153, 0.15);
      color: var(--success);
      border: 1px solid rgba(52, 211, 153, 0.4);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .status-badge::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
    }
    .meta-bar {
      display: flex;
      gap: 18px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--muted);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 10px 16px;
      border-radius: 8px;
      width: 100%;
      margin-bottom: 28px;
      flex-wrap: wrap;
    }
    .meta-item strong {
      color: var(--text);
    }

    /* Winner KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--primary);
    }
    .kpi-title {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 8px;
    }
    .kpi-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 6px;
    }

    /* Panels & Sections */
    .section-title {
      font-size: 16px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--muted);
      margin: 36px 0 16px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .panel-title {
      font-size: 16px;
      font-weight: 700;
    }

    /* Trajectory Chart */
    .chart-container {
      background: #090d16;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px 16px 8px 16px;
      position: relative;
    }
    #trajectory-chart {
      width: 100% !important;
      height: 340px !important;
      display: block;
    }
    .legend-row {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid #1a2234;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      transition: color 0.2s;
    }
    .legend-item:hover {
      color: var(--text);
    }
    .legend-line {
      width: 18px;
      height: 3px;
      border-radius: 2px;
    }

    /* Mode Grid */
    .mode-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .mode-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .mode-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    .mode-card-title {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .mode-card-title h3 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .mode-card-sub {
      font-size: 12px;
      color: var(--muted);
    }
    .mode-stats-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 16px;
      background: #090d16;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #1a2234;
    }
    .mode-mini-stat .mini-label {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      font-family: 'JetBrains Mono', monospace;
    }
    .mode-mini-stat .mini-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 15px;
      font-weight: 700;
      margin-top: 2px;
    }
    .mode-summary-text {
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.5;
    }

    /* Table */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid var(--card-border);
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      background: rgba(18, 24, 38, 0.4);
    }
    td.mono {
      font-family: 'JetBrains Mono', monospace;
    }
    .sub-score {
      font-size: 11px;
      color: var(--muted);
      font-weight: normal;
    }

    /* Badges */
    .strat-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 4px;
      display: inline-block;
    }
    .strat-origami { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .strat-soft { background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.4); }
    .strat-handover { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.4); }

    .mode-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .mode-programming { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .mode-research { background: rgba(244, 63, 94, 0.15); color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.3); }
    .mode-general { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .mode-memory { background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); }

    /* Editorial Analysis Box */
    .analysis-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
    }
    .analysis-item {
      background: #090d16;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 18px;
    }
    .analysis-item h4 {
      font-size: 14px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .analysis-item p {
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.6;
    }

    footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid var(--card-border);
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="brand">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" stroke="#38bdf8" stroke-width="2" fill="none" />
          <polyline points="2,8.5 12,14.5 22,8.5" stroke="#38bdf8" stroke-width="1.5" />
          <line x1="12" y1="14.5" x2="12" y2="22" stroke="#38bdf8" stroke-width="1.5" />
        </svg>
        <h1>Origami Agentic Context Benchmark</h1>
      </div>
      <div class="subtitle">Comprehensive Multi-Strategy Context Compaction Evaluation Report</div>
    </div>
    <div>
      <span class="status-badge">EVALUATION COMPLETE · ${results.length} RUNS</span>
    </div>
  </header>

  <div class="meta-bar">
    <div class="meta-item">Model: <strong>${model}</strong></div>
    <div class="meta-item">Pricing: <strong>${pricingModel}</strong> (modeled)</div>
    <div class="meta-item">Scales: <strong>${scales.join(", ")}</strong></div>
    <div class="meta-item">Total Elapsed Time: <strong>${totalMin} min</strong></div>
    <div class="meta-item">Generated: <strong>${new Date(generatedAt).toLocaleString()}</strong></div>
  </div>

  <!-- Top Winner Rollup KPIs -->
  <div class="kpi-grid">
    <div class="kpi-card" style="border-top-color: var(--primary);">
      <div class="kpi-title">Top Needle Recall Winner</div>
      <div class="kpi-val" style="color: var(--primary); font-size: ${recallWinnerLabel.length > 14 ? "18px" : "26px"};">${recallWinnerLabel}</div>
      <div class="kpi-sub">${maxProbeScore >= 0 ? Math.round(maxProbeScore * 100) + "% recall across all scenario needles" : "N/A (no probes)"}</div>
    </div>
    <div class="kpi-card" style="border-top-color: var(--success);">
      <div class="kpi-title">Top Task Rubric Winner</div>
      <div class="kpi-val" style="color: var(--success); font-size: ${rubricWinnerLabel.length > 14 ? "18px" : "26px"};">${rubricWinnerLabel}</div>
      <div class="kpi-sub">${maxRubricScore >= 0 ? Math.round(maxRubricScore * 100) + "% task specification completion" : "N/A (no evaluated criteria)"}</div>
    </div>
    <div class="kpi-card" style="border-top-color: var(--accent);">
      <div class="kpi-title">Cache Write Efficiency Winner</div>
      <div class="kpi-val" style="color: var(--accent);">${bestCache.name.toUpperCase()}</div>
      <div class="kpi-sub">${Math.round(bestCache.avgCacheHit)}% hit · ${(bestCache.totalCacheWrite / 1000).toFixed(1)}K cache write tokens</div>
    </div>
    <div class="kpi-card" style="border-top-color: var(--warning);">
      <div class="kpi-title">Lowest Modeled Cost</div>
      <div class="kpi-val" style="color: var(--warning);">${minCostStrat.name.toUpperCase()}</div>
      <div class="kpi-sub">$${minCostStrat.totalCost.toFixed(4)} (${(minCostStrat.totalBilled / 1000).toFixed(1)}K billed tokens)</div>
    </div>
  </div>

  <!-- Multi-Series Trajectory Graph Panel -->
  <div class="section-title">
    <span>Multi-Series Context Trajectory Across Horizon</span>
    <span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted);">${maxTurn} total turns</span>
  </div>
  <div class="panel">
    <div class="panel-header">
      <div>
        <div class="panel-title">Context Window Mass by Strategy</div>
        <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">Dynamic context growth vs compaction stabilization across all evaluated modes</div>
      </div>
    </div>
    <div class="chart-container">
      <div style="position: relative; width: 100%; height: 340px;">
        <canvas id="trajectory-chart"></canvas>
      </div>
      <div class="legend-row">
        <div class="legend-item" data-strat="origami" onclick="filterSeries('origami')"><span class="legend-line" style="background: var(--strat-origami); height: 3px;"></span> <strong>Origami</strong> (Pagoda Folding + JIT Hydration)</div>
        <div class="legend-item" data-strat="soft" onclick="filterSeries('soft')"><span class="legend-line" style="background: var(--strat-soft); border-top: 2px dashed var(--strat-soft);"></span> <strong>Soft Compaction</strong> (Hierarchical Summaries)</div>
        <div class="legend-item" data-strat="handover" onclick="filterSeries('handover')"><span class="legend-line" style="background: var(--strat-handover); border-top: 2px dotted var(--strat-handover);"></span> <strong>Handover</strong> (Sub-agent Compaction)</div>
      </div>
    </div>
  </div>

  <!-- Mode-by-Mode Deep Dive Cards -->
  <div class="section-title">
    <span>Scenario Mode Deep Dives</span>
    <span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted);">${modesPresent.length} modes tested</span>
  </div>
  <div class="mode-grid">
    ${modeCardsHtml}
  </div>

  <!-- Comprehensive Comparison Table -->
  <div class="section-title">
    <span>Comprehensive Benchmark Matrix</span>
    <span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted);">${results.length} runs</span>
  </div>
  <div class="panel" style="padding: 0; overflow-x: auto;">
    <table>
      <thead>
        <tr>
          <th>Strategy</th>
          <th>Mode</th>
          <th>Scale</th>
          <th>Task Rubric</th>
          <th>Probe Recall</th>
          <th>Billed Tokens</th>
          <th>Peak Ctx</th>
          <th>Final Ctx</th>
          <th>Cache Hit</th>
          <th>Cache Write</th>
          <th>Compactions</th>
          <th>Modeled Cost</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
      </tbody>
    </table>
  </div>

  <!-- Strategic Architectural Findings & Analysis -->
  <div class="section-title">
    <span>Strategic Architectural Analysis</span>
    <span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted);">Mechanisms & Trade-offs</span>
  </div>
  <div class="panel">
    <div class="analysis-grid">
      ${buildStrategyAnalysisHtml(results)}
    </div>
  </div>

  <footer>
    Origami Agentic Context Benchmark · Autonomous Hierarchical Context Compression & Amortization Engine
  </footer>

  <script>
    const chartDatasets = ${JSON.stringify(chartDatasets)};
    let activeFilter = null;
    let trajectoryChart = null;

    if (typeof Chart !== 'undefined' && document.getElementById('trajectory-chart')) {
      const ctx = document.getElementById('trajectory-chart').getContext('2d');
      trajectoryChart = new Chart(ctx, {
        type: 'line',
        data: {
          datasets: chartDatasets.map(function (ds) {
            return Object.assign({}, ds, {
              baseColor: ds.borderColor,
              baseWidth: ds.borderWidth
            });
          })
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(9, 13, 22, 0.96)',
              borderColor: '#1e293b',
              borderWidth: 1,
              titleFont: { family: 'JetBrains Mono', size: 11, weight: 'bold' },
              bodyFont: { family: 'JetBrains Mono', size: 11 },
              padding: 10,
              cornerRadius: 8,
              itemSort: function (a, b) { return b.parsed.y - a.parsed.y; },
              callbacks: {
                title: function (items) {
                  return items && items.length > 0 ? 'Turn ' + items[0].parsed.x : '';
                },
                label: function (item) {
                  var ds = item.dataset;
                  var raw = item.raw || {};
                  var val = item.parsed.y.toLocaleString() + ' tokens';
                  var extra = '';
                  if (raw.isProbe) {
                    extra = raw.probePassed ? ' [Needle Recall: PASS \u2713]' : ' [Needle Recall: FAIL \u2717]';
                  } else if (raw.maintenanceNote) {
                    extra = ' [' + raw.maintenanceNote + ']';
                  }
                  return (ds.label || '') + ': ' + val + extra;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              grid: { color: '#1e293b' },
              ticks: {
                color: '#64748b',
                font: { family: 'JetBrains Mono', size: 11 },
                callback: function (val) { return val + 't'; }
              },
              title: {
                display: true,
                text: 'turns →',
                align: 'end',
                color: '#475569',
                font: { family: 'JetBrains Mono', size: 10 }
              }
            },
            y: {
              type: 'linear',
              grid: { color: '#1e293b' },
              ticks: {
                color: '#64748b',
                font: { family: 'JetBrains Mono', size: 11 },
                callback: function (val) {
                  if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
                  if (val >= 1000) return Math.round(val / 1000) + 'K';
                  return val;
                }
              }
            }
          }
        }
      });
    }

    function filterSeries(strat) {
      if (!trajectoryChart) return;
      if (activeFilter === strat) {
        activeFilter = null;
        trajectoryChart.data.datasets.forEach(function (ds) {
          ds.borderColor = ds.baseColor;
          ds.borderWidth = ds.baseWidth;
          ds.hidden = false;
        });
        document.querySelectorAll('.legend-item').forEach(function (el) { el.style.opacity = '1'; });
      } else {
        activeFilter = strat;
        trajectoryChart.data.datasets.forEach(function (ds) {
          if (ds.strategy === strat) {
            ds.borderColor = ds.baseColor;
            ds.borderWidth = 3.5;
            ds.hidden = false;
          } else {
            ds.borderColor = 'rgba(100, 116, 139, 0.2)';
            ds.borderWidth = 1;
            ds.hidden = false;
          }
        });
        document.querySelectorAll('.legend-item').forEach(function (el) {
          el.style.opacity = (el.getAttribute('data-strat') === strat) ? '1' : '0.35';
        });
      }
      trajectoryChart.update();
    }
  </script>
</body>
</html>`;
}

function buildStrategyAnalysisHtml(results: AgenticRunResult[]): string {
  const descriptions: Record<CompactionStrategyName, string> = {
    origami: "Maintains folded summary blocks in a monotonic prefix, pins head/user directives in bounded ledgers, indexes archived messages in SQLite FTS5 (`fold_search` / `fold_recall`), and injects JIT hydration only when folded symbols match active work.",
    soft: "Rewrites older history into a periodic summary block. Reclaims substantial context tokens per cycle, at the cost of invalidating the KV cache prefix on each rewrite and condensing fine-grained historical details.",
    handover: "Resets conversation state into a structured handoff document. Keeps active context small when triggered sparingly, but permanently drops earlier details not copied into the handoff note."
  };

  const seen = Array.from(new Set(results.map((r) => r.strategy)));
  return seen
    .map((strat) => {
      const runs = results.filter((r) => r.strategy === strat);
      const avgProbe = runs.reduce((s, r) => s + r.probeScore, 0) / Math.max(1, runs.length);
      const totalCompactions = runs.reduce((s, r) => s + (r.strategyTelemetry?.compactionEvents ?? 0), 0);
      const totalCost = runs.reduce((s, r) => s + r.cost, 0);
      const totalWrite = runs.reduce((s, r) => s + r.tokens.totalCacheWrite, 0);
      const hydrations = runs.reduce((s, r) => {
        const d = r.strategyTelemetry?.details ?? {};
        return s + (typeof d.hydrationCount === "number" ? d.hydrationCount : d.hydrationInjected ? 1 : 0);
      }, 0);
      const extra = strat === "origami"
        ? ` (${hydrations} JIT hydration event${hydrations === 1 ? "" : "s"})`
        : "";
      const cssVar = `var(--strat-${strat})`;
      return `
      <div class="analysis-item" style="border-left: 3px solid ${cssVar};">
        <h4><span class="strat-pill strat-${strat}">${strat}</span> Measured Telemetry</h4>
        <p>${descriptions[strat]}<br><strong style="color: var(--text);">Observed:</strong> ${Math.round(avgProbe * 100)}% probe recall · ${totalCompactions} compaction(s)${extra} · ${(totalWrite / 1000).toFixed(1)}K cache writes · $${totalCost.toFixed(4)} modeled cost.</p>
      </div>`;
    })
    .join("\n");
}

function getModeEditorial(
  mode: ScenarioMode,
  origami?: AgenticRunResult,
  handover?: AgenticRunResult,
  _soft?: AgenticRunResult
): string {
  switch (mode) {
    case "programming": {
      const origamiText = origami && origami.rubricScore != null ? Math.round(origami.rubricScore * 100) + "%" : (origami ? "N/A" : "n/a");
      return `Progressive Pac-Man arcade engine & modular stage/subsystem implementation. <strong>Origami</strong> recorded ${origamiText} evaluated rubric completion with ${origami ? Math.round(origami.probeScore * 100) + "%" : "n/a"} probe recall.`;
    }
    case "research":
      return `Security audit of planted vulnerabilities followed by progressive CWE defense-in-depth modules, adversarial regression suites, and threat models.`;
    case "general":
      return `Production TypeScript numerical, linear-algebra, and data-structures library with progressive modules, TypedArray adapters, unit tests, and RFCs.`;
    case "memory": {
      const origamiProbeText = origami && origami.probeScore != null ? Math.round(origami.probeScore * 100) + "%" : "n/a";
      const handoverProbeText = handover && handover.probeScore != null ? Math.round(handover.probeScore * 100) + "%" : "n/a";
      const d = origami?.strategyTelemetry?.details ?? {};
      const hydrations = typeof d.hydrationCount === "number" ? d.hydrationCount : d.hydrationInjected ? 1 : 0;
      const mechanism = hydrations > 0
        ? `pinned ledger + ${hydrations} JIT hydration(s) & archive search`
        : `pinned ledger & SQLite FTS archive`;
      return `Plants session-only needles (never written to disk) followed by unique platform engineering tasks. <strong>Origami</strong> scored ${origamiProbeText} recall (${mechanism}); handover scored ${handoverProbeText}.`;
    }
    default:
      return `Multi-disciplinary agentic challenge evaluating long-horizon consistency and token economics.`;
  }
}
