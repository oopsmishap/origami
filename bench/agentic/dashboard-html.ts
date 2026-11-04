/**
 * Live Web Dashboard for the Origami Agentic Context Benchmark.
 *
 * Design contract (consumed events from runner.ts DashboardBroadcaster):
 * - init          full snapshot: { status, model, tracks, series, feed, completed }
 * - state_update  { status?, model?, ... }
 * - run_start     { runId, scale, mode, strategy, totalTurns }
 * - turn_start    { runId, mode, strategy, turn, totalTurns, isProbe, promptSnippet }
 * - tool_call     { runId, mode, strategy, turn, tool, outputSnippet }
 * - turn_done     { runId, mode, strategy, scale, totalTurns, metric }
 * - maintenance   { runId, mode, strategy, note }
 * - feed          { ts, kind, mode, strategy, text }
 * - run_complete  { runId, runResult }
 *
 * Visual language:
 * - MODE owns color: programming=blue, research=rose, general=emerald, memory=violet.
 * - STRATEGY owns stroke dash: origami=solid(glow), soft=dashed, handover=dotted,
 *   shake=dash-dot, sliding-window=sparse dot.
 * - Track cards grouped into per-mode swimlanes with live mode-level KPIs.
 * - Live states: THINKING (model in flight), TOOL (executing), RUNNING, DONE.
 */

import { getChartJsScriptTag } from "./chart-bundle.ts";

