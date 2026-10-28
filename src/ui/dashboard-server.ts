import type { Server } from "bun";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { OrigamiRuntime } from "../runtime.ts";
import { openDb } from "../persist/db.ts";

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  getRuntime: () => OrigamiRuntime | null;
  openBrowser?: boolean;
}

export interface DashboardInstance {
  url: string;
  port: number;
  server: Server<unknown>;
  broadcast: (event: string, data: unknown) => void;
  stop: () => void;
}

function openUrl(targetUrl: string): void {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", targetUrl], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", targetUrl], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", targetUrl], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // Best-effort browser launch
  }
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardInstance> {
  const initialPort = opts.port ?? 3780;
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = new TextEncoder().encode(payload);
    for (const client of clients) {
      try {
        client.enqueue(encoded);
      } catch {
        clients.delete(client);
      }
    }
  }

  let server: Server<unknown> | null = null;
  let activePort = initialPort;

  for (let offset = 0; offset < 10; offset++) {
    const tryPort = initialPort + offset;
    try {
      server = Bun.serve({
        port: tryPort,
        hostname: host,
        async fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname;
          const rt = opts.getRuntime();

          // CORS headers for local tools
          const corsHeaders: Record<string, string> = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          };

          if (req.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
          }

          // 1. SSE Stream
          if (path === "/api/events") {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                clients.add(controller);
                const welcome = new TextEncoder().encode(`event: connected\ndata: {}\n\n`);
                controller.enqueue(welcome);
              },
              cancel(controller) {
                clients.delete(controller);
              },
            });

            return new Response(stream, {
              headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          // 2. Status API
          if (path === "/api/status") {
            if (!rt) return Response.json({ error: "no active session" }, { status: 503, headers: corsHeaders });
            rt.sync();
            const report = rt.engine.status();
            return Response.json(
              {
                sessionId: rt.engine.sessionId,
                windowTokens: rt.engine.windowTokens,
                liveTokens: report.tokenSplit.live,
                savedTokens: report.tokenSplit.foldedSavings,
                ...report,
              },
              { headers: corsHeaders },
            );
          }

          // 3. Blocks API
          if (path === "/api/blocks") {
            const db = rt?.db ?? openDb(`${getAgentDir()}/origami.db`);
            const sessionId = url.searchParams.get("session") || rt?.engine.sessionId || "";
            const blocks = sessionId ? db.blocksForSession(sessionId) : [];
            return Response.json(blocks, { headers: corsHeaders });
          }

          // 4. Cache Rounds API
          if (path === "/api/rounds") {
            const db = rt?.db ?? openDb(`${getAgentDir()}/origami.db`);
            const sessionId = url.searchParams.get("session") || rt?.engine.sessionId || "";
            const rounds = sessionId ? db.roundsForSession(sessionId) : [];
            return Response.json(rounds, { headers: corsHeaders });
          }

          // 5. Search API
          if (path === "/api/search") {
            const q = url.searchParams.get("q") ?? "";
            const limit = Number.parseInt(url.searchParams.get("limit") ?? "15", 10);
            if (!rt) return Response.json([], { headers: corsHeaders });
            const hits = rt.engine.search(q, limit);
            return Response.json(hits, { headers: corsHeaders });
          }

          // 6. Action: Unfold
          if (path === "/api/unfold" && req.method === "POST") {
            if (!rt) return Response.json({ error: "no active session" }, { status: 503, headers: corsHeaders });
            const body = (await req.json()) as { id: string; mode?: "file" | "inline" };
            if (body.mode === "inline") {
              const res = rt.engine.executeUnfold(body.id);
              broadcast("unfold", { id: body.id, mode: "inline", res });
              return Response.json(res, { headers: corsHeaders });
            }
            const res = await rt.engine.unfoldArtifact(body.id);
            broadcast("unfold", { id: body.id, mode: "file", res });
            return Response.json(res, { headers: corsHeaders });
          }

          // 7. Action: Manual Fold
          if (path === "/api/fold" && req.method === "POST") {
            if (!rt) return Response.json({ error: "no active session" }, { status: 503, headers: corsHeaders });
            const body = (await req.json()) as { range: string; topic: string; summary: string; tier?: 1 | 2 | 3 };
            const res = rt.engine.executeFold({
              folds: [{ range: body.range, topic: body.topic, summary: body.summary }],
              tier: body.tier,
            });
            broadcast("fold", { res });
            return Response.json(res, { headers: corsHeaders });
          }

          // 8. Serve Dashboard SPA
          return new Response(renderDashboardHtml(), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        },
      });
      activePort = tryPort;
      break;
    } catch {
      // try next port
    }
  }

  if (!server) {
    throw new Error(`Failed to bind origami dashboard server on ports ${initialPort}..${initialPort + 9}`);
  }

  const url = `http://${host}:${activePort}`;
  if (opts.openBrowser !== false) {
    openUrl(url);
  }

  return {
    url,
    port: activePort,
    server,
    broadcast,
    stop() {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      server?.stop(true);
    },
  };
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Origami Context Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-hover: #1f242c;
      --border: #30363d;
      --fg: #c9d1d9;
      --fg-bright: #f0f6fc;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-dim: rgba(88, 166, 255, 0.15);
      --success: #3fb950;
      --warning: #d29922;
      --error: #f85149;
      --tier1: #388bfd;
      --tier2: #a371f7;
      --tier3: #f0883e;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      padding: 24px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand svg {
      width: 28px;
      height: 28px;
      fill: var(--accent);
    }
    .brand h1 {
      font-size: 20px;
      font-weight: 600;
      color: var(--fg-bright);
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      position: relative;
    }
    .kpi-label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--fg-bright);
      font-family: var(--font-mono);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .progress-bar {
      width: 100%;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      margin-top: 10px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--muted);
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab-btn:hover {
      color: var(--fg-bright);
    }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    /* Content Panels */
    .panel { display: none; }
    .panel.active { display: block; }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: rgba(255, 255, 255, 0.02);
      font-weight: 600;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface-hover); }

    .tag-tier {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .tag-tier1 { background: rgba(56, 139, 253, 0.15); color: var(--tier1); }
    .tag-tier2 { background: rgba(163, 113, 247, 0.15); color: var(--tier2); }
    .tag-tier3 { background: rgba(240, 136, 62, 0.15); color: var(--tier3); }

    .mono { font-family: var(--font-mono); }
    .btn {
      background: var(--surface);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
    }
    .btn:hover { background: var(--surface-hover); color: var(--fg-bright); border-color: var(--accent); }
    .btn-sm { padding: 4px 8px; font-size: 11px; }

    /* Search */
    .search-box {
      margin-bottom: 16px;
      display: flex;
      gap: 12px;
    }
    .search-input {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      color: var(--fg-bright);
      font-size: 14px;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); }

    /* Zone Map visual */
    .zones-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
    }
    .zone-bar {
      display: flex;
      height: 32px;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .zone-seg {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 4px;
    }
    .zone-protected { background: #6e7681; }
    .zone-folded { background: var(--tier2); }
    .zone-compressible { background: var(--success); }

    .zone-legend {
      display: flex;
      gap: 20px;
      font-size: 12px;
      color: var(--muted);
    }
    .zone-legend-item { display: flex; align-items: center; gap: 6px; }
    .zone-legend-color { width: 12px; height: 12px; border-radius: 3px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg viewBox="0 0 24 24"><path d="M12 2L2 9l10 13 10-13-10-7zm0 3.2L18.4 9 12 18.2 5.6 9 12 5.2z"/></svg>
      <h1>Origami Context Dashboard</h1>
    </div>
    <div class="header-meta">
      <span class="badge" id="session-badge">Session: loading...</span>
      <span class="badge"><span class="status-dot"></span> Live</span>
    </div>
  </header>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Window Occupancy</div>
      <div class="kpi-value" id="kpi-occupancy">0%</div>
      <div class="kpi-sub" id="kpi-occupancy-sub">0 / 0 tokens</div>
      <div class="progress-bar"><div class="progress-fill" id="occupancy-fill" style="width: 0%"></div></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Growth Since Fold</div>
      <div class="kpi-value" id="kpi-growth">0t</div>
      <div class="kpi-sub" id="kpi-growth-sub">Threshold: 50.0K</div>
      <div class="progress-bar"><div class="progress-fill" id="growth-fill" style="width: 0%; background: var(--warning);"></div></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Tokens Reclaimed</div>
      <div class="kpi-value" id="kpi-saved" style="color: var(--success);">0t</div>
      <div class="kpi-sub" id="kpi-saved-sub">Across 0 fold(s)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Prompt Cache Read Rate</div>
      <div class="kpi-value" id="kpi-cache">0%</div>
      <div class="kpi-sub" id="kpi-cache-sub">Stable prefix retention</div>
    </div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('blocks')">Fold Blocks</button>
    <button class="tab-btn" onclick="switchTab('cache')">Cache Economics</button>
    <button class="tab-btn" onclick="switchTab('zones')">Context Zones</button>
    <button class="tab-btn" onclick="switchTab('search')">FTS5 Search</button>
  </div>

  <!-- Blocks Panel -->
  <div class="panel active" id="tab-blocks">
    <table>
      <thead>
        <tr>
          <th>Block</th>
          <th>Tier</th>
          <th>Topic</th>
          <th>Tokens</th>
          <th>Created</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="blocks-tbody">
        <tr><td colspan="6" style="text-align: center; color: var(--muted);">No fold blocks yet.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Cache Economics Panel -->
  <div class="panel" id="tab-cache">
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Total Input</th>
          <th>Cache Read</th>
          <th>Cache Write</th>
          <th>Hit Rate</th>
          <th>Fold Event</th>
        </tr>
      </thead>
      <tbody id="cache-tbody">
        <tr><td colspan="6" style="text-align: center; color: var(--muted);">No cache rounds recorded yet.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Zones Panel -->
  <div class="panel" id="tab-zones">
    <div class="zones-card">
      <div class="zone-bar" id="zones-bar">
        <div class="zone-seg zone-protected" style="flex: 1;">Head</div>
      </div>
      <div class="zone-legend">
        <div class="zone-legend-item"><span class="zone-legend-color zone-protected"></span> Protected (Head / In-Flight)</div>
        <div class="zone-legend-item"><span class="zone-legend-color zone-folded"></span> Folded Spans</div>
        <div class="zone-legend-item"><span class="zone-legend-color zone-compressible"></span> Compressible Runs</div>
      </div>
    </div>
  </div>

  <!-- Search Panel -->
  <div class="panel" id="tab-search">
    <div class="search-box">
      <input type="text" id="search-input" class="search-input" placeholder="Search blocks FTS5 (e.g. auth, tier:1, refactor)..." onkeyup="handleSearch(event)" />
      <button class="btn" onclick="runSearch()">Search</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Block</th>
          <th>Tier</th>
          <th>Topic</th>
          <th>Snippet</th>
        </tr>
      </thead>
      <tbody id="search-tbody">
        <tr><td colspan="4" style="text-align: center; color: var(--muted);">Type a search query above.</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    let activeTab = 'blocks';
    function switchTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.innerText.toLowerCase().includes(tab)));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
      refreshData();
    }

    function formatK(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    async function refreshData() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const st = await res.json();
        document.getElementById('session-badge').innerText = 'Session: ' + (st.sessionId || 'active');

        // KPIs
        const pct = Math.round(st.occupancyPct * 100);
        document.getElementById('kpi-occupancy').innerText = pct + '%';
        document.getElementById('kpi-occupancy-sub').innerText = formatK(st.liveTokens) + ' / ' + formatK(st.windowTokens) + ' tokens';
        document.getElementById('occupancy-fill').style.width = pct + '%';

        const gPct = Math.min(100, Math.round((st.growthSinceFold / st.growthStep) * 100));
        document.getElementById('kpi-growth').innerText = formatK(st.growthSinceFold) + 't';
        document.getElementById('kpi-growth-sub').innerText = 'Threshold: ' + formatK(st.growthStep) + ' (' + gPct + '%)';
        document.getElementById('growth-fill').style.width = gPct + '%';

        document.getElementById('kpi-saved').innerText = formatK(st.savedTokens) + 't';
        document.getElementById('kpi-saved-sub').innerText = 'Across ' + (st.blocks ? st.blocks.length : 0) + ' block(s)';

        // Zones bar
        if (st.zones && st.zones.length > 0) {
          const bar = document.getElementById('zones-bar');
          bar.innerHTML = st.zones.map(z => {
            const cls = 'zone-' + z.kind;
            return '<div class="zone-seg ' + cls + '" style="flex: 1;" title="' + z.start + '..' + z.end + ' (' + z.kind + ')">' + z.start + '..' + z.end + '</div>';
          }).join('');
        }

        // Blocks table
        const bRes = await fetch('/api/blocks');
        if (bRes.ok) {
          const blocks = await bRes.json();
          const tbody = document.getElementById('blocks-tbody');
          if (blocks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No fold blocks yet.</td></tr>';
          } else {
            tbody.innerHTML = blocks.map(b => {
              const tierCls = 'tag-tier tag-tier' + b.tier;
              return '<tr>' +
                '<td class="mono"><strong>' + b.block_id + '</strong></td>' +
                '<td><span class="' + tierCls + '">Tier ' + b.tier + '</span></td>' +
                '<td>' + escapeHtml(b.topic) + '</td>' +
                '<td class="mono">' + formatK(b.tokens_before) + 't → ' + formatK(b.tokens_after) + 't</td>' +
                '<td class="mono">' + new Date(b.created_at).toLocaleTimeString() + '</td>' +
                '<td><button class="btn btn-sm" onclick="unfoldBlock(\\'' + b.block_id + '\\')">Unfold (File)</button></td>' +
                '</tr>';
            }).join('');
          }
        }

        // Rounds table
        const rRes = await fetch('/api/rounds');
        if (rRes.ok) {
          const rounds = await rRes.json();
          let totalIn = 0, totalRead = 0;
          for (const r of rounds) { totalIn += r.total_in; totalRead += r.cache_read; }
          const hitPct = totalIn > 0 ? Math.round((totalRead / totalIn) * 100) : 0;
          document.getElementById('kpi-cache').innerText = hitPct + '%';
          document.getElementById('kpi-cache-sub').innerText = formatK(totalRead) + ' / ' + formatK(totalIn) + ' cache read';

          const tbody = document.getElementById('cache-tbody');
          if (rounds.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No cache rounds recorded yet.</td></tr>';
          } else {
            tbody.innerHTML = rounds.slice(-20).reverse().map(r => {
              const rHit = r.total_in > 0 ? Math.round((r.cache_read / r.total_in) * 100) : 0;
              return '<tr>' +
                '<td class="mono">' + new Date(r.ts).toLocaleTimeString() + '</td>' +
                '<td class="mono">' + formatK(r.total_in) + '</td>' +
                '<td class="mono" style="color: var(--success);">' + formatK(r.cache_read) + '</td>' +
                '<td class="mono" style="color: var(--warning);">' + formatK(r.cache_write) + '</td>' +
                '<td class="mono">' + rHit + '%</td>' +
                '<td class="mono">' + (r.fold_event_id ? '<span class="badge">' + r.fold_event_id + '</span>' : '—') + '</td>' +
                '</tr>';
            }).join('');
          }
        }
      } catch (err) {
        console.error('Refresh error', err);
      }
    }

    async function unfoldBlock(id) {
      if (!confirm('Unfold block ' + id + ' to artifact file?')) return;
      const res = await fetch('/api/unfold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode: 'file' })
      });
      const data = await res.json();
      if (data.ok) alert('Block ' + id + ' unfolded to:\\n' + data.path);
      else alert('Unfold failed: ' + (data.error || 'unknown error'));
      refreshData();
    }

    async function runSearch() {
      const q = document.getElementById('search-input').value.trim();
      if (!q) return;
      const res = await fetch('/api/search?q=' + encodeURIComponent(q));
      if (!res.ok) return;
      const hits = await res.json();
      const tbody = document.getElementById('search-tbody');
      if (hits.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--muted);">No matches for "' + escapeHtml(q) + '".</td></tr>';
      } else {
        tbody.innerHTML = hits.map(h => {
          return '<tr>' +
            '<td class="mono"><strong>' + h.blockId + '</strong></td>' +
            '<td><span class="tag-tier tag-tier' + h.tier + '">Tier ' + h.tier + '</span></td>' +
            '<td>' + escapeHtml(h.topic) + '</td>' +
            '<td class="mono">' + escapeHtml(h.snippet || '') + '</td>' +
            '</tr>';
        }).join('');
      }
    }

    function handleSearch(e) {
      if (e.key === 'Enter') runSearch();
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Connect SSE for live updates
    const events = new EventSource('/api/events');
    events.addEventListener('fold', () => refreshData());
    events.addEventListener('unfold', () => refreshData());
    events.addEventListener('round', () => refreshData());

    // Initial load + periodic polling fallback
    refreshData();
    setInterval(refreshData, 3000);
  </script>
</body>
</html>`;
}