export function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Origami Agentic Compaction Benchmark</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
  ${getChartJsScriptTag()}
  <style>
    :root {
      --bg: #070a12;
      --panel: #0e1422;
      --panel-deep: #090d16;
      --border: #1a2336;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --dim: #64748b;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --origami: #38bdf8;
      --mode-programming: #38bdf8;
      --mode-research: #fb7185;
      --mode-general: #34d399;
      --mode-memory: #c084fc;
      --strat-origami: #38bdf8;
      --strat-soft: #a855f7;
      --strat-handover: #fbbf24;
      --strat-shake: #34d399;
      --strat-sliding: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', system-ui, sans-serif;
      padding: 20px 22px 40px;
      line-height: 1.5;
      max-width: 1560px;
      margin: 0 auto;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }

    /* ---------- Header ---------- */
    header {
      display: flex; justify-content: space-between; align-items: center;
      gap: 14px; flex-wrap: wrap;
      padding-bottom: 14px; margin-bottom: 18px;
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand h1 { font-size: 19px; font-weight: 700; letter-spacing: -0.4px; }
    .brand .sub { font-size: 11px; color: var(--muted); }
    .header-meta { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--muted); text-align: right; }
    .conn-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); margin-right: 6px; }
    .conn-dot.live { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-pill {
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600;
      padding: 5px 12px; border-radius: 999px;
      background: rgba(56,189,248,.12); color: var(--origami);
      border: 1px solid rgba(56,189,248,.35);
      display: inline-flex; align-items: center; gap: 7px;
    }
    .status-pill.running::before {
      content: ""; width: 7px; height: 7px; border-radius: 50%;
      background: var(--success); box-shadow: 0 0 8px var(--success);
      animation: pulse 1.4s infinite;
    }
    @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.8); } }

    /* ---------- Aggregate KPI strip ---------- */
    .kpi-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px; margin-bottom: 18px;
    }
    .kpi-card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 11px; padding: 13px 15px;
    }
    .kpi-title { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .7px; margin-bottom: 4px; }
    .kpi-val { font-family: 'JetBrains Mono', monospace; font-size: 21px; font-weight: 700; }
    .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* ---------- Mode tabs ---------- */
    .tab-bar {
      display: flex; gap: 8px; flex-wrap: wrap;
      margin-bottom: 16px; padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .tab-btn {
      background: transparent; border: 1px solid var(--border);
      color: var(--muted); font-family: 'Space Grotesk', sans-serif;
      font-size: 12.5px; font-weight: 600;
      padding: 6px 13px; border-radius: 8px; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px;
      transition: all .15s;
    }
    .tab-btn:hover { color: var(--text); background: rgba(30,41,59,.5); }
    .tab-btn .tab-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
    .tab-btn .tab-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      background: rgba(148,163,184,.15); padding: 1px 6px; border-radius: 99px;
    }
    .tab-btn.active[data-mode="all"] { color: var(--text); background: rgba(148,163,184,.12); border-color: var(--dim); }
    .tab-btn.active[data-mode="programming"] { color: var(--mode-programming); background: rgba(56,189,248,.12); border-color: rgba(56,189,248,.45); }
    .tab-btn.active[data-mode="research"] { color: var(--mode-research); background: rgba(251,113,133,.12); border-color: rgba(251,113,133,.45); }
    .tab-btn.active[data-mode="general"] { color: var(--mode-general); background: rgba(52,211,153,.12); border-color: rgba(52,211,153,.45); }
    .tab-btn.active[data-mode="memory"] { color: var(--mode-memory); background: rgba(192,132,252,.12); border-color: rgba(192,132,252,.45); }

    /* ---------- Mode swimlanes ---------- */
    .mode-section { margin-bottom: 20px; }
    .mode-section-header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px; margin-bottom: 10px;
      background: var(--panel); border: 1px solid var(--border);
      border-left-width: 4px; border-radius: 9px;
    }
    .mode-section-header .mode-icon { font-size: 15px; }
    .mode-section-header h2 { font-size: 13.5px; font-weight: 700; letter-spacing: .3px; }
    .mode-section-header .mode-kpis {
      margin-left: auto; display: flex; gap: 14px;
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--muted);
    }
    .mode-section-header .mode-kpis strong { color: var(--text); }
    .tracks-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }

    /* ---------- Track cards ---------- */
    .track-card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 11px; padding: 13px 14px;
      border-left-width: 4px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .track-card[data-status="thinking"] { box-shadow: 0 0 0 1px rgba(251,191,36,.25), 0 0 18px rgba(251,191,36,.06); }
    .track-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .badge-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .strat-pill {
      font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
      padding: 2px 8px; border-radius: 4px; white-space: nowrap;
    }
    .strat-origami { background: rgba(56,189,248,.15); color: #38bdf8; border: 1px solid rgba(56,189,248,.4); }
    .strat-soft { background: rgba(168,85,247,.15); color: #a855f7; border: 1px solid rgba(168,85,247,.4); }
    .strat-handover { background: rgba(251,191,36,.15); color: #fbbf24; border: 1px solid rgba(251,191,36,.4); }
    .strat-shake { background: rgba(52,211,153,.15); color: #34d399; border: 1px solid rgba(52,211,153,.4); }
    .strat-sliding-window { background: rgba(148,163,184,.15); color: #94a3b8; border: 1px solid rgba(148,163,184,.4); }
    .state-chip {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700;
      letter-spacing: .5px; padding: 2px 8px; border-radius: 4px; white-space: nowrap;
    }
    .state-initializing { background: rgba(148,163,184,.12); color: var(--muted); }
    .state-thinking { background: rgba(251,191,36,.15); color: var(--warning); animation: pulse 1.2s infinite; }
    .state-tool { background: rgba(56,189,248,.15); color: var(--origami); animation: pulse 1.2s infinite; }
    .state-running { background: rgba(56,189,248,.1); color: var(--origami); }
    .state-completed { background: rgba(52,211,153,.15); color: var(--success); }
    .state-error { background: rgba(248,113,113,.15); color: var(--danger); }
    .track-meta {
      display: flex; justify-content: space-between;
      font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
    }
    .progress-bar-wrap {
      background: var(--panel-deep); border: 1px solid var(--border);
      border-radius: 99px; height: 6px; overflow: hidden;
    }
    .progress-bar-fill { height: 100%; border-radius: 99px; transition: width .35s ease; }
    .track-metrics {
      display: flex; gap: 13px; flex-wrap: wrap;
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--muted);
    }
    .track-metrics strong { color: var(--text); font-weight: 600; }
    .track-prompt {
      font-size: 11px; color: #cbd5e1; line-height: 1.45;
      background: var(--panel-deep); border: 1px solid var(--border);
      border-radius: 7px; padding: 7px 9px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      min-height: 40px;
    }
    .track-prompt .plabel {
      font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--dim);
      text-transform: uppercase; letter-spacing: .6px; display: block; margin-bottom: 2px;
    }
    .track-action {
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ---------- Main grid: chart + feed ---------- */
    .grid-main { display: grid; grid-template-columns: 1.9fr 1fr; gap: 16px; margin-top: 6px; }
    @media (max-width: 1100px) { .grid-main { grid-template-columns: 1fr; } }
    .panel {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px 18px;
    }
    .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* metric toggle */
    .seg-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .seg-toggle button {
      background: transparent; border: none; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 600;
      padding: 5px 11px; cursor: pointer;
    }
    .seg-toggle button.active { background: rgba(56,189,248,.14); color: var(--origami); }

    .chart-container { position: relative; background: var(--panel-deep); border: 1px solid var(--border); border-radius: 9px; padding: 10px; height: 350px; }
    #trajectory-chart { width: 100% !important; height: 100% !important; display: block; }

    .legend-block { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
    .legend-row { display: flex; flex-wrap: wrap; gap: 12px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; margin-bottom: 6px; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; user-select: none; transition: color .15s, opacity .15s; }
    .legend-item:hover { color: var(--text); }
    .legend-item.isolated { color: var(--text); }
    .legend-item.dimmed { opacity: .35; }
    .legend-swatch { width: 16px; height: 0; border-top-width: 3px; border-top-style: solid; border-radius: 2px; }

    /* ---------- Matrix table ---------- */
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .6px; }
    td.mono { font-family: 'JetBrains Mono', monospace; }

    /* ---------- Live feed ---------- */
    .feed-filters { display: flex; gap: 6px; }
    .feed-filters button {
      background: transparent; border: 1px solid var(--border); color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
      padding: 3px 9px; border-radius: 99px; cursor: pointer;
    }
    .feed-filters button.active { color: var(--origami); border-color: rgba(56,189,248,.45); background: rgba(56,189,248,.1); }
    .feed {
      height: 560px; overflow-y: auto;
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      background: var(--panel-deep); border: 1px solid var(--border); border-radius: 9px;
      padding: 10px; display: flex; flex-direction: column; gap: 7px;
    }
    .feed-item {
      padding: 7px 9px; border-radius: 7px;
      background: rgba(18,24,38,.8); border: 1px solid var(--border);
      border-left: 3px solid var(--dim); line-height: 1.45;
    }
    .feed-item.k-probe-pass { border-left-color: var(--success); }
    .feed-item.k-probe-fail { border-left-color: var(--danger); }
    .feed-item.k-maintenance { border-left-color: var(--warning); }
    .feed-item.k-tool { border-left-color: var(--origami); }
    .feed-item.k-complete { border-left-color: var(--success); background: rgba(52,211,153,.06); }
    .feed-item.k-start { border-left-color: var(--origami); }
    .feed-item.k-error { border-left-color: var(--danger); background: rgba(248,113,113,.06); }
    .feed-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 9.5px; color: var(--muted); margin-bottom: 3px; }
    .feed-tags { display: inline-flex; gap: 5px; align-items: center; }
    .feed-mode-tag { font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
    .feed-text { word-break: break-word; color: #cbd5e1; }

    .empty-note { color: var(--dim); text-align: center; padding: 18px; font-size: 12px; border: 1px dashed var(--border); border-radius: 10px; }

    /* ---------- View Navigation ---------- */
    .view-nav { display: inline-flex; align-items: center; gap: 8px; margin-left: 18px; }
    .view-nav-btn {
      background: var(--panel); border: 1px solid var(--border);
      color: var(--muted); font-family: 'Space Grotesk', sans-serif;
      font-size: 12.5px; font-weight: 600; padding: 5px 12px;
      border-radius: 8px; cursor: pointer; display: inline-flex;
      align-items: center; gap: 7px; transition: all .15s ease;
    }
    .view-nav-btn:hover { color: var(--text); border-color: var(--dim); }
    .view-nav-btn.active {
      background: rgba(56,189,248,.12); color: var(--origami);
      border-color: rgba(56,189,248,.45);
    }
    .chat-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      background: rgba(56,189,248,.2); color: var(--origami);
      padding: 1px 6px; border-radius: 99px;
    }
    .track-chat-btn {
      background: transparent; border: 1px solid var(--border);
      color: var(--origami); font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600; padding: 2px 7px;
      border-radius: 4px; cursor: pointer; margin-top: 4px;
      display: inline-flex; align-items: center; gap: 5px;
      align-self: flex-start; transition: all .15s;
    }
    .track-chat-btn:hover {
      background: rgba(56,189,248,.12); border-color: rgba(56,189,248,.4);
    }

    /* ---------- Chat View Layout ---------- */
    .chat-layout {
      display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 16px;
      height: calc(100vh - 120px); min-height: 600px; margin-top: 4px;
    }
    @media (max-width: 900px) {
      .chat-layout { grid-template-columns: 1fr; height: auto; }
    }
    .chat-sidebar {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; display: flex; flex-direction: column;
      overflow: hidden; height: 100%; min-height: 0; min-width: 0;
    }
    .chat-sidebar-header {
      padding: 14px 16px; border-bottom: 1px solid var(--border);
      background: var(--panel-deep);
    }
    .chat-sidebar-title {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .6px; color: var(--muted); margin-bottom: 10px;
    }
    .chat-search-input {
      width: 100%; background: var(--panel); border: 1px solid var(--border);
      border-radius: 7px; padding: 7px 10px; font-family: 'JetBrains Mono', monospace;
      font-size: 11px; color: var(--text); outline: none;
    }
    .chat-search-input:focus { border-color: var(--origami); }
    .chat-tracks-list {
      flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;
      overscroll-behavior: contain;
    }
    .chat-track-item {
      background: var(--panel-deep); border: 1px solid var(--border);
      border-left: 4px solid var(--dim); border-radius: 8px;
      padding: 10px 12px; cursor: pointer; transition: all .15s;
      display: flex; flex-direction: column; gap: 5px;
    }
    .chat-track-item:hover {
      background: rgba(30,41,59,.4); border-color: rgba(148,163,184,.3);
    }
    .chat-track-item.active {
      background: rgba(56,189,248,.08); border-color: rgba(56,189,248,.4);
      box-shadow: 0 0 14px rgba(56,189,248,.08);
    }
    .chat-track-row1 {
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
    }
    .chat-track-row2 {
      display: flex; justify-content: space-between; align-items: center;
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--muted);
    }

    /* ---------- Chat Main Panel ---------- */
    .chat-main {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; display: flex; flex-direction: column;
      overflow: hidden; height: 100%; min-height: 0; min-width: 0;
    }
    .chat-main-header {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      background: var(--panel-deep); display: flex;
      justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;
      flex-shrink: 0;
    }
    .chat-track-info { min-width: 0; }
    .chat-track-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .chat-track-meta { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); margin-top: 3px; }
    .chat-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .chat-toggle-label {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11.5px; color: var(--muted); cursor: pointer;
      font-family: 'Space Grotesk', sans-serif;
    }
    .chat-toggle-label input { accent-color: var(--origami); cursor: pointer; }
    .chat-btn {
      background: var(--panel); border: 1px solid var(--border);
      color: var(--muted); font-family: 'JetBrains Mono', monospace;
      font-size: 11px; font-weight: 600; padding: 5px 10px; border-radius: 6px;
      cursor: pointer; transition: all .15s;
    }
    .chat-btn:hover { color: var(--text); border-color: var(--dim); }

    .chat-live-banner {
      background: rgba(251,191,36,.1); border-bottom: 1px solid rgba(251,191,36,.25);
      padding: 7px 16px; font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--warning); display: flex; align-items: center; gap: 8px;
    }
    .live-pulse {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--warning); box-shadow: 0 0 8px var(--warning);
      animation: pulse 1.2s infinite;
    }

    .chat-transcript-body {
      flex: 1; min-height: 0; min-width: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 16px;
      overscroll-behavior: contain;
    }

    /* Clean custom scrollbars */
    .chat-transcript-body::-webkit-scrollbar,
    .chat-tracks-list::-webkit-scrollbar,
    .chat-thinking-content::-webkit-scrollbar,
    .chat-tool-output::-webkit-scrollbar {
      width: 8px; height: 8px;
    }
    .chat-transcript-body::-webkit-scrollbar-track,
    .chat-tracks-list::-webkit-scrollbar-track,
    .chat-thinking-content::-webkit-scrollbar-track,
    .chat-tool-output::-webkit-scrollbar-track {
      background: rgba(15,23,42,.6);
    }
    .chat-transcript-body::-webkit-scrollbar-thumb,
    .chat-tracks-list::-webkit-scrollbar-thumb,
    .chat-thinking-content::-webkit-scrollbar-thumb,
    .chat-tool-output::-webkit-scrollbar-thumb {
      background: rgba(148,163,184,.3); border-radius: 4px;
    }
    .chat-transcript-body::-webkit-scrollbar-thumb:hover,
    .chat-tracks-list::-webkit-scrollbar-thumb:hover,
    .chat-thinking-content::-webkit-scrollbar-thumb:hover,
    .chat-tool-output::-webkit-scrollbar-thumb:hover {
      background: rgba(148,163,184,.55);
    }

    /* Turn card */
    .turn-card {
      background: var(--panel-deep); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden; display: flex; flex-direction: column;
      min-width: 0; width: 100%; box-sizing: border-box; flex-shrink: 0;
    }
    .turn-card-header {
      padding: 9px 14px; background: rgba(14,20,34,.9);
      border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center;
      gap: 10px; flex-wrap: wrap; font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
    }
    .turn-card-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .turn-number { font-weight: 700; color: var(--origami); }
    .turn-chips { display: flex; gap: 8px; font-size: 10px; color: var(--muted); flex-wrap: wrap; }
    .turn-chips span strong { color: var(--text); }

    .turn-card-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }

    /* Bubble styles */
    .bubble-user {
      background: rgba(30,41,59,.45); border: 1px solid var(--border);
      border-left: 3px solid var(--muted); border-radius: 8px; padding: 10px 12px;
      font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    .bubble-user .bubble-label {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700;
      color: var(--muted); text-transform: uppercase; letter-spacing: .6px; margin-bottom: 4px;
    }

    .bubble-assistant {
      display: flex; flex-direction: column; gap: 10px;
    }

    /* Thinking box */
    .chat-thinking {
      background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.22);
      border-radius: 8px; overflow: hidden;
    }
    .chat-thinking summary {
      padding: 8px 12px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px;
      font-weight: 600; color: var(--warning); cursor: pointer; user-select: none;
      outline: none; background: rgba(251,191,36,.04); display: flex; align-items: center; justify-content: space-between;
    }
    .chat-thinking summary:hover { background: rgba(251,191,36,.1); }
    .chat-thinking-content {
      padding: 10px 14px; font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: #fde68a; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      border-top: 1px dashed rgba(251,191,36,.2); max-height: 380px; overflow-y: auto;
      overscroll-behavior: contain;
    }

    /* Tool call item */
    .chat-tool-block {
      background: rgba(14,20,34,.9); border: 1px solid var(--border);
      border-left: 3px solid var(--origami); border-radius: 8px; overflow: hidden;
    }
    .chat-tool-header {
      padding: 7px 11px; background: rgba(56,189,248,.08);
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600;
      color: var(--origami); display: flex; align-items: center; gap: 7px;
    }
    .chat-tool-args {
      padding: 8px 12px; font-family: 'JetBrains Mono', monospace; font-size: 11px;
      background: var(--panel-deep); color: #93c5fd; overflow-x: auto;
      white-space: pre-wrap; word-break: break-all;
    }
    .chat-tool-output {
      padding: 8px 12px; font-family: 'JetBrains Mono', monospace; font-size: 11px;
      background: rgba(9,13,22,.9); color: #cbd5e1; border-top: 1px solid var(--border);
      max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    }
    .chat-tool-output-label {
      font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 2px;
    }

    .chat-assistant-reply {
      background: rgba(15,23,42,.6); border: 1px solid var(--border);
      border-left: 3px solid var(--success); border-radius: 8px; padding: 12px 14px;
      font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
      color: #f1f5f9;
    }
    .chat-assistant-reply .bubble-label {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700;
      color: var(--success); text-transform: uppercase; letter-spacing: .6px; margin-bottom: 4px;
    }

    /* Badges */
    .probe-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700;
      padding: 2px 7px; border-radius: 4px;
    }
    .probe-badge.pass { background: rgba(52,211,153,.15); color: var(--success); border: 1px solid rgba(52,211,153,.35); }
    .probe-badge.fail { background: rgba(248,113,113,.15); color: var(--danger); border: 1px solid rgba(248,113,113,.35); }
    .maint-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700;
      background: rgba(251,191,36,.15); color: var(--warning); border: 1px solid rgba(251,191,36,.35);
      padding: 2px 7px; border-radius: 4px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" stroke="#38bdf8" stroke-width="2" fill="none" />
        <polyline points="2,8.5 12,14.5 22,8.5" stroke="#38bdf8" stroke-width="1.5" />
        <line x1="12" y1="14.5" x2="12" y2="22" stroke="#38bdf8" stroke-width="1.5" />
      </svg>
      <div>
        <h1>Origami Agentic Compaction Benchmark</h1>
        <div class="sub">Live multi-strategy context economics telemetry</div>
      </div>
      <span class="status-pill running" id="status-pill">CONNECTING</span>
    </div>
    <nav class="view-nav" id="view-nav">
      <button class="view-nav-btn active" data-view="telemetry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
        Telemetry & Matrix
      </button>
      <button class="view-nav-btn" data-view="chat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Live Chat Logs
        <span class="chat-badge" id="chat-tracks-count">0</span>
      </button>
    </nav>
    <div class="header-meta">
      <div><span class="conn-dot" id="conn-dot"></span><span id="conn-label">connecting</span> · port ${port}</div>
      <div id="header-meta">model: —</div>
    </div>
  </header>
  <div id="view-telemetry">

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-title">Active Parallel Tracks</div>
      <div class="kpi-val" id="agg-tracks" style="color: var(--origami);">0</div>
      <div class="kpi-sub" id="agg-tracks-sub">concurrent sandboxes</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Billed Prompt Tokens</div>
      <div class="kpi-val" id="agg-tokens">0</div>
      <div class="kpi-sub" id="agg-tokens-sub">across all streams</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Aggregate Cache Hit Rate</div>
      <div class="kpi-val" id="agg-cache" style="color: var(--success);">0.0%</div>
      <div class="kpi-sub">prefix amortization efficiency</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Modeled Cost</div>
      <div class="kpi-val" id="agg-cost" style="color: var(--warning);">$0.0000</div>
      <div class="kpi-sub" id="agg-cost-sub">GPT-5.6 Sol rates · completed runs</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Cache Write Tokens</div>
      <div class="kpi-val" id="agg-cache-write" style="color: var(--accent);">0</div>
      <div class="kpi-sub">modeled cache construction</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Needle Probe Recall</div>
      <div class="kpi-val" id="agg-recall" style="color: var(--mode-memory);">—</div>
      <div class="kpi-sub" id="agg-recall-sub">0 / 0 probes passed</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Compaction Events</div>
      <div class="kpi-val" id="agg-maint" style="color: var(--warning);">0</div>
      <div class="kpi-sub">folds · summarizes · prunes</div>
    </div>
  </div>

  <div class="tab-bar" id="tab-bar">
    <button class="tab-btn active" data-mode="all"><span class="tab-dot"></span>All Modes <span class="tab-count" data-count="all">0</span></button>
    <button class="tab-btn" data-mode="programming"><span class="tab-dot" style="background: var(--mode-programming);"></span>Programming <span class="tab-count" data-count="programming">0</span></button>
    <button class="tab-btn" data-mode="research"><span class="tab-dot" style="background: var(--mode-research);"></span>Research <span class="tab-count" data-count="research">0</span></button>
    <button class="tab-btn" data-mode="general"><span class="tab-dot" style="background: var(--mode-general);"></span>General <span class="tab-count" data-count="general">0</span></button>
    <button class="tab-btn" data-mode="memory"><span class="tab-dot" style="background: var(--mode-memory);"></span>Memory <span class="tab-count" data-count="memory">0</span></button>
  </div>

  <div id="swimlanes">
    <div class="empty-note">Waiting for benchmark tracks to emit events…</div>
  </div>

  <div class="grid-main">
    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Context Trajectory</div>
          <div class="panel-sub">Color = mode · dash = strategy · ▲/▼ probe · ◆ compaction</div>
        </div>
        <div class="seg-toggle" id="metric-toggle">
          <button class="active" data-metric="context">Context Tokens</button>
          <button data-metric="cache">Cache Hit %</button>
        </div>
      </div>
      <div class="chart-container" id="chart-wrap">
        <canvas id="trajectory-chart"></canvas>
      </div>
      <div class="legend-block">
        <div class="legend-row" id="legend-modes"></div>
        <div class="legend-row" id="legend-strats"></div>
      </div>

      <div class="panel-header" style="margin-top: 20px;">
        <div class="panel-title">Strategy Comparison Matrix</div>
        <span class="status-pill" id="completed-count" style="background: rgba(52,211,153,.1); color: var(--success); border-color: rgba(52,211,153,.3);">0 completed</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Strategy</th><th>Mode</th><th>Scale</th><th>Rubric</th>
            <th>Probe Recall</th><th>Billed Tokens</th><th>Peak Ctx</th><th>Cache Hit</th>
            <th>Cache Write</th><th>Modeled Cost</th>
          </tr>
        </thead>
        <tbody id="matrix-tbody">
          <tr><td colspan="10" style="color: var(--dim); text-align: center; padding: 20px;">No completed runs yet…</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Live Execution Feed</div>
          <div class="panel-sub mono" id="feed-count">0 events</div>
        </div>
        <div class="feed-filters" id="feed-filters">
          <button class="active" data-filter="all">All</button>
          <button data-filter="probe">Probes</button>
          <button data-filter="tool">Tools</button>
          <button data-filter="maintenance">Compaction</button>
        </div>
      </div>
      <div class="feed" id="feed-box"></div>
    </div>
  </div>
  </div><!-- #view-telemetry -->

  <div id="view-chat" style="display: none;">
    <div class="chat-layout">
      <aside class="chat-sidebar">
        <div class="chat-sidebar-header">
          <div class="chat-sidebar-title">Benchmark Tracks</div>
          <input type="text" id="chat-track-search" class="chat-search-input" placeholder="Search track by mode/strat…" />
        </div>
        <div class="chat-tracks-list" id="chat-tracks-list">
          <div class="empty-note" style="padding: 12px; font-size: 11px;">Loading tracks…</div>
        </div>
      </aside>

      <main class="chat-main" id="chat-main">
        <div class="chat-main-header">
          <div class="chat-track-info">
            <div class="chat-track-title" id="chat-active-title">Select a Benchmark Track</div>
            <div class="chat-track-meta" id="chat-active-meta">Select any running or completed agent track on the left to inspect live turns, model reasoning, and tool calls.</div>
          </div>
          <div class="chat-controls">
            <label class="chat-toggle-label">
              <input type="checkbox" id="chat-autoscroll" checked />
              <span>Follow Live</span>
            </label>
            <label class="chat-toggle-label" title="Expand model internal thought process by default">
              <input type="checkbox" id="chat-expand-thoughts" />
              <span>Expand Thoughts</span>
            </label>
            <div class="seg-toggle" id="chat-turn-filters">
              <button class="active" data-filter="all">All</button>
              <button data-filter="probes">Probes</button>
              <button data-filter="tools">Tools</button>
              <button data-filter="maint">Compacted</button>
            </div>
            <button class="chat-btn" id="chat-refresh-btn" title="Refresh Transcript">⟳</button>
            <button class="chat-btn" id="chat-export-btn" title="Export JSON">⬇ JSON</button>
          </div>
        </div>
        <div class="chat-live-banner" id="chat-live-banner" style="display: none;">
          <span class="live-pulse"></span>
          <span id="chat-live-banner-text">Model in flight…</span>
        </div>

        <div class="chat-transcript-body" id="chat-transcript-body">
          <div class="empty-note" style="margin-top: 50px;">Choose a track from the left sidebar to view its conversation transcript.</div>
        </div>
      </main>
    </div>
  </div><!-- #view-chat -->

  <script>
    'use strict';

    var MODE_COLORS = { programming: '#38bdf8', research: '#fb7185', general: '#34d399', memory: '#c084fc' };
    var MODE_ICONS = { programming: '\\uD83C\\uDFAE', research: '\\uD83D\\uDD2C', general: '\\uD83D\\uDCD0', memory: '\\uD83E\\uDDE0' };
    var MODE_ORDER = ['programming', 'research', 'general', 'memory'];
    var STRAT_DASH = { 'origami': '', 'soft': '7,4', 'handover': '3,3', 'shake': '8,3,2,3', 'sliding-window': '2,3' };
    var STRAT_ORDER = ['origami', 'soft', 'handover', 'shake', 'sliding-window'];

    var tracks = {};        // runId -> track state
    var seriesByRun = {};   // runId -> [{turn, contextTokens, cacheHit, isProbe, probePassed, maintenance}]
    var completedResults = [];
    var totalPrompt = 0, totalCached = 0, probesPassed = 0, probesTotal = 0, maintCount = 0, eventCount = 0;
    var currentMode = 'all';
    var metric = 'context';
    var isoMode = null;     // legend isolation
    var isoStrat = null;
    var feedFilter = 'all';
    var currentView = 'telemetry';
    var chatTracks = [];
    var activeChatKey = null;
    var chatTurnsByTrack = {};
    var chatTurnFilter = 'all';
    var chatSearchQuery = '';
    var chatExpandThoughts = false;
    var el = function (id) { return document.getElementById(id); };
    var swimlanes = el('swimlanes');
    var trajectoryCanvas = el('trajectory-chart');
    var liveChart = null;
    var feedBox = el('feed-box');

    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function fmtTok(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(Math.round(n));
    }
    function modeColor(m) { return MODE_COLORS[m] || '#94a3b8'; }
    function stratDash(s) { return STRAT_DASH[s] || ''; }

    // ------------------------------------------------------------------
    // Event ingestion
    // ------------------------------------------------------------------
    var evtSource = new EventSource('/api/events');
    evtSource.onopen = function () {
      el('conn-dot').className = 'conn-dot live';
      el('conn-label').textContent = 'live';
    };
    evtSource.onerror = function () {
      el('conn-dot').className = 'conn-dot';
      el('conn-label').textContent = 'reconnecting';
    };

    evtSource.addEventListener('init', function (e) {
      var d = JSON.parse(e.data);
      if (d.model) el('header-meta').textContent = 'model: ' + d.model;
      if (d.status) setStatus(d.status);
      (d.tracks || []).forEach(function (t) { tracks[t.runId] = t; });
      (d.series || []).forEach(function (p) {
        if (!seriesByRun[p.runId]) seriesByRun[p.runId] = [];
        seriesByRun[p.runId].push(p);
      });
      // rebuild aggregates from tracks
      Object.keys(tracks).forEach(function (k) {
        var t = tracks[k];
        totalPrompt += t.promptTokens || 0;
        totalCached += t.cachedTokens || 0;
        probesPassed += t.probesPassed || 0;
        probesTotal += t.probesTotal || 0;
        maintCount += t.maintenanceCount || 0;
      });
      (d.feed || []).forEach(function (ev) { appendFeed(ev, false); });
      (d.completed || []).forEach(function (r) { completedResults.push(r); });
      if (d.chatTracks) {
        chatTracks = d.chatTracks;
        updateChatTracksCount();
        renderChatTrackList();
      }
      renderAll();
    });

    evtSource.addEventListener('state_update', function (e) {
      var d = JSON.parse(e.data);
      if (d.model) el('header-meta').textContent = 'model: ' + d.model;
      if (d.status) setStatus(d.status);
    });

    evtSource.addEventListener('run_start', function (e) {
      var d = JSON.parse(e.data);
      if (!tracks[d.runId]) {
        tracks[d.runId] = {
          runId: d.runId, mode: d.mode, strategy: d.strategy, scale: d.scale,
          turn: 0, totalTurns: d.totalTurns || 0, contextTokens: 0, promptTokens: 0,
          cachedTokens: 0, cacheHit: 0, latencyMs: 0, lastAction: 'Initializing sandbox…',
          currentPrompt: '', status: 'initializing', startedAt: Date.now(),
          probesPassed: 0, probesTotal: 0, maintenanceCount: 0
        };
      }
      renderSwimlanes(); updateTabCounts(); drawChart();
    });

    evtSource.addEventListener('turn_start', function (e) {
      var d = JSON.parse(e.data);
      var t = tracks[d.runId];
      if (!t) return;
      t.status = 'thinking';
      t.turn = d.turn;
      t.currentPrompt = d.promptSnippet || '';
      t.lastAction = d.isProbe ? 'Needle probe: recalling fact…' : 'Awaiting model response…';
      renderCard(t);
      if (activeChatKey && (activeChatKey === (t.mode + ':' + t.strategy) || activeChatKey === d.runId)) {
        showChatLiveBanner('Model thinking on Turn ' + d.turn + (d.isProbe ? ' (Needle Probe)' : '') + '…');
      }
    });

    evtSource.addEventListener('tool_call', function (e) {
      var d = JSON.parse(e.data);
      var t = tracks[d.runId];
      if (!t) return;
      t.status = 'tool';
      t.lastAction = 'Tool: ' + d.tool + ' · ' + String(d.outputSnippet || '').slice(0, 80);
      renderCard(t);
      if (activeChatKey && (activeChatKey === (t.mode + ':' + t.strategy) || activeChatKey === d.runId)) {
        showChatLiveBanner('Executing tool ' + d.tool + '…');
      }
    });

    evtSource.addEventListener('turn_done', function (e) {
      var d = JSON.parse(e.data);
      var m = d.metric;
      var t = tracks[d.runId];
      if (!t) {
        t = tracks[d.runId] = {
          runId: d.runId, mode: d.mode, strategy: d.strategy, scale: d.scale,
          turn: 0, totalTurns: d.totalTurns || 0, contextTokens: 0, promptTokens: 0,
          cachedTokens: 0, cacheHit: 0, latencyMs: 0, lastAction: '', currentPrompt: '',
          status: 'running', startedAt: Date.now(), probesPassed: 0, probesTotal: 0, maintenanceCount: 0
        };
      }
      var prevPrompt = t.promptTokens, prevCached = t.cachedTokens;
      t.status = 'running';
      t.turn = m.turnIndex;
      t.contextTokens = m.contextTokens;
      t.promptTokens = m.promptTokens;
      t.cachedTokens = m.cachedTokens;
      t.cacheHit = Math.round((m.cacheHitRate || 0) * 100);
      t.latencyMs = m.latencyMs || 0;
      if (activeChatKey && (activeChatKey === (t.mode + ':' + t.strategy) || activeChatKey === d.runId)) {
        hideChatLiveBanner();
      }
      if (m.isProbe) {
        t.probesTotal++; probesTotal++;
        if (m.probeOutcome && m.probeOutcome.passed) { t.probesPassed++; probesPassed++; }
        t.lastAction = (m.probeOutcome && m.probeOutcome.passed) ? 'Needle probe: PASS \\u2713' : 'Needle probe: FAIL \\u2717';
      } else if (m.maintenanceNote) {
        t.maintenanceCount++; maintCount++;
        t.lastAction = m.maintenanceNote;
      } else {
        t.lastAction = m.toolCallsCount > 0 ? m.toolCallsCount + ' tool calls executed' : 'Completed turn response';
      }
      totalPrompt += Math.max(0, (m.promptTokens || 0) - 0);
      totalCached += Math.max(0, (m.cachedTokens || 0) - 0);

      if (!seriesByRun[d.runId]) seriesByRun[d.runId] = [];
      seriesByRun[d.runId].push({
        turn: m.turnIndex, contextTokens: m.contextTokens,
        cacheHit: Math.round((m.cacheHitRate || 0) * 100),
        isProbe: !!m.isProbe,
        probePassed: m.probeOutcome ? m.probeOutcome.passed : undefined,
        maintenance: m.maintenanceNote
      });

      updateAggregates(); renderCard(t); updateTabCounts(); drawChart();
    });

    evtSource.addEventListener('maintenance', function (e) {
      var d = JSON.parse(e.data);
      var t = tracks[d.runId];
      if (t) { t.lastAction = d.note; renderCard(t); }
    });

    evtSource.addEventListener('feed', function (e) {
      appendFeed(JSON.parse(e.data), true);
    });

    evtSource.addEventListener('run_complete', function (e) {
      var d = JSON.parse(e.data);
      var r = d.runResult;
      var t = tracks[d.runId];
      if (t) {
        t.status = 'completed';
        var rubText = (r.rubricScore != null && !isNaN(r.rubricScore)) ? Math.round(r.rubricScore * 100) + '%' : 'N/A';
        var proText = (r.probeScore != null && !isNaN(r.probeScore)) ? Math.round(r.probeScore * 100) + '%' : 'N/A';
        t.lastAction = 'Finished — Rubric ' + rubText + ' · Probe ' + proText;
        renderCard(t);
      }
      completedResults.push(r);
      renderMatrix(); updateAggregates(); updateTabCounts();
    });

    function setStatus(s) {
      var pill = el('status-pill');
      pill.textContent = String(s).toUpperCase();
      if (s === 'completed') {
        pill.className = 'status-pill';
        pill.style.background = 'rgba(52,211,153,.15)';
        pill.style.color = '#34d399';
        pill.style.borderColor = 'rgba(52,211,153,.4)';
      }
    }

    // ------------------------------------------------------------------
    // Aggregates
    // ------------------------------------------------------------------
    function updateAggregates() {
      var keys = Object.keys(tracks);
      var active = keys.filter(function (k) { return tracks[k].status !== 'completed'; }).length;
      var modeledCost = completedResults.reduce(function (sum, r) { return sum + (r.cost || 0); }, 0);
      var cacheWrites = completedResults.reduce(function (sum, r) { return sum + ((r.tokens && r.tokens.totalCacheWrite) || 0); }, 0);
      el('agg-tracks').textContent = String(active);
      el('agg-tracks-sub').textContent = keys.length + ' total tracks';
      el('agg-tokens').textContent = fmtTok(totalPrompt) + ' t';
      el('agg-cache').textContent = (totalPrompt > 0 ? ((totalCached / totalPrompt) * 100).toFixed(1) : '0.0') + '%';
      el('agg-cost').textContent = '$' + modeledCost.toFixed(4);
      el('agg-cache-write').textContent = fmtTok(cacheWrites) + ' t';
      el('agg-maint').textContent = String(maintCount);
      if (probesTotal > 0) {
        el('agg-recall').textContent = Math.round((probesPassed / probesTotal) * 100) + '%';
        el('agg-recall-sub').textContent = probesPassed + ' / ' + probesTotal + ' probes passed';
      }
      el('completed-count').textContent = completedResults.length + ' completed';
    }

    function updateTabCounts() {
      var counts = { all: 0, programming: 0, research: 0, general: 0, memory: 0 };
      Object.keys(tracks).forEach(function (k) {
        var m = tracks[k].mode;
        counts.all++;
        if (counts[m] !== undefined) counts[m]++;
      });
      document.querySelectorAll('.tab-count').forEach(function (c) {
        c.textContent = String(counts[c.getAttribute('data-count')] || 0);
      });
    }

    // ------------------------------------------------------------------
    // Mode swimlanes
    // ------------------------------------------------------------------
    function visibleRunIds() {
      return Object.keys(tracks).filter(function (k) {
        if (currentMode !== 'all' && tracks[k].mode !== currentMode) return false;
        return true;
      });
    }

    function renderSwimlanes() {
      var keys = Object.keys(tracks);
      if (keys.length === 0) {
        swimlanes.innerHTML = '<div class="empty-note">Waiting for benchmark tracks to emit events…</div>';
        return;
      }
      var modes = currentMode === 'all' ? MODE_ORDER.filter(function (m) {
        return keys.some(function (k) { return tracks[k].mode === m; });
      }) : [currentMode];

      // include any non-standard modes at the end
      keys.forEach(function (k) {
        var m = tracks[k].mode;
        if (modes.indexOf(m) === -1 && (currentMode === 'all' || currentMode === m)) modes.push(m);
      });

      var html = '';
      modes.forEach(function (m) {
        var mKeys = keys.filter(function (k) { return tracks[k].mode === m; });
        if (mKeys.length === 0) return;
        var activeN = mKeys.filter(function (k) { return tracks[k].status !== 'completed'; }).length;
        var doneN = mKeys.length - activeN;
        var avgCache = mKeys.reduce(function (a, k) { return a + (tracks[k].cacheHit || 0); }, 0) / mKeys.length;
        var avgProg = mKeys.reduce(function (a, k) {
          var t = tracks[k];
          return a + (t.totalTurns > 0 ? t.turn / t.totalTurns : 0);
        }, 0) / mKeys.length;
        var c = modeColor(m);
        html += '<div class="mode-section">'
          + '<div class="mode-section-header" style="border-left-color: ' + c + ';">'
          +   '<span class="mode-icon">' + (MODE_ICONS[m] || '\\uD83D\\uDCCC') + '</span>'
          +   '<h2 style="color: ' + c + ';">' + esc(m).toUpperCase() + '</h2>'
          +   '<div class="mode-kpis">'
          +     '<span><strong>' + activeN + '</strong> active · <strong>' + doneN + '</strong> done</span>'
          +     '<span>avg cache <strong>' + Math.round(avgCache) + '%</strong></span>'
          +     '<span>progress <strong>' + Math.round(avgProg * 100) + '%</strong></span>'
          +   '</div>'
          + '</div>'
          + '<div class="tracks-grid" id="lane-' + esc(m) + '"></div>'
          + '</div>';
      });
      swimlanes.innerHTML = html;

      modes.forEach(function (m) {
        var lane = el('lane-' + m);
        if (!lane) return;
        keys.filter(function (k) { return tracks[k].mode === m; })
          .sort(function (a, b) { return STRAT_ORDER.indexOf(tracks[a].strategy) - STRAT_ORDER.indexOf(tracks[b].strategy); })
          .forEach(function (k) {
            var card = document.createElement('div');
            card.className = 'track-card';
            card.id = 'card-' + k;
            lane.appendChild(card);
            renderCardInto(card, tracks[k]);
          });
      });
    }

    function renderCard(t) {
      var card = el('card-' + t.runId);
      if (!card) { renderSwimlanes(); return; }
      if (currentMode !== 'all' && t.mode !== currentMode) { renderSwimlanes(); return; }
      renderCardInto(card, t);
    }

    function renderCardInto(card, t) {
      var pct = t.totalTurns > 0 ? Math.min(100, Math.round((t.turn / t.totalTurns) * 100)) : 0;
      var c = modeColor(t.mode);
      var hitColor = t.cacheHit >= 70 ? 'var(--success)' : (t.cacheHit >= 40 ? 'var(--warning)' : 'var(--muted)');
      card.setAttribute('data-status', t.status);
      card.style.borderLeftColor = c;
      var stateLabel = { initializing: 'INIT', thinking: 'THINKING', tool: 'TOOL', running: 'RUNNING', completed: 'DONE \\u2713', error: 'ERROR' }[t.status] || t.status.toUpperCase();
      var elapsed = Math.max(0, Math.round((Date.now() - (t.startedAt || Date.now())) / 1000));
      card.innerHTML =
        '<div class="track-top">'
        + '<div class="badge-group">'
        +   '<span class="strat-pill strat-' + esc(t.strategy) + '">' + esc(t.strategy) + '</span>'
        +   '<span class="mono" style="font-size:10px;color:var(--dim);">' + esc(t.scale) + '</span>'
        + '</div>'
        + '<span class="state-chip state-' + esc(t.status) + '">' + stateLabel + '</span>'
        + '</div>'
        + '<div class="track-meta"><span>Turn <strong>' + t.turn + '</strong> / ' + t.totalTurns + '</span>'
        + '<span style="color:var(--muted);">' + pct + '% · ' + elapsed + 's</span></div>'
        + '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width: ' + pct + '%; background: ' + c + ';"></div></div>'
        + '<div class="track-metrics">'
        +   '<span>ctx <strong>' + fmtTok(t.contextTokens) + '</strong></span>'
        +   '<span>cache <strong style="color:' + hitColor + ';">' + t.cacheHit + '%</strong></span>'
        +   '<span>lat <strong>' + (t.latencyMs >= 1000 ? (t.latencyMs / 1000).toFixed(1) + 's' : t.latencyMs + 'ms') + '</strong></span>'
        +   (t.probesTotal > 0 ? '<span>probes <strong>' + t.probesPassed + '/' + t.probesTotal + '</strong></span>' : '')
        + '</div>'
        + (t.currentPrompt && t.status !== 'completed'
            ? '<div class="track-prompt"><span class="plabel">Current prompt</span>' + esc(t.currentPrompt) + '</div>'
            : '')
        + '<div class="track-action" title="' + esc(t.lastAction) + '">' + esc(t.lastAction || 'Active') + '</div>'
        + '<button class="track-chat-btn" data-track="' + esc(t.mode) + ':' + esc(t.strategy) + '" onclick="openChatForTrack(this.dataset.track)">💬 Chat Logs</button>';
    }

    // ------------------------------------------------------------------
    // Trajectory chart
    // ------------------------------------------------------------------
    function chartSeries() {
      // returns array of { runId, mode, strategy, pts }
      return Object.keys(seriesByRun).map(function (k) {
        var t = tracks[k] || {};
        return { runId: k, mode: t.mode || 'programming', strategy: t.strategy || 'origami', pts: seriesByRun[k] };
      }).filter(function (s) {
        if (currentMode !== 'all' && s.mode !== currentMode) return false;
        if (isoMode && s.mode !== isoMode) return false;
        if (isoStrat && s.strategy !== isoStrat) return false;
        return s.pts.length > 0;
      });
    }

    function getStratDash(strat) {
      var d = STRAT_DASH[strat];
      if (!d) return [];
      return d.split(',').map(Number);
    }

    function drawChart() {
      if (!trajectoryCanvas || typeof Chart === 'undefined') return;
      var list = chartSeries();
      if (list.length === 0) {
        if (liveChart) {
          liveChart.data.datasets = [];
          liveChart.update('none');
        }
        return;
      }

      var datasets = list.map(function (s) {
        var color = modeColor(s.mode);
        var dash = getStratDash(s.strategy);
        var isOrigami = s.strategy === 'origami';
        var isLive = tracks[s.runId] && tracks[s.runId].status !== 'completed';

        var pts = s.pts.map(function (p) {
          var yVal = metric === 'context' ? p.contextTokens : p.cacheHit;
          return {
            x: p.turn,
            y: yVal,
            raw: p
          };
        });

        var pointStyles = pts.map(function (p) {
          if (metric === 'context') {
            if (p.raw.isProbe) return 'triangle';
            if (p.raw.maintenance) return 'rectRot';
          }
          return 'circle';
        });

        var pointRotations = pts.map(function (p) {
          if (metric === 'context' && p.raw.isProbe && !p.raw.probePassed) return 180;
          return 0;
        });

        var pointRadii = pts.map(function (p, idx) {
          if (metric === 'context' && (p.raw.isProbe || p.raw.maintenance)) return 5;
          if (idx === pts.length - 1) return isLive ? 4.5 : 3.5;
          return 0;
        });

        var pointBgColors = pts.map(function (p, idx) {
          if (metric === 'context') {
            if (p.raw.isProbe) return p.raw.probePassed ? '#34d399' : '#f87171';
            if (p.raw.maintenance) return '#fbbf24';
          }
          return color;
        });

        return {
          label: s.mode + ' · ' + s.strategy,
          runId: s.runId,
          mode: s.mode,
          strategy: s.strategy,
          borderColor: color,
          borderDash: dash,
          borderWidth: isOrigami ? 3 : 1.8,
          pointStyle: pointStyles,
          pointRotation: pointRotations,
          pointRadius: pointRadii,
          pointHoverRadius: 6,
          pointBackgroundColor: pointBgColors,
          pointBorderColor: '#070a12',
          pointBorderWidth: 1.5,
          tension: 0.1,
          data: pts
        };
      });

      var yMax = metric === 'context' ? undefined : 100;
      var yMin = 0;

      if (!liveChart) {
        var ctx = trajectoryCanvas.getContext('2d');
        liveChart = new Chart(ctx, {
          type: 'line',
          data: { datasets: datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
              mode: 'index',
              intersect: false
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: 'rgba(9, 13, 22, 0.96)',
                borderColor: '#1a2336',
                borderWidth: 1,
                titleFont: { family: 'JetBrains Mono', size: 11, weight: 'bold' },
                bodyFont: { family: 'JetBrains Mono', size: 10.5 },
                padding: 10,
                cornerRadius: 8,
                itemSort: function (a, b) { return b.parsed.y - a.parsed.y; },
                callbacks: {
                  title: function (items) {
                    return items && items.length > 0 ? 'Turn ' + items[0].parsed.x : '';
                  },
                  label: function (item) {
                    var ds = item.dataset;
                    var raw = (item.raw && item.raw.raw) || {};
                    var v = metric === 'context' ? fmtTok(item.parsed.y) + ' ctx' : item.parsed.y + '% hit';
                    var extra = '';
                    if (raw.isProbe) {
                       extra = raw.probePassed ? ' [Probe: PASS \u2713]' : ' [Probe: FAIL \u2717]';
                    } else if (raw.maintenance) {
                      extra = ' [' + raw.maintenance + ']';
                    }
                    return ds.label + ' — ' + v + extra;
                  }
                }
              }
            },
            scales: {
              x: {
                type: 'linear',
                grid: { color: '#1a2336' },
                ticks: {
                  color: '#64748b',
                  font: { family: 'JetBrains Mono', size: 10 }
                },
                title: {
                  display: true,
                  text: 'turns →',
                  align: 'end',
                  color: '#475569',
                  font: { family: 'JetBrains Mono', size: 9 }
                }
              },
              y: {
                type: 'linear',
                min: yMin,
                max: yMax,
                grid: { color: '#1a2336' },
                ticks: {
                  color: '#64748b',
                  font: { family: 'JetBrains Mono', size: 10 },
                  callback: function (val) {
                    return metric === 'context' ? fmtTok(val) : Math.round(val) + '%';
                  }
                }
              }
            }
          }
        });
      } else {
        liveChart.data.datasets = datasets;
        liveChart.options.scales.y.max = yMax;
        liveChart.options.scales.y.ticks.callback = function (val) {
          return metric === 'context' ? fmtTok(val) : Math.round(val) + '%';
        };
        liveChart.update('none');
      }
    }

    // ------------------------------------------------------------------
    // Legend
    // ------------------------------------------------------------------
    function renderLegend() {
      var mh = '';
      MODE_ORDER.forEach(function (m) {
        var cls = 'legend-item' + (isoMode === m ? ' isolated' : '') + (isoMode && isoMode !== m ? ' dimmed' : '');
        mh += '<span class="' + cls + '" data-mode="' + m + '">'
          + '<span class="legend-swatch" style="border-top-color: ' + modeColor(m) + ';"></span>'
          + (MODE_ICONS[m] || '') + ' ' + m + '</span>';
      });
      el('legend-modes').innerHTML = mh;

      var sh = '';
      STRAT_ORDER.forEach(function (s) {
        var cls = 'legend-item' + (isoStrat === s ? ' isolated' : '') + (isoStrat && isoStrat !== s ? ' dimmed' : '');
        var dash = stratDash(s) || 'none';
        sh += '<span class="' + cls + '" data-strat="' + s + '">'
          + '<svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#cbd5e1" stroke-width="2.5" stroke-dasharray="' + dash + '"/></svg>'
          + s + '</span>';
      });
      el('legend-strats').innerHTML = sh;

      document.querySelectorAll('#legend-modes .legend-item').forEach(function (it) {
        it.addEventListener('click', function () {
          var m = it.getAttribute('data-mode');
          isoMode = isoMode === m ? null : m;
          renderLegend(); drawChart();
        });
      });
      document.querySelectorAll('#legend-strats .legend-item').forEach(function (it) {
        it.addEventListener('click', function () {
          var s = it.getAttribute('data-strat');
          isoStrat = isoStrat === s ? null : s;
          renderLegend(); drawChart();
        });
      });
    }

    // ------------------------------------------------------------------
    // Comparison matrix
    // ------------------------------------------------------------------
    function renderMatrix() {
      var tbody = el('matrix-tbody');
      if (completedResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="color: var(--dim); text-align: center; padding: 20px;">No completed runs yet…</td></tr>';
        return;
      }
      var rows = completedResults.filter(function (r) {
        return currentMode === 'all' || r.mode === currentMode;
      });
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="color: var(--dim); text-align: center; padding: 20px;">No completed runs in this mode yet.</td></tr>';
        return;
      }
      var html = '';
      rows.forEach(function (r) {
        var hasRub = r.rubricScore != null && !isNaN(r.rubricScore);
        var rub = hasRub ? Math.round(r.rubricScore * 100) : null;
        var hasPro = r.probeScore != null && !isNaN(r.probeScore);
        var pro = hasPro ? Math.round(r.probeScore * 100) : null;
        var hit = Math.round(r.tokens.cacheHitPct);
        var rubC = !hasRub ? 'var(--muted)' : (rub >= 80 ? 'var(--success)' : rub >= 50 ? 'var(--warning)' : 'var(--danger)');
        var proC = !hasPro ? 'var(--muted)' : (pro >= 80 ? 'var(--success)' : pro >= 50 ? 'var(--warning)' : 'var(--danger)');
        var rubText = hasRub ? rub + '%' : 'N/A';
        var proText = hasPro ? pro + '%' : 'N/A';

        var evalN = r.rubricEvaluatedCount !== undefined ? r.rubricEvaluatedCount : r.rubricPassedCount;
        var unavailN = r.rubricUnavailableCount || 0;
        var errN = r.rubricErrorCount || 0;
        var rubSub = '(' + r.rubricPassedCount + '/' + evalN + ' of ' + r.rubricTotalCount;
        if (unavailN > 0) rubSub += ' · ' + unavailN + ' unavail';
        if (errN > 0) rubSub += ' · ' + errN + ' err';
        rubSub += ')';
        var proSub = '(' + r.probePassedCount + '/' + r.probeTotalCount + ')';

        html += '<tr' + (r.strategy === 'origami' ? ' style="background: rgba(56,189,248,.05);"' : '') + '>'
          + '<td><span class="strat-pill strat-' + esc(r.strategy) + '">' + esc(r.strategy) + '</span></td>'
          + '<td><span class="feed-mode-tag" style="color:' + modeColor(r.mode) + ';">' + esc(r.mode) + '</span></td>'
          + '<td style="color: var(--muted);">' + esc(r.scale) + '</td>'
          + '<td class="mono" style="color:' + rubC + ';">' + rubText + ' ' + rubSub + '</td>'
          + '<td class="mono" style="color:' + proC + ';">' + proText + ' ' + proSub + '</td>'
          + '<td class="mono">' + r.tokens.billedTokens.toLocaleString() + '</td>'
          + '<td class="mono">' + r.tokens.peakContextTokens.toLocaleString() + '</td>'
          + '<td class="mono" style="color: var(--success);">' + hit + '%</td>'
          + '<td class="mono">' + r.tokens.totalCacheWrite.toLocaleString() + '</td>'
          + '<td class="mono">$' + Number(r.cost || 0).toFixed(4) + '</td>'
          + '</tr>';
      });
      tbody.innerHTML = html;
    }

    // ------------------------------------------------------------------
    // Live feed
    // ------------------------------------------------------------------
    function feedKindMatch(kind) {
      if (feedFilter === 'all') return true;
      if (feedFilter === 'probe') return kind === 'probe-pass' || kind === 'probe-fail';
      if (feedFilter === 'tool') return kind === 'tool';
      if (feedFilter === 'maintenance') return kind === 'maintenance';
      return true;
    }

    function appendFeed(ev, rerender) {
      eventCount++;
      el('feed-count').textContent = eventCount + ' events';
      if (!feedKindMatch(ev.kind)) return;
      var d = document.createElement('div');
      d.className = 'feed-item k-' + esc(ev.kind);
      var time = new Date(ev.ts || Date.now()).toLocaleTimeString();
      d.innerHTML = '<div class="feed-head">'
        + '<span class="feed-tags">'
        + '<span class="feed-mode-tag" style="color:' + modeColor(ev.mode) + ';">' + esc(ev.mode || '—') + '</span>'
        + '<span class="strat-pill strat-' + esc(ev.strategy) + '" style="font-size:9px; padding:1px 6px;">' + esc(ev.strategy || '') + '</span>'
        + '</span><span>' + time + '</span></div>'
        + '<div class="feed-text">' + esc(ev.text) + '</div>';
      feedBox.prepend(d);
      while (feedBox.children.length > 120) feedBox.removeChild(feedBox.lastChild);
    }

    document.querySelectorAll('#feed-filters button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#feed-filters button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        feedFilter = b.getAttribute('data-filter');
        feedBox.innerHTML = '';
        // re-render from server-buffered feed on next init; live events continue to flow
      });
    });

    // ------------------------------------------------------------------
    // Tabs & metric toggle
    // ------------------------------------------------------------------
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.tab-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        currentMode = b.getAttribute('data-mode');
        renderSwimlanes(); drawChart(); renderMatrix();
      });
    });

    document.querySelectorAll('#metric-toggle button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#metric-toggle button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        metric = b.getAttribute('data-metric');
        drawChart();
      });
    });

    // ------------------------------------------------------------------
    // Chat Logs View & Transcript Management
    // ------------------------------------------------------------------
    function updateChatTracksCount() {
      var badge = el('chat-tracks-count');
      if (badge) badge.textContent = String(chatTracks.length);
    }

    function switchView(v) {
      currentView = v;
      document.querySelectorAll('#view-nav button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-view') === v);
      });
      el('view-telemetry').style.display = v === 'telemetry' ? 'block' : 'none';
      el('view-chat').style.display = v === 'chat' ? 'block' : 'none';
      if (v === 'chat') {
        loadChatTracks();
        if (!activeChatKey && chatTracks.length > 0) {
          openChatForTrack(chatTracks[0].trackKey || chatTracks[0].runId);
        }
      }
    }

    document.querySelectorAll('#view-nav button').forEach(function (b) {
      b.addEventListener('click', function () {
        switchView(b.getAttribute('data-view'));
      });
    });

    function loadChatTracks() {
      fetch('/api/chat/tracks').then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok && d.tracks) {
          chatTracks = d.tracks;
          updateChatTracksCount();
          renderChatTrackList();
          if (!activeChatKey && chatTracks.length > 0) {
            openChatForTrack(chatTracks[0].trackKey || chatTracks[0].runId);
          }
        }
      }).catch(function () {});
    }

    function renderChatTrackList() {
      var list = el('chat-tracks-list');
      if (!list) return;
      var q = (chatSearchQuery || '').toLowerCase().trim();
      var filtered = chatTracks.filter(function (t) {
        if (!q) return true;
        return (t.mode || '').toLowerCase().indexOf(q) !== -1
          || (t.strategy || '').toLowerCase().indexOf(q) !== -1
          || (t.trackKey || '').toLowerCase().indexOf(q) !== -1
          || (t.runId || '').toLowerCase().indexOf(q) !== -1;
      });

      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-note" style="padding: 12px; font-size: 11px;">No matching tracks found.</div>';
        return;
      }

      var html = '';
      filtered.forEach(function (t) {
        var key = t.trackKey || t.runId;
        var isSel = activeChatKey === key || activeChatKey === t.runId;
        var c = modeColor(t.mode);
        var turnsN = t.turnCount || (chatTurnsByTrack[key] ? chatTurnsByTrack[key].length : 0);
        var runTrack = tracks[t.runId];
        var status = runTrack ? runTrack.status : (turnsN > 0 ? 'running' : 'initializing');
        var statusLabel = { initializing: 'INIT', thinking: 'THINKING', tool: 'TOOL', running: 'RUNNING', completed: 'DONE ✓', error: 'ERROR' }[status] || status.toUpperCase();

        html += '<div class="chat-track-item' + (isSel ? ' active' : '') + '" style="border-left-color: ' + c + ';" data-key="' + esc(key) + '" onclick="openChatForTrack(this.dataset.key)">'
          + '<div class="chat-track-row1">'
          +   '<div style="display:flex;align-items:center;gap:6px;">'
          +     '<span class="strat-pill strat-' + esc(t.strategy) + '" style="font-size:9.5px;padding:1px 6px;">' + esc(t.strategy) + '</span>'
          +     '<span style="font-weight:700;font-size:11.5px;color:' + c + ';">' + esc(t.mode) + '</span>'
          +   '</div>'
          +   '<span class="state-chip state-' + esc(status) + '" style="font-size:8.5px;padding:1px 6px;">' + statusLabel + '</span>'
          + '</div>'
          + '<div class="chat-track-row2">'
          +   '<span>' + esc(t.scale) + ' · <strong>' + turnsN + '</strong> turns</span>'
          +   '<span style="color:var(--dim);">' + esc(t.strategy) + '</span>'
          + '</div>'
          + '</div>';
      });
      list.innerHTML = html;
    }

    el('chat-track-search').addEventListener('input', function (e) {
      chatSearchQuery = e.target.value;
      renderChatTrackList();
    });

    function openChatForTrack(key) {
      activeChatKey = key;
      renderChatTrackList();
      if (currentView !== 'chat') switchView('chat');
      fetchChatTranscript(key);
    }

    function fetchChatTranscript(key) {
      var body = el('chat-transcript-body');
      body.innerHTML = '<div class="empty-note" style="margin-top: 40px;">Fetching transcript for ' + esc(key) + '…</div>';
      fetch('/api/chat?track=' + encodeURIComponent(key)).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) {
          chatTurnsByTrack[key] = d.turns || [];
          renderActiveChatTranscript();
        }
      }).catch(function (err) {
        body.innerHTML = '<div class="empty-note" style="margin-top: 40px; color: var(--danger);">Failed to load transcript: ' + esc(err.message) + '</div>';
      });
    }

    function renderActiveChatTranscript() {
      var body = el('chat-transcript-body');
      if (!activeChatKey) {
        body.innerHTML = '<div class="empty-note" style="margin-top: 50px;">Select a benchmark track on the left to inspect its conversation stream.</div>';
        return;
      }

      // find track details
      var tInfo = chatTracks.find(function (t) { return t.trackKey === activeChatKey || t.runId === activeChatKey; });
      var mode = tInfo ? tInfo.mode : activeChatKey.split(':')[0] || 'programming';
      var strat = tInfo ? tInfo.strategy : activeChatKey.split(':')[1] || 'origami';
      var scale = tInfo ? tInfo.scale : 'marathon';
      var c = modeColor(mode);

      el('chat-active-title').innerHTML = '<span class="strat-pill strat-' + esc(strat) + '">' + esc(strat) + '</span>'
        + '<span style="color:' + c + ';">' + esc(mode).toUpperCase() + '</span>'
        + '<span class="mono" style="font-size:12px;color:var(--muted);font-weight:normal;">' + esc(scale) + ' · ' + esc(activeChatKey) + '</span>';

      var turns = chatTurnsByTrack[activeChatKey] || [];
      var totalTok = turns.reduce(function (a, tn) { return a + (tn.metrics ? tn.metrics.promptTokens : 0); }, 0);
      var peakCtx = turns.reduce(function (a, tn) { return Math.max(a, (tn.metrics ? tn.metrics.contextTokens : 0)); }, 0);
      var probePass = turns.filter(function (tn) { return tn.isProbe && tn.probeOutcome && tn.probeOutcome.passed; }).length;
      var probeTot = turns.filter(function (tn) { return tn.isProbe; }).length;

      el('chat-active-meta').innerHTML = 'Turns: <strong>' + turns.length + '</strong>'
        + ' · Billed: <strong>' + fmtTok(totalTok) + ' t</strong>'
        + ' · Peak Ctx: <strong>' + fmtTok(peakCtx) + ' t</strong>'
        + (probeTot > 0 ? ' · Probes: <strong>' + probePass + '/' + probeTot + '</strong>' : '');

      var filtered = turns.filter(function (tn) {
        if (chatTurnFilter === 'probes') return tn.isProbe;
        if (chatTurnFilter === 'tools') return tn.messages && tn.messages.some(function (m) { return m.toolCalls && m.toolCalls.length > 0; });
        if (chatTurnFilter === 'maint') return !!tn.maintenanceNote;
        return true;
      });

      if (filtered.length === 0) {
        body.innerHTML = '<div class="empty-note" style="margin-top: 50px;">No turns matching current filter (' + esc(chatTurnFilter) + ').</div>';
        return;
      }

      var html = '';
      filtered.forEach(function (tn) { html += renderTurnCardHtml(tn); });
      body.innerHTML = html;

      if (el('chat-autoscroll') && el('chat-autoscroll').checked) {
        scrollChatToBottom();
      }
    }

    function appendChatTurnToTranscript(turn) {
      var body = el('chat-transcript-body');
      // check filter match
      if (chatTurnFilter === 'probes' && !turn.isProbe) return;
      if (chatTurnFilter === 'tools' && (!turn.messages || !turn.messages.some(function (m) { return m.toolCalls && m.toolCalls.length > 0; }))) return;
      if (chatTurnFilter === 'maint' && !turn.maintenanceNote) return;

      // remove placeholder empty-note if present
      var empty = body.querySelector('.empty-note');
      if (empty) empty.remove();

      var div = document.createElement('div');
      div.innerHTML = renderTurnCardHtml(turn);
      body.appendChild(div.firstElementChild);
    }

    function renderTurnCardHtml(tn) {
      var m = tn.metrics || {};
      var ctxStr = m.contextTokens ? fmtTok(m.contextTokens) + ' ctx' : '';
      var promptStr = m.promptTokens ? (tn.turnIndex > 1 ? '+' : '') + fmtTok(m.promptTokens) + ' prompt' : '';
      var hitPct = Math.round((m.cacheHitRate || 0) * 100);
      var hitStr = m.promptTokens ? hitPct + '% cache' : '';
      var latStr = m.latencyMs ? (m.latencyMs >= 1000 ? (m.latencyMs / 1000).toFixed(1) + 's' : m.latencyMs + 'ms') : '';

      var probeBadge = '';
      if (tn.isProbe) {
        var pass = tn.probeOutcome && tn.probeOutcome.passed;
        probeBadge = '<span class="probe-badge ' + (pass ? 'pass' : 'fail') + '">' + (pass ? '🎯 PROBE: PASS ✓' : '🎯 PROBE: FAIL ✗') + '</span>';
      }
      var maintBadge = tn.maintenanceNote ? '<span class="maint-badge">⚡ ' + esc(tn.maintenanceNote) + '</span>' : '';

      var html = '<div class="turn-card" id="turn-card-' + tn.turnIndex + '">'
        + '<div class="turn-card-header">'
        +   '<div class="turn-card-left">'
        +     '<span class="turn-number">Turn ' + tn.turnIndex + '</span>'
        +     probeBadge
        +     maintBadge
        +   '</div>'
        +   '<div class="turn-chips">'
        +     (ctxStr ? '<span>' + ctxStr + '</span>' : '')
        +     (promptStr ? '<span>' + promptStr + '</span>' : '')
        +     (hitStr ? '<span style="color:var(--success);">' + hitStr + '</span>' : '')
        +     (latStr ? '<span>' + latStr + '</span>' : '')
        +   '</div>'
        + '</div>'
        + '<div class="turn-card-body">';

      // User prompt
      if (tn.userMessage) {
        html += '<div class="bubble-user">'
          + '<div class="bubble-label">' + (tn.isProbe ? 'Needle Probe Prompt' : 'Task Prompt') + '</div>'
          + esc(tn.userMessage)
          + '</div>';
      }

      // Assistant steps / reasoning / tools
      (tn.messages || []).forEach(function (msg) {
        if (msg.role === 'assistant') {
          html += '<div class="bubble-assistant">';
          var isIdentical = msg.reasoning && msg.content && (msg.reasoning.trim() === msg.content.trim());
          if (msg.reasoning && !isIdentical) {
            var openAttr = chatExpandThoughts ? ' open' : '';
            html += '<details class="chat-thinking"' + openAttr + '>'
              + '<summary><span>💭 Thought Process (' + msg.reasoning.length + ' chars)</span><span style="font-size:9.5px;color:rgba(251,191,36,.65);font-weight:normal;">click to toggle</span></summary>'
              + '<div class="chat-thinking-content">' + esc(msg.reasoning) + '</div>'
              + '</details>';
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            msg.toolCalls.forEach(function (tc) {
              var argsJson = '';
              try { argsJson = JSON.stringify(tc.args, null, 2); } catch (e) { argsJson = String(tc.args || ''); }
              html += '<div class="chat-tool-block">'
                + '<div class="chat-tool-header">🔧 Tool Call: <strong>' + esc(tc.name) + '</strong></div>'
                + (argsJson ? '<div class="chat-tool-args">' + esc(argsJson) + '</div>' : '')
                + (tc.output ? '<div class="chat-tool-output"><div class="chat-tool-output-label">➜ Tool Output</div>' + esc(tc.output) + '</div>' : '')
                + '</div>';
            });
          }
          if (msg.content && msg.content.trim()) {
            html += '<div class="chat-assistant-reply">'
              + '<div class="bubble-label">Assistant Response</div>'
              + esc(msg.content)
              + '</div>';
          }
          html += '</div>';
        }
      });
      html += '</div></div>';
      return html;
    }

    function scrollChatToBottom() {
      var body = el('chat-transcript-body');
      if (body) {
        setTimeout(function () { body.scrollTop = body.scrollHeight; }, 20);
      }
    }

    function showChatLiveBanner(text) {
      var b = el('chat-live-banner');
      var t = el('chat-live-banner-text');
      if (b && t) {
        t.textContent = text;
        b.style.display = 'flex';
      }
    }

    function hideChatLiveBanner() {
      var b = el('chat-live-banner');
      if (b) b.style.display = 'none';
    }

    document.querySelectorAll('#chat-turn-filters button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#chat-turn-filters button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        chatTurnFilter = b.getAttribute('data-filter');
        renderActiveChatTranscript();
      });
    });

    el('chat-refresh-btn').addEventListener('click', function () {
      if (activeChatKey) fetchChatTranscript(activeChatKey);
    });

    var expandCheckbox = el('chat-expand-thoughts');
    if (expandCheckbox) {
      expandCheckbox.addEventListener('change', function () {
        chatExpandThoughts = !!expandCheckbox.checked;
        // Update all thinking elements currently in DOM
        document.querySelectorAll('.chat-thinking').forEach(function (det) {
          det.open = chatExpandThoughts;
        });
      });
    }

    el('chat-export-btn').addEventListener('click', function () {
      if (!activeChatKey) return;
      var turns = chatTurnsByTrack[activeChatKey] || [];
      var blob = new Blob([JSON.stringify({ trackKey: activeChatKey, turns: turns }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chat-transcript-' + activeChatKey.replace(/[:\/]/g, '-') + '.json';
      a.click();
    });

    evtSource.addEventListener('chat_turn', function (e) {
      var d = JSON.parse(e.data);
      var key = d.trackKey || (d.mode && d.strategy ? d.mode + ':' + d.strategy : d.runId);
      if (!chatTurnsByTrack[key]) chatTurnsByTrack[key] = [];
      chatTurnsByTrack[key].push(d.turn);

      // update track item in chatTracks
      var found = false;
      for (var i = 0; i < chatTracks.length; i++) {
        if (chatTracks[i].trackKey === key || chatTracks[i].runId === d.runId) {
          chatTracks[i].turnCount = chatTurnsByTrack[key].length;
          found = true;
          break;
        }
      }
      if (!found) {
        chatTracks.push({
          trackKey: key,
          runId: d.runId || key,
          mode: d.mode,
          strategy: d.strategy,
          scale: d.scale,
          turnCount: chatTurnsByTrack[key].length
        });
      }
      updateChatTracksCount();
      renderChatTrackList();

      if (!activeChatKey && chatTracks.length > 0) {
        openChatForTrack(chatTracks[0].trackKey || chatTracks[0].runId);
      } else if (activeChatKey === key || activeChatKey === d.runId) {
        appendChatTurnToTranscript(d.turn);
        if (el('chat-autoscroll') && el('chat-autoscroll').checked) {
          scrollChatToBottom();
        }
      }
    });

    function renderAll() {
      updateAggregates(); updateTabCounts(); renderSwimlanes(); renderLegend(); drawChart(); renderMatrix();
    }

    renderLegend();
    drawChart();

    // keep elapsed seconds ticking on visible cards
    setInterval(function () {
      Object.keys(tracks).forEach(function (k) {
        var t = tracks[k];
        if (t.status === 'thinking' || t.status === 'tool' || t.status === 'running') renderCard(t);
      });
    }, 2000);
  </script>
</body>
</html>`;
}
