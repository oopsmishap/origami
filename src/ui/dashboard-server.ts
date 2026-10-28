type BunServer = ReturnType<typeof Bun.serve>;
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { openDb, type DbBlockRow, type OrigamiDb } from "../persist/db.ts";
import type { SessionRecord, SessionRegistry } from "../sessions.ts";
const TOKEN_HEADER = "X-Origami-Token";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string | null, right: string): boolean {
  const candidate = left ?? "";
  let difference = candidate.length ^ right.length;
  const length = Math.max(candidate.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (candidate.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}


export interface DashboardServerOptions {
  port?: number;
  host?: string;
  /** Every session in the process; the UI picks one via `?session=` (default: primary). */
  registry: SessionRegistry;
  openBrowser?: boolean;
}

export interface DashboardInstance {
  url: string;
  token: string;
  port: number;
  server: BunServer;
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

function parseJsonArray(text: string): unknown[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Persisted block row in the client's shape (coverage string, children array). */
function dbBlockView(row: DbBlockRow) {
  const ranges = parseJsonArray(row.ranges) as { start: string; end: string }[];
  return {
    ...row,
    coverage: ranges.map((r) => `${r.start}..${r.end}`).join(", "),
    children: parseJsonArray(row.children) as string[],
  };
}

function sessionMeta(record: SessionRecord | undefined, registry: SessionRegistry) {
  if (!record) return { session: null };
  return { session: registry.summary(record) };
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardInstance> {
  const initialPort = opts.port ?? 3780;
  const host = opts.host ?? "127.0.0.1";
  const token = randomToken();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const registry = opts.registry;

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

  // Every session's events reach every tab, tagged with their session; clients filter.
  const unsubscribe = registry.subscribe((event, sessionId, data) => {
    broadcast(event, { sessionId, data });
  });

  /** History reads: live session's db, else the process-shared handle, else a private one. */
  function withDb<T>(record: SessionRecord | undefined, fn: (db: OrigamiDb) => T): T {
    const shared = record?.runtime?.db ?? registry.sharedDb();
    if (shared) return fn(shared);
    const own = openDb(`${getAgentDir()}/origami.db`);
    try {
      return fn(own);
    } finally {
      own.close();
    }
  }

  let server: BunServer | null = null;
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
          const requested = url.searchParams.get("session");
          const record = requested ? registry.get(requested) : registry.primary();
          const rt = record?.runtime ?? null;
          const sessionId = record?.sessionId ?? requested ?? "";

          const allowedHosts = new Set([`127.0.0.1:${tryPort}`, `localhost:${tryPort}`]);
          const allowedOrigins = new Set([`http://127.0.0.1:${tryPort}`, `http://localhost:${tryPort}`]);
          const jsonError = (status: number, error: string) => Response.json({ error }, { status });

          if (!allowedHosts.has(req.headers.get("host") ?? "")) return jsonError(403, "forbidden host");
          const origin = req.headers.get("origin");
          if (origin !== null && !allowedOrigins.has(origin)) return jsonError(403, "forbidden origin");
          if (req.method === "OPTIONS") return jsonError(403, "cross-origin preflight forbidden");

          if (path.startsWith("/api/")) {
            const suppliedToken = path === "/api/events" ? url.searchParams.get("token") : req.headers.get(TOKEN_HEADER);
            if (!constantTimeEqual(suppliedToken, token)) return jsonError(401, "unauthorized");
          }

          if ((path === "/api/unfold" || path === "/api/fold") && req.method === "POST") {
            if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
              return jsonError(415, "content type must be application/json");
            }
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
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          // 2. Session tree
          if (path === "/api/sessions") {
            return Response.json({ primary: registry.primary()?.sessionId ?? null, tree: registry.tree() });
          }

          if (requested && !record && path !== "/api/blocks" && path !== "/api/rounds") {
            return jsonError(404, `unknown session ${requested}`);
          }

          // 3. Status API (ended sessions serve their last snapshot)
          if (path === "/api/status") {
            let report = record?.lastStatus ?? null;
            let recommended: unknown[] = [];
            if (rt) {
              rt.sync();
              report = rt.engine.status();
              recommended = rt.engine.recommendedRanges();
            }
            if (!report) return jsonError(503, "no active session");
            return Response.json({
              sessionId,
              ...sessionMeta(record, registry),
              liveTokens: report.usedTokens,
              conversationTokens: report.tokenSplit.live,
              baselineTokens: report.tokenSplit.overhead + report.tokenSplit.system,
              savedTokens: report.tokenSplit.foldedSavings,
              recommended,
              ...report,
            });
          }

          // 4. Blocks API (persisted rows, overlaid with the live fold tree when the session is running)
          if (path === "/api/blocks") {
            const rows = sessionId ? withDb(record, (db) => db.blocksForSession(sessionId)).map(dbBlockView) : [];
            if (!rt) return Response.json(rows);
            rt.sync();
            const treeMap = new Map(rt.engine.state.tree.all().map((b) => [b.id, b]));
            const merged = rows.map((row) => {
              const live = treeMap.get(row.block_id);
              treeMap.delete(row.block_id);
              if (!live) return row;
              return {
                ...row,
                coverage: live.ranges.map((r) => `${r.start}..${r.end}`).join(", "),
                children: [...live.children],
                status: live.status,
                consumed_by: live.consumedBy,
              };
            });
            for (const leftover of treeMap.values()) {
              merged.push({
                session_id: sessionId,
                block_id: leftover.id,
                tier: leftover.tier,
                topic: leftover.topic,
                summary: leftover.summary,
                body: `${leftover.topic}\n${leftover.summary}`,
                tokens_before: leftover.tokensBefore,
                tokens_after: leftover.tokensAfter,
                created_at: leftover.createdAt,
                ranges: JSON.stringify(leftover.ranges),
                coverage: leftover.ranges.map((r) => `${r.start}..${r.end}`).join(", "),
                children: [...leftover.children],
                status: leftover.status,
                consumed_by: leftover.consumedBy,
              });
            }
            merged.sort((a, b) => a.created_at - b.created_at);
            return Response.json(merged);
          }

          // 5. Cache Rounds API
          if (path === "/api/rounds") {
            return Response.json(sessionId ? withDb(record, (db) => db.roundsForSession(sessionId)) : []);
          }

          // 6. Search API (all sessions)
          if (path === "/api/search") {
            const q = url.searchParams.get("q") ?? "";
            const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
            const searcher = rt ?? registry.primary()?.runtime ?? null;
            if (!searcher) return Response.json({ blocks: [], messages: [] });
            return Response.json({
              blocks: searcher.engine.search(q, limit),
              messages: searcher.engine.searchMessages(q, limit),
            });
          }

          const jsonObject = async (): Promise<Record<string, unknown> | Response> => {
            let value: unknown;
            try {
              value = await req.json();
            } catch {
              return jsonError(400, "request body must be valid JSON");
            }
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
              return jsonError(400, "request body must be a JSON object");
            }
            return value as Record<string, unknown>;
          };

          // 7. Action: Unfold
          if (path === "/api/unfold" && req.method === "POST") {
            if (!rt) return jsonError(409, "session is not running");
            const body = await jsonObject();
            if (body instanceof Response) return body;
            if (typeof body.id !== "string" || body.id.trim() === "") return jsonError(400, "id must be a non-empty string");
            if (body.mode !== undefined && body.mode !== "file" && body.mode !== "inline") return jsonError(400, "mode must be file or inline");
            rt.sync();
            if (body.mode === "inline") {
              const res = rt.engine.executeUnfold(body.id);
              registry.emit("unfold", sessionId, { id: body.id, mode: "inline", res });
              return Response.json(res);
            }
            const res = await rt.engine.unfoldArtifact(body.id);
            registry.emit("unfold", sessionId, { id: body.id, mode: "file", res });
            return Response.json(res);
          }

          // 8. Action: Manual Fold
          if (path === "/api/fold" && req.method === "POST") {
            if (!rt) return jsonError(409, "session is not running");
            const body = await jsonObject();
            if (body instanceof Response) return body;
            for (const field of ["range", "topic", "summary"] as const) {
              if (typeof body[field] !== "string" || body[field].trim() === "") return jsonError(400, `${field} must be a non-empty string`);
            }
            if (body.tier !== undefined && body.tier !== 1 && body.tier !== 2 && body.tier !== 3) return jsonError(400, "tier must be 1, 2, or 3");
            rt.sync();
            const res = rt.engine.executeFold({
              folds: [{ range: body.range as string, topic: body.topic as string, summary: body.summary as string }],
              tier: body.tier as 1 | 2 | 3 | undefined,
            });
            registry.emit("fold", sessionId, { res });
            return Response.json(res);
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
    unsubscribe();
    throw new Error(`Failed to bind origami dashboard server on ports ${initialPort}..${initialPort + 9}`);
  }

  const url = `http://${host}:${activePort}/?token=${token}`;
  if (opts.openBrowser !== false) {
    openUrl(url);
  }

  return {
    url,
    token,
    port: activePort,
    server,
    broadcast,
    stop() {
      unsubscribe();
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
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Origami Context Dashboard · oh-my-pi</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Cdefs%3E%3CclipPath id='c'%3E%3Cpath d='M 43.75 69.03 Q 42 66 45.39 65.13 L 194.61 26.87 Q 198 26 199.75 29.03 L 226.5 75.4 Q 228 78 226.23 80.42 L 184 138 L 212.25 186.97 Q 214 190 210.61 190.87 L 61.39 229.13 Q 58 230 56.25 226.97 L 29.5 180.6 Q 28 178 29.77 175.58 L 72 118 Z'/%3E%3C/clipPath%3E%3ClinearGradient id='p' x1='120' y1='46' x2='134' y2='102' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0%25' stop-color='%23DDD6FE'/%3E%3Cstop offset='45%25' stop-color='%238B5CF6'/%3E%3Cstop offset='100%25' stop-color='%236D28D9'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='150' y1='98' x2='161' y2='143' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0%25' stop-color='%23064E3B'/%3E%3Cstop offset='22%25' stop-color='%23059669'/%3E%3Cstop offset='72%25' stop-color='%2334D399'/%3E%3Cstop offset='100%25' stop-color='%23059669'/%3E%3C/linearGradient%3E%3ClinearGradient id='o' x1='106' y1='158' x2='120' y2='214' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0%25' stop-color='%23EA580C'/%3E%3Cstop offset='42%25' stop-color='%23F97316'/%3E%3Cstop offset='100%25' stop-color='%23FDBA74'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg clip-path='url(%23c)'%3E%3Cpolygon points='70,116 230,76 186,140 26,180' fill='url(%23g)'/%3E%3Cpolygon points='40,64 200,24 230,78 72,118' fill='url(%23p)'/%3E%3Cpolygon points='28,178 184,138 216,192 56,232' fill='url(%23o)'/%3E%3Cline x1='72' y1='118' x2='228' y2='78' stroke='%23FFF' stroke-opacity='0.6' stroke-width='2.2'/%3E%3Cline x1='28' y1='178' x2='184' y2='138' stroke='%23022C22' stroke-opacity='0.6' stroke-width='2.4'/%3E%3C/g%3E%3C/svg%3E" />
  <style>
    :root {
      --bg-page: #0a0a0f;
      --bg-surface: #111118;
      --bg-elevated: #16161e;
      --bg-hover: #1c1c26;
      --border-subtle: rgba(255, 255, 255, 0.06);
      --border-default: rgba(255, 255, 255, 0.10);
      --border-strong: rgba(255, 255, 255, 0.18);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #06b6d4;
      --accent-cyan: #06b6d4;
      --accent-violet: #8b5cf6;
      --accent-pink: #ec4899;
      --accent-green: #10b981;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --border: rgba(255, 255, 255, 0.08);
      --shadow-card: 0 4px 24px rgba(0, 0, 0, 0.35);
      --font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    html[data-theme="light"] {
      --bg-page: #f8fafc;
      --bg-surface: #ffffff;
      --bg-elevated: #f1f5f9;
      --bg-hover: #e2e8f0;
      --border-subtle: rgba(15, 23, 42, 0.06);
      --border-default: rgba(15, 23, 42, 0.12);
      --border-strong: rgba(15, 23, 42, 0.22);
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --accent: #0891b2;
      --accent-cyan: #0891b2;
      --accent-violet: #7c3aed;
      --accent-pink: #db2777;
      --accent-green: #059669;
      --accent-amber: #d97706;
      --accent-red: #dc2626;
      --border: rgba(15, 23, 42, 0.10);
      --shadow-card: 0 2px 12px rgba(15, 23, 42, 0.06);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-page);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 13.5px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* Top Header Chrome (omp stats style) */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 24px;
      background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-default);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex: none;
    }
    .brand-mark svg { width: 18px; height: 18px; display: block; }
    .brand-title {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }
    .omp-tag {
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
    }

    /* Segmented Pill Tabs */
    .seg-tabs {
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 3px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 9px;
    }
    .seg-tab {
      background: none;
      border: none;
      color: var(--text-secondary);
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 550;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .seg-tab:hover { color: var(--text-primary); }
    .seg-tab.active {
      background: var(--bg-surface);
      color: var(--text-primary);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-default);
    }
    .tab-count {
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 0 5px;
      border-radius: 999px;
      background: var(--bg-hover);
      color: var(--text-muted);
    }
    .seg-tab.active .tab-count {
      color: var(--accent-cyan);
    }

    .header-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-family: var(--font-mono);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
    }
    select.chip {
      appearance: none;
      cursor: pointer;
      max-width: 420px;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-green);
      box-shadow: 0 0 8px var(--accent-green);
    }
    .status-dot.offline {
      background: var(--accent-amber);
      box-shadow: none;
    }

    /* Main Container */
    .shell {
      max-width: 1380px;
      margin: 0 auto;
      padding: 20px 24px 48px;
    }

    /* KPI Strip */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    @media (max-width: 1024px) {
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .topbar { flex-wrap: wrap; }
      .seg-tabs { order: 3; width: 100%; overflow-x: auto; }
    }
    @media (max-width: 600px) {
      .kpi-grid { grid-template-columns: 1fr; }
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      padding: 15px 17px;
      box-shadow: var(--shadow-card);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .kpi-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 700;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
    .meter-track {
      width: 100%;
      height: 6px;
      background: var(--bg-elevated);
      border-radius: 999px;
      margin-top: 10px;
      overflow: hidden;
      display: flex;
    }
    .meter-seg {
      height: 100%;
      transition: width 0.25s ease;
    }

    /* Panels & Cards */
    .panel { display: none; }
    .panel.active { display: block; }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
      margin-bottom: 16px;
      overflow: hidden;
    }
    .card-h {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 18px;
      border-bottom: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }
    .card-title {
      font-size: 13.5px;
      font-weight: 650;
      color: var(--text-primary);
    }
    .card-hint {
      font-size: 12px;
      color: var(--text-muted);
    }
    .card-b {
      padding: 16px 18px;
    }

    /* Overview Grid */
    .overview-split {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(300px, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1080px) {
      .overview-split { grid-template-columns: 1fr; }
    }
    /* Origami Vault Grid */
    .vault-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .vault-tile {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
    }
    .vault-tile-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .vault-tile-val {
      font-size: 17px;
      font-weight: 700;
      color: var(--text-primary);
    }
    .vault-tile-sub {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 3px;
    }

    /* billion-context Trajectory & Hit-Rate Charts */
    .chart-wrap { width: 100%; overflow-x: auto; position: relative; }
    .chart-svg { width: 100%; height: auto; display: block; }
    #traj-chart, #hit-chart { cursor: crosshair; user-select: none; }
    .chart-status {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding: 6px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
    }
    .chart-status[hidden] { display: none !important; }
    .chart-brush {
      position: absolute;
      background: rgba(6, 182, 212, 0.16);
      border-left: 1.5px solid var(--accent-cyan);
      border-right: 1.5px solid var(--accent-cyan);
      pointer-events: none;
    }
    .chart-legend {
      display: flex;
      gap: 14px;
      font-size: 11.5px;
      color: var(--text-secondary);
      margin-top: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .chart-legend .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 3px;
      margin-right: 5px;
      vertical-align: -1px;
    }
    .chart-zoom-note {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .chart-empty {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }

    /* Window Composition List */
    .comp-bar {
      display: flex;
      height: 12px;
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-elevated);
      margin-bottom: 14px;
      border: 1px solid var(--border-subtle);
    }
    .comp-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .comp-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 12.5px;
      padding: 4px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .comp-row:last-child { border-bottom: none; }
    .comp-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
    }
    .swatch {
      width: 9px;
      height: 9px;
      border-radius: 2px;
      flex: none;
    }
    .comp-val {
      font-family: var(--font-mono);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--text-primary);
    }
    .comp-pct {
      color: var(--text-muted);
      margin-left: 6px;
      display: inline-block;
      min-width: 44px;
      text-align: right;
    }

    /* Tables */
    .table-wrap { width: 100%; overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }
    th {
      background: var(--bg-elevated);
      font-weight: 600;
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    th.num, td.num {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }
    tr:last-child td { border-bottom: none; }
    tbody tr.clickable { cursor: pointer; transition: background 0.12s; }
    tbody tr.clickable:hover td { background: var(--bg-hover); }
    tbody tr.inactive-row td { opacity: 0.6; }

    /* Pills & Buttons */
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .tag-tier {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .tag-tier1 { background: rgba(6, 182, 212, 0.14); color: var(--accent-cyan); border: 1px solid rgba(6, 182, 212, 0.28); }
    .tag-tier2 { background: rgba(139, 92, 246, 0.14); color: var(--accent-violet); border: 1px solid rgba(139, 92, 246, 0.28); }
    .tag-tier3 { background: rgba(245, 158, 11, 0.14); color: var(--accent-amber); border: 1px solid rgba(245, 158, 11, 0.28); }

    .status-pill {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .status-live { background: rgba(16, 185, 129, 0.14); color: var(--accent-green); }
    .status-consumed { background: var(--bg-elevated); color: var(--text-muted); }
    .status-unfolded { background: rgba(245, 158, 11, 0.14); color: var(--accent-amber); }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-weight: 550;
      transition: all 0.15s ease;
    }
    .btn:hover { background: var(--bg-hover); border-color: var(--accent-cyan); color: var(--accent-cyan); }
    .btn-primary {
      background: rgba(6, 182, 212, 0.15);
      border-color: rgba(6, 182, 212, 0.4);
      color: var(--accent-cyan);
    }
    .btn-primary:hover { background: rgba(6, 182, 212, 0.25); }
    .btn-sm { padding: 3px 9px; font-size: 11.5px; }

    /* Proportional Zone Bar */
    .zone-bar {
      display: flex;
      height: 34px;
      border-radius: var(--radius-sm);
      overflow: hidden;
      margin-bottom: 14px;
      border: 1px solid var(--border-default);
      gap: 1px;
      background: var(--bg-page);
    }
    .zone-seg {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 600;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 6px;
      min-width: 18px;
    }
    .zone-protected { background: #475569; }
    .zone-folded { background: var(--accent-violet); }
    .zone-compressible { background: var(--accent-green); }

    /* Search */
    .search-toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1;
      min-width: 220px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      padding: 8px 13px;
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent-cyan); }

    /* Slide-over Block Detail Drawer (omp stats RequestDetail pattern) */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 50;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease;
    }
    .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(560px, 94vw);
      background: var(--bg-surface);
      border-left: 1px solid var(--border-strong);
      box-shadow: none;
      pointer-events: none;
      z-index: 51;
      transform: translateX(calc(100% + 4px));
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
    }
    .drawer.open {
      transform: translateX(0);
      pointer-events: auto;
      box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
    }
    .drawer-head {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-default);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .drawer-body {
      padding: 18px 20px;
      overflow-y: auto;
      flex: 1;
    }
    .drawer-kv {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px 14px;
      font-size: 12.5px;
      padding-bottom: 14px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .drawer-kv .k { color: var(--text-muted); }
    .drawer-summary {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-primary);
    }
    .drawer-foot {
      padding: 12px 20px;
      border-top: 1px solid var(--border-default);
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      background: var(--bg-elevated);
    }

    /* Toast Host */
    .toast-host {
      position: fixed;
      bottom: 18px;
      right: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 80;
    }
    .toast {
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      border-left: 3px solid var(--accent-cyan);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      font-size: 12.5px;
      color: var(--text-primary);
      box-shadow: var(--shadow-card);
      max-width: 400px;
      word-break: break-word;
    }
    .toast.ok { border-left-color: var(--accent-green); }
    .toast.err { border-left-color: var(--accent-red); }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark" title="Origami">
        <svg viewBox="0 0 256 256" width="18" height="18">
          <defs>
            <clipPath id="og-nav-clip">
              <path d="M 43.75 69.03 Q 42 66 45.39 65.13 L 194.61 26.87 Q 198 26 199.75 29.03 L 226.5 75.4 Q 228 78 226.23 80.42 L 184 138 L 212.25 186.97 Q 214 190 210.61 190.87 L 61.39 229.13 Q 58 230 56.25 226.97 L 29.5 180.6 Q 28 178 29.77 175.58 L 72 118 Z"/>
            </clipPath>
            <linearGradient id="og-nav-p" x1="120" y1="46" x2="134.4" y2="102" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#DDD6FE"/><stop offset="45%" stop-color="#8B5CF6"/><stop offset="100%" stop-color="#6D28D9"/>
            </linearGradient>
            <linearGradient id="og-nav-g" x1="150" y1="98" x2="161.7" y2="143.7" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#064E3B"/><stop offset="22%" stop-color="#059669"/><stop offset="72%" stop-color="#34D399"/><stop offset="100%" stop-color="#059669"/>
            </linearGradient>
            <linearGradient id="og-nav-o" x1="106" y1="158" x2="120.4" y2="214" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#EA580C"/><stop offset="42%" stop-color="#F97316"/><stop offset="100%" stop-color="#FDBA74"/>
            </linearGradient>
            <linearGradient id="og-nav-r" x1="72" y1="118" x2="228" y2="78" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.78"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.35"/>
            </linearGradient>
            <linearGradient id="og-nav-v" x1="28" y1="178" x2="184" y2="138" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#022C22" stop-opacity="0.45"/><stop offset="50%" stop-color="#022C22" stop-opacity="0.72"/><stop offset="100%" stop-color="#022C22" stop-opacity="0.40"/>
            </linearGradient>
          </defs>
          <g clip-path="url(#og-nav-clip)">
            <polygon points="70,116 230,76 186,140 26,180" fill="url(#og-nav-g)"/>
            <polygon points="72,118 228,78 28,178" fill="#FFFFFF" fill-opacity="0.06"/>
            <polygon points="40,64 200,24 230,78 72,118" fill="url(#og-nav-p)"/>
            <polygon points="42,66 198,26 72,118" fill="#FFFFFF" fill-opacity="0.09"/>
            <polygon points="28,178 184,138 216,192 56,232" fill="url(#og-nav-o)"/>
            <polygon points="28,178 214,190 58,230" fill="#FFFFFF" fill-opacity="0.09"/>
            <line x1="72" y1="118" x2="228" y2="78" stroke="url(#og-nav-r)" stroke-width="2.2" stroke-linecap="round"/>
            <line x1="28" y1="178" x2="184" y2="138" stroke="url(#og-nav-v)" stroke-width="2.4" stroke-linecap="round"/>
          </g>
        </svg>
      </div>
      <span class="brand-title">Origami Context Dashboard</span>
      <span class="omp-tag">oh-my-pi</span>
    </div>

    <nav class="seg-tabs" role="tablist">
      <button class="seg-tab active" data-tab="overview" onclick="switchTab('overview')">Overview</button>
      <button class="seg-tab" data-tab="blocks" onclick="switchTab('blocks')">Fold Blocks <span class="tab-count" id="cnt-blocks">0</span></button>
      <button class="seg-tab" data-tab="cache" onclick="switchTab('cache')">Cache Economics <span class="tab-count" id="cnt-rounds">0</span></button>
      <button class="seg-tab" data-tab="zones" onclick="switchTab('zones')">Context Zones</button>
      <button class="seg-tab" data-tab="search" onclick="switchTab('search')">FTS5 Search</button>
    </nav>

    <div class="header-meta">
      <select class="chip" id="session-select" title="Session (subagents are nested under their parent)" onchange="selectSession(this.value)">
        <option value="">session: —</option>
      </select>
      <span class="chip"><span class="status-dot" id="sse-dot"></span> <span id="sse-label">Live</span></span>
      <button class="btn btn-sm" onclick="toggleTheme()" id="theme-btn" title="Switch light/dark theme">Theme</button>
    </div>
  </header>

  <main class="shell">
    <!-- KPI Strip -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-head"><span>Window Occupancy</span><span id="kpi-nudge-pill" class="mono"></span></div>
        <div class="kpi-value" id="kpi-occupancy">0%</div>
        <div class="kpi-sub" id="kpi-occupancy-sub">0 / 0 tokens</div>
        <div class="meter-track" id="occupancy-meter">
          <div class="meter-seg" style="width: 0%; background: var(--accent-cyan);"></div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-head"><span>Growth Since Fold</span></div>
        <div class="kpi-value" id="kpi-growth">0t</div>
        <div class="kpi-sub" id="kpi-growth-sub">Step threshold: 50.0K</div>
        <div class="meter-track">
          <div class="meter-seg" id="growth-fill" style="width: 0%; background: var(--accent-amber);"></div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-head"><span>Tokens Reclaimed</span></div>
        <div class="kpi-value" id="kpi-saved" style="color: var(--accent-green);">0t</div>
        <div class="kpi-sub" id="kpi-saved-sub">Across 0 live block(s)</div>
        <div class="meter-track">
          <div class="meter-seg" id="saved-fill" style="width: 0%; background: var(--accent-green);"></div>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-head"><span>Prompt Cache Read Rate</span></div>
        <div class="kpi-value" id="kpi-cache">—</div>
        <div class="kpi-sub" id="kpi-cache-sub">Waiting for model rounds</div>
        <div class="meter-track">
          <div class="meter-seg" id="cache-fill" style="width: 0%; background: var(--accent-violet);"></div>
        </div>
      </div>
    </div>

    <!-- TAB 1: Overview & Context Trajectory -->
    <section class="panel active" id="tab-overview">
      <div class="overview-split">
        <div>
          <!-- billion-context Context Trajectory Graph -->
          <div class="card">
            <div class="card-h">
              <span class="card-title">Context Trajectory</span>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="card-hint">Per-request input tokens &amp; cached prefix area &middot; red dashed marks are compression folds</span>
                <button class="btn btn-sm" id="traj-scale-btn" type="button" onclick="toggleTrajScale()" title="Toggle Y-axis between active token band and full context window ceiling">Y: Auto</button>
              </div>
            </div>
            <div class="card-b">
              <div class="chart-status" id="traj-status" hidden></div>
              <div class="chart-wrap" id="traj-chart">
                <div class="chart-empty">No usage samples recorded for this session yet.</div>
              </div>
              <div class="chart-legend" id="traj-legend" hidden></div>
              <div class="chart-zoom-note" id="traj-hint" hidden>
                Drag across either chart to zoom into a sample range — trajectory and hit-rate views stay linked; double-click or press Esc to reset.
              </div>
            </div>
          </div>

          <!-- billion-context Linked Cache Hit-Rate Graph -->
          <div class="card">
            <div class="card-h">
              <span class="card-title">Cache Hit Rate Trend</span>
              <span class="card-hint">Per-request prompt cache hit % · dips colored by ledger miss attribution</span>
            </div>
            <div class="card-b">
              <div class="chart-status" id="hit-status" hidden></div>
              <div class="chart-wrap" id="hit-chart">
                <div class="chart-empty">No cache rounds recorded for this session yet.</div>
              </div>
              <div class="chart-legend" id="hit-legend" hidden></div>
            </div>
          </div>
        </div>

        <div>
          <!-- Window Composition Card -->
          <div class="card">
            <div class="card-h">
              <span class="card-title">Window Composition</span>
              <span class="card-hint" id="comp-total-hint">0 tokens</span>
            </div>
            <div class="card-b">
              <div class="comp-bar" id="comp-bar"></div>
              <div class="comp-list" id="comp-list"></div>
            </div>
          </div>
          <!-- Origami Vault Storage Card -->
          <div class="card">
            <div class="card-h">
              <span class="card-title">Origami Vault Storage</span>
              <span class="card-hint" id="vault-ratio-hint">1.0× compression</span>
            </div>
            <div class="card-b">
              <div class="vault-grid">
                <div class="vault-tile">
                  <div class="vault-tile-label">Archived Stored</div>
                  <div class="vault-tile-val mono" id="vault-archived">0t</div>
                  <div class="vault-tile-sub" id="vault-archived-sub">0 msgs preserved</div>
                </div>
                <div class="vault-tile">
                  <div class="vault-tile-label">Active Summaries</div>
                  <div class="vault-tile-val mono" id="vault-summaries" style="color:var(--accent-green)">0t</div>
                  <div class="vault-tile-sub" id="vault-summaries-sub">0 live blocks</div>
                </div>
                <div class="vault-tile">
                  <div class="vault-tile-label">Compression Ratio</div>
                  <div class="vault-tile-val mono" id="vault-ratio" style="color:var(--accent-cyan)">1.0×</div>
                  <div class="vault-tile-sub" id="vault-ratio-sub">0% reduction</div>
                </div>
                <div class="vault-tile">
                  <div class="vault-tile-label">Reclaimed Space</div>
                  <div class="vault-tile-val mono" id="vault-saved" style="color:var(--accent-amber)">0t</div>
                  <div class="vault-tile-sub" id="vault-saved-sub">Net prompt savings</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Recommended Fold Candidates Card -->
          <div class="card">
            <div class="card-h">
              <span class="card-title">Compressible Candidates</span>
              <span class="card-hint" id="cand-floor-hint">Floor: —</span>
            </div>
            <div class="card-b" id="cand-body">
              <div class="card-hint">No candidate ranges above floor yet.</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: Fold Blocks -->
    <section class="panel" id="tab-blocks">
      <div class="card">
        <div class="card-h">
          <span class="card-title">Fold Block Hierarchy</span>
          <span class="card-hint">Click any block to inspect its full summary, lineage, or unfold</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Block</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Coverage</th>
                <th>Topic</th>
                <th class="num">Compression</th>
                <th class="num">Created</th>
                <th class="num">Actions</th>
              </tr>
            </thead>
            <tbody id="blocks-tbody">
              <tr><td colspan="8" class="chart-empty">No fold blocks yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: Cache Economics -->
    <section class="panel" id="tab-cache">
      <div class="card">
        <div class="card-h">
          <span class="card-title">Per-Request Cache Ledger</span>
          <span class="card-hint">Prompt cache reads, writes, hit rates, and fold rebuild attribution</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="num">#</th>
                <th>Timestamp</th>
                <th class="num">Total Input</th>
                <th class="num">Cache Read</th>
                <th class="num">Cache Write</th>
                <th class="num">Missed</th>
                <th class="num">Hit Rate</th>
                <th>Attribution</th>
              </tr>
            </thead>
            <tbody id="cache-tbody">
              <tr><td colspan="8" class="chart-empty">No cache rounds recorded yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 4: Context Zones -->
    <section class="panel" id="tab-zones">
      <div class="card">
        <div class="card-h">
          <span class="card-title">Token-Weighted Context Zones</span>
          <span class="card-hint">Proportional span widths by active window tokens</span>
        </div>
        <div class="card-b">
          <div class="zone-bar" id="zones-bar">
            <div class="zone-seg zone-protected" style="flex: 1;">Head</div>
          </div>
          <div class="chart-legend" style="margin-bottom: 16px;">
            <span><span class="dot" style="background:#475569"></span>Protected (Pinned Head / Active Turn)</span>
            <span><span class="dot" style="background:var(--accent-violet)"></span>Folded Summary Spans</span>
            <span><span class="dot" style="background:var(--accent-green)"></span>Compressible Conversation Runs</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zone Kind</th>
                  <th>Message Span</th>
                  <th class="num">Messages</th>
                  <th class="num">Tokens</th>
                  <th class="num">Zone Share</th>
                </tr>
              </thead>
              <tbody id="zones-tbody">
                <tr><td colspan="5" class="chart-empty">No zones bound yet.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 5: FTS5 Search -->
    <section class="panel" id="tab-search">
      <div class="card">
        <div class="card-h">
          <span class="card-title">FTS5 Fold Memory Search</span>
          <span class="card-hint">Supports full-text terms plus <code>tier:1</code>, <code>tier:2</code>, and <code>session:...</code> filters</span>
        </div>
        <div class="card-b">
          <div class="search-toolbar">
            <input type="text" id="search-input" class="search-input" placeholder="Search folded topics & summaries (e.g. auth, tier:1, occupancy)..." oninput="debouncedSearch()" onkeydown="if(event.key==='Enter') runSearch()" />
            <button class="btn btn-primary" onclick="runSearch()">Search</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Tier</th>
                  <th>Topic</th>
                  <th>Matched Snippet</th>
                </tr>
              </thead>
              <tbody id="search-tbody">
                <tr><td colspan="4" class="chart-empty">Enter search terms above to query SQLite FTS5 index.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- Slide-Over Block Inspector Drawer -->
  <div class="drawer-backdrop" id="drawer-backdrop" onclick="closeDrawer()"></div>
  <aside class="drawer" id="block-drawer" aria-hidden="true">
    <div class="drawer-head">
      <div id="drawer-title" class="card-title">Block Detail</div>
      <button class="btn btn-sm" onclick="closeDrawer()">Esc · Close</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-kv" id="drawer-kv"></div>
      <div class="drawer-summary" id="drawer-summary"></div>
    </div>
    <div class="drawer-foot" id="drawer-foot"></div>
  </aside>

  <div class="toast-host" id="toast-host"></div>

  <script>
    const $ = (id) => document.getElementById(id);
    const tokenParams = new URLSearchParams(location.search);
    const queryToken = tokenParams.get('token');
    const dashboardToken = queryToken || sessionStorage.getItem('origami-dashboard-token') || '';
    if (queryToken) sessionStorage.setItem('origami-dashboard-token', queryToken);
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    const authHeaders = () => ({ 'X-Origami-Token': dashboardToken });
    const apiFetch = (url, options) => {
      const request = options ? { ...options } : {};
      request.headers = { ...authHeaders(), ...(request.headers || {}) };
      return fetch(url, request);
    };

    // Session focus: '' follows the primary (main) session; otherwise pinned to one id.
    let pinnedSession = sessionStorage.getItem('origami-session') || '';
    let primarySession = '';
    let sessionSignature = '';
    let refreshSeq = 0;
    const targetSession = () => pinnedSession || primarySession;
    const withSession = (path) => {
      const id = targetSession();
      if (!id) return path;
      return path + (path.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(id);
    };
    function sessionLabel(s) {
      const who = s.agent.kind === 'main' ? 'main' : (s.agent.name || s.agent.id);
      const indent = s.level > 0 ? '\u00a0\u00a0'.repeat(s.level) + '└ ' : '';
      return indent + who + ' · ' + s.phase + ' · ' + Math.round(Number(s.occupancyPct) || 0) + '% · ' + s.sessionId.slice(0, 8);
    }
    function flattenSessions(nodes, out) {
      for (const n of nodes) {
        out.push(n);
        flattenSessions(n.children || [], out);
      }
      return out;
    }
    function renderSessions(payload) {
      primarySession = payload.primary || '';
      const flat = flattenSessions(payload.tree || [], []);
      if (pinnedSession && !flat.some((s) => s.sessionId === pinnedSession)) {
        pinnedSession = '';
        sessionStorage.removeItem('origami-session');
      }
      const select = $('session-select');
      const primary = flat.find((s) => s.sessionId === primarySession);
      const autoLabel = 'follow main' + (primary ? ' (' + primary.sessionId.slice(0, 8) + ')' : '');
      const signature = flat.map((s) => s.sessionId).join(',');
      // Rebuild only when membership changes, so an open dropdown is not reset by polling.
      if (signature !== sessionSignature) {
        sessionSignature = signature;
        select.replaceChildren();
        const auto = document.createElement('option');
        auto.value = '';
        select.appendChild(auto);
        for (const s of flat) {
          const opt = document.createElement('option');
          opt.value = s.sessionId;
          select.appendChild(opt);
        }
      }
      select.options[0].textContent = autoLabel;
      for (let i = 0; i < flat.length; i++) select.options[i + 1].textContent = sessionLabel(flat[i]);
      select.value = pinnedSession;
    }
    function selectSession(id) {
      pinnedSession = id || '';
      if (pinnedSession) sessionStorage.setItem('origami-session', pinnedSession);
      else sessionStorage.removeItem('origami-session');
      refreshData();
    }

    // Theme persistence
    (function initTheme() {
      const saved = localStorage.getItem('origami-theme');
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    })();

    function toggleTheme() {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('origami-theme', next);
    }

    function toast(msg, kind) {
      const host = $('toast-host');
      if (!host) return;
      const el = document.createElement('div');
      el.className = 'toast ' + (kind || '');
      el.textContent = msg;
      host.appendChild(el);
      setTimeout(() => { el.remove(); }, 4200);
    }

    function escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatK(n) {
      n = Number(n) || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(Math.round(n));
    }

    function fmtDT(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      const p = (v) => String(v).padStart(2, '0');
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    let activeTab = 'overview';
    function switchTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.seg-tab').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      document.querySelectorAll('.panel').forEach((p) => {
        p.classList.toggle('active', p.id === 'tab-' + tab);
      });
    }

    // ─── billion-context Trajectory + Hit-Rate Renderer & Linked Brush Zoom ───
    const TRAJ_W = 960, TRAJ_H = 260, TRAJ_PL = 56, TRAJ_PR = 16, TRAJ_PT = 14, TRAJ_PB = 26;
    const TRAJ_MIN_SAMPLES = 5;
    const CAUSE_COLOR = { cold: '#6e7681', comp: '#d29922', seam: '#ef4444', rest: '#8b949e' };
    const CAUSE_LABEL = {
      cold: 'cold start (no prior cache)',
      comp: 'post-fold rebuild',
      seam: 'prefix divergence',
      rest: 'cache TTL expiry',
    };

    function classifyLineCauses(lines, folds) {
      const GAP_MS = 600000;
      let foldTailClaims = 0;
      return lines.map((l, i) => {
        if (i === 0) return !(l.cached || 0) ? 'cold' : 'new';
        const p = lines[i - 1];
        const missed = Math.max(0, (l.input || 0) - (l.cached || 0));
        const growth = Math.max(0, (l.input || 0) - (p.input || 0));
        const warm = (l.hitPct != null ? l.hitPct : 0) >= 85;
        const foldBetween = (folds || []).some((f) => (f.at || 0) >= (p.at || 0) && (f.at || 0) <= (l.at || 0));
        const foldOwned = l.foldEventId != null || foldBetween;
        let tailComp = false;
        if (warm) {
          foldTailClaims = 0;
        } else if (foldBetween && l.foldEventId == null) {
          foldTailClaims = 3;
        } else if (foldTailClaims > 0 && missed > growth + 256) {
          foldTailClaims -= 1;
          tailComp = true;
        } else if (l.foldEventId != null && !warm) {
          foldTailClaims = 3;
        }
        if ((foldOwned || tailComp) && missed > growth + 256) return 'comp';
        if ((l.at || 0) - (p.at || 0) > GAP_MS && missed > growth + 2048) return 'rest';
        if ((p.hitPct || 0) >= 85 && (l.hitPct != null ? l.hitPct : 100) < 50 && missed > growth + 4096) return 'seam';
        return 'new';
      });
    }

    function foldMarkLines(folds, lines, x, PT, ih) {
      let out = '';
      const buckets = [];
      (folds || []).forEach((f) => {
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].foldEventId === f.id || (lines[i].at || 0) >= (f.at || 0)) { idx = i; break; }
        }
        if (idx < 0) idx = lines.length - 1;
        if (idx < 0) return;
        const fx = x(idx);
        const bk = buckets.find((b) => Math.abs(b.fx - fx) <= 1.5);
        if (bk) bk.items.push(f); else buckets.push({ fx, items: [f] });
      });
      buckets.forEach((bk) => {
        const n = bk.items.length;
        const ids = bk.items.map((m) => m.id || ('#' + m.seq)).filter(Boolean).slice(0, 5).join('·');
        const saved = bk.items.reduce((a, m) => a + (m.S || 0), 0);
        out += '<line x1="' + bk.fx.toFixed(1) + '" y1="' + PT + '" x2="' + bk.fx.toFixed(1) + '" y2="' + (PT + ih) + '" stroke="var(--accent-red)" stroke-width="1.3" stroke-dasharray="3 3"><title>'
          + escapeHtml('fold' + (n > 1 ? ' ×' + n : '') + (ids ? ' ' + ids + ' · ' : ' ') + fmtDT(bk.items[0].at) + (saved > 0 ? ' · -' + formatK(saved) : ''))
          + '</title></line>';
      });
      return out;
    }

    function seqTickLines(lines, x, W, H, PL, PR) {
      const barW = lines.length > 1 ? (W - PL - PR) / (lines.length - 1) : 1;
      const tStep = Math.max(1, Math.ceil(24 / barW));
      const xtArr = [];
      for (let i = lines.length - 1; i >= 0; i -= tStep) {
        const l = lines[i];
        xtArr.push('<text transform="translate(' + x(i).toFixed(1) + ',' + (H - 28) + ') rotate(-90)" text-anchor="end" font-size="10" fill="var(--text-muted)">' + l.seq + '</text>');
      }
      const xtTime =
        (lines[0] && lines[0].at ? '<text x="' + PL + '" y="' + (H - 8) + '" text-anchor="start" font-size="9.5" fill="var(--text-muted)">' + escapeHtml(fmtDT(lines[0].at)) + '</text>' : '') +
        (lines.length > 1 && lines[lines.length - 1].at ? '<text x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9.5" fill="var(--text-muted)">' + escapeHtml(fmtDT(lines[lines.length - 1].at)) + '</text>' : '');
      return xtArr.join('') + xtTime;
    }

    function trajectorySvg(lines, folds, win, baseIn, forceCeiling) {
      lines = (lines || []).filter(Boolean);
      if (!lines.length) return '';
      const W = TRAJ_W, H = TRAJ_H, PL = TRAJ_PL, PR = TRAJ_PR, PT = TRAJ_PT, PB = TRAJ_PB;
      const iw = W - PL - PR, ih = H - PT - PB;
      let peakIn = 0;
      lines.forEach((l) => { if ((l.input || 0) > peakIn) peakIn = l.input; });
      const showCeilingLine = Boolean(win && win > 0 && (forceCeiling || peakIn >= win * 0.45));
      let maxY = showCeilingLine ? Math.max(win, peakIn) * 1.05 : peakIn * 1.12;
      if (maxY <= 0) maxY = 1;
      const x = (i) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
      const y = (v) => PT + ih - (Math.max(0, v) / maxY) * ih;

      let grid = '', ticks = '';
      for (let g = 0; g <= 4; g++) {
        const v = (maxY / 4) * g;
        const yy = y(v);
        grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border-subtle)" stroke-width="1"/>';
        ticks += '<text x="' + (PL - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + formatK(v) + '</text>';
      }

      let area = 'M' + x(0).toFixed(1) + ',' + y(lines[0].input || 0).toFixed(1);
      let stroke = '';
      lines.forEach((l, i) => {
        area += ' L' + x(i).toFixed(1) + ',' + y(l.cached || 0).toFixed(1);
        stroke += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(l.input || 0).toFixed(1) + ' ';
      });
      area += ' L' + x(lines.length - 1).toFixed(1) + ',' + (PT + ih).toFixed(1) + ' L' + x(0).toFixed(1) + ',' + (PT + ih).toFixed(1) + ' Z';

      const causes = classifyLineCauses(lines, folds);
      let bands = '', hovers = '';
      const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
      lines.forEach((l, i) => {
        const c = causes[i];
        const yIn = y(l.input || 0), yCa = y(l.cached || 0);
        const x0 = Math.max(PL, x(i) - swSeg / 2), x1 = Math.min(W - PR, x(i) + swSeg / 2);
        if (c !== 'new') {
          bands += '<rect x="' + x0.toFixed(1) + '" y="' + yIn.toFixed(1) + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + Math.max(3, yCa - yIn).toFixed(1) + '" fill="' + CAUSE_COLOR[c] + '" opacity="0.35" rx="1"/>';
          bands += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + (yCa - 2).toFixed(1) + '" y2="' + (PT + ih).toFixed(1) + '" stroke="' + CAUSE_COLOR[c] + '" stroke-width="1" opacity="0.45"/>';
        }
        const hitPctLine = (l.input || 0) > 0 ? ((l.cached || 0) / l.input * 100).toFixed(1) + '%' : '—';
        hovers += '<rect x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>'
          + escapeHtml('#' + l.seq + ' · ' + fmtDT(l.at) + '\\nin ' + formatK(l.input || 0) + ' · cached ' + formatK(l.cached || 0) + ' · missed ' + formatK(Math.max(0, (l.input || 0) - (l.cached || 0))) + ' · hit ' + hitPctLine + (c === 'new' ? '' : '\\n' + CAUSE_LABEL[c]))
          + '</title></rect>';
      });

      const singleDot = lines.length === 1
        ? '<circle cx="' + x(0).toFixed(1) + '" cy="' + y(lines[0].input || 0).toFixed(1) + '" r="3.5" fill="var(--accent-cyan)"/>'
        : '';
      const foldMarks = foldMarkLines(folds, lines, x, PT, ih);

      let ceiling = '';
      if (win && win > 0) {
        if (showCeilingLine) {
          const yy = y(win);
          ceiling = '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--accent-red)" stroke-width="1.5" stroke-dasharray="6 4"/>'
            + '<text x="' + (W - PR) + '" y="' + Math.max(10, yy - 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--accent-red)">context window ' + formatK(win) + '</text>';
        } else {
          ceiling = '<text x="' + (W - PR) + '" y="' + (PT + 10) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">context window ' + formatK(win) + ' (' + Math.round((peakIn / win) * 100) + '% peak)</text>';
        }
      }

      let baseline = '';
      const baseMeasured = Boolean(baseIn && baseIn > 0);
      const baseVal = baseMeasured
        ? baseIn
        : lines.length >= 20
          ? (() => { const ds = lines.map((l) => Math.max(0, (l.input || 0) - (l.cached || 0))).sort((a, b) => a - b); return ds[Math.floor(ds.length * 0.1)] || 0; })()
          : 0;
      if (baseVal >= 200 && baseVal < maxY) {
        const yy = y(baseVal);
        baseline = '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="2 4"/>'
          + '<text x="' + (PL + 4) + '" y="' + Math.max(10, yy - 4).toFixed(1) + '" font-size="9.5" fill="var(--text-muted)">' + (baseMeasured ? 'baseline (sys+tools) ' : 'est. baseline ') + formatK(baseVal) + '</text>';
      }

      const xt = seqTickLines(lines, x, W, H, PL, PR);
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg" role="img">' + grid
        + '<path d="' + area + '" fill="var(--accent-cyan)" opacity="0.18"/>'
        + bands + hovers
        + '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent-cyan)" stroke-width="1.8"/>'
        + singleDot + foldMarks + ceiling + baseline + ticks + xt + '</svg>';
    }

    function hitRateSvg(lines, folds) {
      lines = (lines || []).filter(Boolean);
      if (!lines.length) return '';
      const W = TRAJ_W, H = TRAJ_H, PL = TRAJ_PL, PR = TRAJ_PR, PT = TRAJ_PT, PB = TRAJ_PB;
      const iw = W - PL - PR, ih = H - PT - PB;
      const x = (i) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
      const y = (pct) => PT + ih - (Math.max(0, Math.min(100, pct)) / 100) * ih;
      const hp = (l) => l.hitPct != null ? l.hitPct : ((l.input || 0) > 0 ? ((l.cached || 0) / l.input) * 100 : null);

      let grid = '', ticks = '';
      for (let g = 0; g <= 4; g++) {
        const v = 25 * g;
        const yy = y(v);
        grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border-subtle)" stroke-width="1"/>';
        ticks += '<text x="' + (PL - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + v + '%</text>';
      }

      const causes = classifyLineCauses(lines, folds);
      let stroke = '', started = false;
      lines.forEach((l, i) => {
        const v = hp(l);
        if (v == null) { started = false; return; }
        stroke += (started ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
        started = true;
      });

      let dots = '', hovers = '';
      const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
      lines.forEach((l, i) => {
        const c = causes[i];
        const v = hp(l);
        const x0 = Math.max(PL, x(i) - swSeg / 2), x1 = Math.min(W - PR, x(i) + swSeg / 2);
        if (v != null && c !== 'new') dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.8" fill="' + CAUSE_COLOR[c] + '"/>';
        const hitTxt = v == null ? '—' : v.toFixed(1) + '%';
        hovers += '<rect x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>'
          + escapeHtml('#' + l.seq + ' · ' + fmtDT(l.at) + '\\nin ' + formatK(l.input || 0) + ' · cached ' + formatK(l.cached || 0) + ' · missed ' + formatK(Math.max(0, (l.input || 0) - (l.cached || 0))) + ' · hit ' + hitTxt + (c === 'new' ? '' : '\\n' + CAUSE_LABEL[c]))
          + '</title></rect>';
      });

      const singleDot = lines.length === 1 && hp(lines[0]) != null && causes[0] === 'new'
        ? '<circle cx="' + x(0).toFixed(1) + '" cy="' + y(hp(lines[0])).toFixed(1) + '" r="3.2" fill="var(--accent-green)"/>'
        : '';
      const foldMarks = foldMarkLines(folds, lines, x, PT, ih);
      const xt = seqTickLines(lines, x, W, H, PL, PR);
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg" role="img">' + grid
        + (stroke.trim() ? '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent-green)" stroke-width="1.8"/>' : '')
        + dots + singleDot + hovers + foldMarks + ticks + xt + '</svg>';
    }

    function chartIdxFromX(x, n) {
      if (n <= 1) return 0;
      const iw = TRAJ_W - TRAJ_PL - TRAJ_PR;
      return Math.max(0, Math.min(n - 1, Math.round(((x - TRAJ_PL) / iw) * (n - 1))));
    }

    const chartZooms = [];
    function makeChartZoom(cfg) {
      const z = { range: null, drag: null, state: null, boundOnce: false, cfg };
      z.visible = function () {
        if (!z.state) return null;
        const L = z.state.lines;
        let a = 0, b = L.length - 1;
        if (z.range) {
          a = Math.max(0, Math.min(L.length - 1, z.range[0]));
          b = Math.max(a, Math.min(L.length - 1, z.range[1]));
        }
        const lines = L.slice(a, b + 1);
        if (!z.range) return { lines, folds: z.state.folds || [], offset: a };
        const t0 = lines[0] ? (lines[0].at || 0) : 0;
        const t1 = lines.length ? (lines[lines.length - 1].at || 0) : 0;
        const seqSet = new Set(lines.map((l) => l.seq));
        return {
          lines,
          folds: (z.state.folds || []).filter((f) => (f.seq != null && seqSet.has(f.seq)) || ((f.at || 0) >= t0 && (f.at || 0) <= t1)),
          offset: a,
        };
      };
      function updateStatus(v) {
        const st = $(cfg.statusId);
        if (!st) return;
        if (!z.range || !v || !v.lines.length) { st.hidden = true; st.innerHTML = ''; return; }
        const L = z.state.lines;
        const a = v.offset, b = v.offset + v.lines.length - 1;
        const times = v.lines.map((l) => l.at).filter(Boolean);
        st.hidden = false;
        st.innerHTML = '<span class="mono" style="font-size:12px">View #' + L[a].seq + '–#' + L[b].seq
          + (times.length ? ' (' + escapeHtml(fmtDT(times[0])) + ' → ' + escapeHtml(fmtDT(times[times.length - 1])) + ')' : '')
          + '</span><button id="' + cfg.resetId + '" class="btn btn-sm" type="button">Reset view</button>';
        const rb = $(cfg.resetId);
        if (rb) rb.addEventListener('click', () => z.setRange(null));
      }
      z.render = function () {
        const wrap = $(cfg.elId);
        if (!wrap) return;
        const v = z.visible();
        if (!v || !v.lines.length) {
          wrap.innerHTML = '<div class="chart-empty">' + escapeHtml(cfg.emptyText) + '</div>';
          updateStatus(null);
          return;
        }
        wrap.innerHTML = cfg.render(v.lines, v.folds);
        updateStatus(v);
      };
      z.setRange = function (r) {
        const nr = r && r[1] > r[0] ? [r[0], r[1]] : null;
        const same = (nr === null && z.range === null) || (nr !== null && z.range !== null && nr[0] === z.range[0] && nr[1] === z.range[1]);
        if (same) return;
        z.range = nr;
        z.render();
        if (cfg.link && z.state) {
          cfg.link.members.forEach((m) => {
            if (m !== z && m.state && m.state.lines.length === z.state.lines.length) m.setRange(nr);
          });
        }
      };
      function localX(wrap, ev) {
        const r = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
        if (!r || !(r.width > 0)) return null;
        const x = (ev.clientX - r.left) * (TRAJ_W / r.width);
        return Math.max(TRAJ_PL, Math.min(TRAJ_W - TRAJ_PR, x));
      }
      function overlayShow(wrap, xa, xb) {
        if (!z.drag || !z.drag.overlay) return;
        const r = wrap.getBoundingClientRect();
        if (!r || !(r.width > 0)) return;
        const o = z.drag.overlay;
        o.style.left = (Math.min(xa, xb) * (r.width / TRAJ_W)).toFixed(1) + 'px';
        o.style.width = (Math.abs(xb - xa) * (r.width / TRAJ_W)).toFixed(1) + 'px';
        o.style.top = (TRAJ_PT * (r.height / TRAJ_H)).toFixed(1) + 'px';
        o.style.height = ((TRAJ_H - TRAJ_PT - TRAJ_PB) * (r.height / TRAJ_H)).toFixed(1) + 'px';
      }
      function onDown(ev) {
        if (!z.state || ev.button !== 0) return;
        const wrap = $(cfg.elId);
        const v = z.visible();
        if (!wrap || !v || v.lines.length < TRAJ_MIN_SAMPLES) return;
        ev.preventDefault();
        const x0 = localX(wrap, ev);
        if (x0 == null) return;
        const o = document.createElement('div');
        o.className = 'chart-brush';
        wrap.appendChild(o);
        z.drag = { x0, cur: x0, n: v.lines.length, offset: v.offset, overlay: o };
        overlayShow(wrap, x0, x0);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
      function onMove(ev) {
        if (!z.drag) return;
        const wrap = $(cfg.elId);
        const x = localX(wrap, ev);
        if (x == null) return;
        z.drag.cur = x;
        overlayShow(wrap, z.drag.x0, x);
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!z.drag) return;
        const d0 = z.drag;
        z.drag = null;
        if (d0.overlay) d0.overlay.remove();
        const x1 = localX($(cfg.elId), ev);
        if (x1 == null) return;
        const i0 = chartIdxFromX(Math.min(d0.x0, x1), d0.n);
        const i1 = chartIdxFromX(Math.max(d0.x0, x1), d0.n);
        if (i1 - i0 + 1 < TRAJ_MIN_SAMPLES || i1 - i0 + 1 >= d0.n) return;
        z.setRange([d0.offset + i0, d0.offset + i1]);
      }
      z.bind = function (state, preserveZoom) {
        z.state = state && state.lines && state.lines.length ? state : null;
        if (!preserveZoom || !z.state) z.range = null;
        const wrap = $(cfg.elId);
        if (wrap && !z.boundOnce) {
          z.boundOnce = true;
          wrap.addEventListener('mousedown', onDown);
          wrap.addEventListener('dblclick', () => z.setRange(null));
        }
        z.render();
      };
      chartZooms.push(z);
      if (cfg.link) cfg.link.members.push(z);
      return z;
    }

    const trajAux = { win: 0, baseIn: 0, forceCeiling: false };
    function toggleTrajScale() {
      trajAux.forceCeiling = !trajAux.forceCeiling;
      const btn = $('traj-scale-btn');
      if (btn) btn.textContent = trajAux.forceCeiling ? 'Y: Window' : 'Y: Auto';
      trajZoom.render();
    }
    const detailChartLink = { members: [] };
    const trajZoom = makeChartZoom({
      elId: 'traj-chart',
      statusId: 'traj-status',
      resetId: 'traj-reset',
      emptyText: 'No usage samples recorded for this session yet.',
      link: detailChartLink,
      render: (lines, folds) => trajectorySvg(lines, folds, trajAux.win, trajAux.baseIn, trajAux.forceCeiling),
    });
    const hitZoom = makeChartZoom({
      elId: 'hit-chart',
      statusId: 'hit-status',
      resetId: 'hit-reset',
      emptyText: 'No cache rounds recorded for this session yet.',
      link: detailChartLink,
      render: (lines, folds) => hitRateSvg(lines, folds),
    });

    window.bili_trajSvg = trajectorySvg;
    window.bili_hitSvg = hitRateSvg;
    window.bili_causes = classifyLineCauses;
    window.bili_trajZoom = trajZoom;
    window.bili_hitZoom = hitZoom;

    function legendChip(style, label, dashedColor) {
      if (dashedColor) {
        return '<span><span class="dot" style="background:none;border-top:2px dashed ' + dashedColor + ';height:0;border-radius:0;width:14px"></span>' + escapeHtml(label) + '</span>';
      }
      return '<span><span class="dot" style="' + style + '"></span>' + escapeHtml(label) + '</span>';
    }

    let cachedBlocks = [];
    let selectedDrawerId = null;

    function blockStatus(block) {
      if (block.status === 'consumed') return { css: 'status-consumed', label: 'Consumed → ' + (block.consumed_by || '?') };
      if (block.status === 'unfolded') return { css: 'status-unfolded', label: 'Unfolded' };
      return { css: 'status-live', label: 'Live' };
    }

    function openBlockDrawer(blockId) {
      const b = cachedBlocks.find((x) => x.block_id === blockId);
      if (!b) return;
      selectedDrawerId = blockId;
      $('drawer-title').innerHTML = '<span class="mono">' + escapeHtml(b.block_id) + '</span> · ' + escapeHtml(b.topic);
      const saved = Math.max(0, (b.tokens_before || 0) - (b.tokens_after || 0));
      const pct = b.tokens_before > 0 ? Math.round((saved / b.tokens_before) * 100) : 0;
      const status = blockStatus(b);
      $('drawer-kv').innerHTML =
        '<div class="k">Tier</div><div><span class="tag-tier tag-tier' + b.tier + '">Tier ' + b.tier + '</span></div>' +
        '<div class="k">Status</div><div><span class="status-pill ' + status.css + '">' + escapeHtml(status.label) + '</span></div>' +
        (b.coverage ? '<div class="k">Coverage</div><div class="mono">' + escapeHtml(b.coverage) + '</div>' : '') +
        '<div class="k">Compression</div><div class="mono">' + formatK(b.tokens_before) + 't → ' + formatK(b.tokens_after) + 't (-' + formatK(saved) + 't, ' + pct + '%)</div>' +
        (b.children && b.children.length ? '<div class="k">Distilled From</div><div class="mono">' + escapeHtml(b.children.join(', ')) + '</div>' : '') +
        '<div class="k">Created</div><div class="mono">' + escapeHtml(fmtDT(b.created_at)) + '</div>';
      $('drawer-summary').textContent = b.summary || '(empty summary)';
      $('drawer-foot').innerHTML =
        '<button class="btn btn-primary" id="drawer-unfold-file" onclick="unfoldBlock(\\'' + escapeHtml(b.block_id) + '\\', \\'file\\')">Unfold to Artifact File</button>' +
        (b.status === 'active' ? '<button class="btn" id="drawer-unfold-inline" onclick="unfoldBlock(\\'' + escapeHtml(b.block_id) + '\\', \\'inline\\')">Unfold Inline</button>' : '');
      $('drawer-backdrop').classList.add('open');
      $('block-drawer').classList.add('open');
    }

    function closeDrawer() {
      selectedDrawerId = null;
      $('drawer-backdrop').classList.remove('open');
      $('block-drawer').classList.remove('open');
    }

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (selectedDrawerId) { closeDrawer(); return; }
        chartZooms.forEach((z) => { if (z.range) z.setRange(null); });
      }
    });

    $('search-tbody').addEventListener('click', (ev) => {
      const row = ev.target instanceof Element ? ev.target.closest('[data-search-block-id]') : null;
      const blockId = row?.getAttribute('data-search-block-id');
      if (blockId) openBlockDrawer(blockId);
    });

    async function refreshData() {
      const seq = ++refreshSeq;
      try {
        const sRes = await apiFetch('/api/sessions');
        if (sRes.ok) renderSessions(await sRes.json());
        const [stRes, bRes, rRes] = await Promise.all([
          apiFetch(withSession('/api/status')),
          apiFetch(withSession('/api/blocks')),
          apiFetch(withSession('/api/rounds')),
        ]);
        // A newer refresh (e.g. the user switched sessions) owns the view.
        if (seq !== refreshSeq) return;
        if (!stRes.ok) return;
        const st = await stRes.json();
        const blocks = bRes.ok ? await bRes.json() : [];
        const rounds = rRes.ok ? await rRes.json() : [];
        if (seq !== refreshSeq) return;
        cachedBlocks = blocks;

        $('cnt-blocks').textContent = String(blocks.length);
        $('cnt-rounds').textContent = String(rounds.length);

        // 1. Fixed Window Occupancy KPI (st.occupancyPct is ALREADY 0..100 integer!)
        const pct = Math.max(0, Math.min(100, Math.round(Number(st.occupancyPct) || 0)));
        const usedTokens = Number(st.usedTokens != null ? st.usedTokens : st.liveTokens) || 0;
        const winTokens = Number(st.windowTokens) || 0;
        $('kpi-occupancy').textContent = pct + '%';
        $('kpi-occupancy-sub').textContent = formatK(usedTokens) + ' / ' + formatK(winTokens) + ' tokens';
        $('kpi-nudge-pill').textContent = st.nudgeKind && st.nudgeKind !== 'none' ? st.nudgeKind : '';

        // Stacked meter inside Occupancy KPI + Window Composition card
        const split = st.tokenSplit || {};
        const sysTok = (split.overhead || 0) + (split.system || 0);
        const convTok = split.conversation != null ? split.conversation : Math.max(0, (split.live || 0) - (split.tools || 0));
        const toolTok = split.tools || 0;
        const sumTok = split.summaries || 0;
        const freeTok = winTokens > 0 ? Math.max(0, winTokens - usedTokens) : 0;
        const denom = winTokens > 0 ? winTokens : Math.max(1, usedTokens);

        const cats = [
          { label: 'System & Tool Schemas', tok: sysTok, color: 'var(--accent-violet)' },
          { label: 'Conversation', tok: convTok, color: 'var(--accent-cyan)' },
          { label: 'Tool Outputs', tok: toolTok, color: 'var(--accent-amber)' },
          { label: 'Fold Summaries', tok: sumTok, color: 'var(--accent-green)' },
          { label: 'Free Window', tok: freeTok, color: 'var(--bg-hover)' },
        ];

        $('occupancy-meter').innerHTML = cats.slice(0, 4).map((c) => {
          const w = Math.max(0, (c.tok / denom) * 100).toFixed(2);
          return '<div class="meter-seg" style="width:' + w + '%;background:' + c.color + '"></div>';
        }).join('');

        $('comp-total-hint').textContent = formatK(usedTokens) + (winTokens > 0 ? ' / ' + formatK(winTokens) : '') + ' tokens';
        $('comp-bar').innerHTML = cats.map((c) => {
          const w = Math.max(0, (c.tok / denom) * 100).toFixed(2);
          return '<div style="width:' + w + '%;background:' + c.color + '" title="' + escapeHtml(c.label + ': ' + formatK(c.tok)) + '"></div>';
        }).join('');
        $('comp-list').innerHTML = cats.map((c) => {
          const share = ((c.tok / denom) * 100).toFixed(1) + '%';
          return '<div class="comp-row"><span class="comp-label"><span class="swatch" style="background:' + c.color + '"></span>' + escapeHtml(c.label) + '</span>'
            + '<span class="comp-val">' + formatK(c.tok) + '<span class="comp-pct">' + share + '</span></span></div>';
        }).join('');

        // 2. Growth & Compressible Candidates
        const step = Math.max(1, Number(st.growthStep) || 50000);
        const gPct = Math.min(100, Math.round(((st.growthSinceFold || 0) / step) * 100));
        $('kpi-growth').textContent = formatK(st.growthSinceFold || 0) + 't';
        $('kpi-growth-sub').textContent = 'Step: ' + formatK(step) + ' (' + gPct + '%) · Pool: ' + formatK(st.compressibleTokens || 0);
        $('growth-fill').style.width = gPct + '%';

        $('cand-floor-hint').textContent = 'Floor: ' + formatK(st.compressibleFloor || 0);
        const recs = st.recommended || [];
        $('cand-body').innerHTML = recs.length === 0
          ? '<div class="card-hint">No compressible message spans above floor yet.</div>'
          : '<div class="comp-list">' + recs.slice(0, 6).map((r) => {
              const sNum = parseInt(String(r.start || '').replace(/\\D+/g, ''), 10) || 0;
              const eNum = parseInt(String(r.end || '').replace(/\\D+/g, ''), 10) || 0;
              const msgCnt = eNum >= sNum && sNum > 0 ? (eNum - sNum + 1) : 1;
              return '<div class="comp-row"><span class="mono" style="color:var(--accent-cyan)">' + escapeHtml(r.start + '..' + r.end) + '</span>'
                + '<span class="comp-val">' + formatK(r.tokens) + 't · ' + msgCnt + ' msg' + (msgCnt === 1 ? '' : 's') + '</span></div>';
            }).join('') + '</div>';

        // 3. Vault & Reclaimed KPI
        const v = st.vault || {};
        const liveBlockCount = blocks.filter((b) => b.status === 'active').length;
        const savedTokens = Number(st.savedTokens || v.reclaimedTokens) || 0;
        const archTokens = Number(v.archivedTokens) || (savedTokens + (st.tokenSplit?.summaries || 0));
        const sumTokens = Number(v.summaryTokens || st.tokenSplit?.summaries) || 0;
        const compRatio = Number(v.compressionRatio) || (sumTokens > 0 ? Math.round((archTokens / sumTokens) * 10) / 10 : 1);
        const ratioStr = archTokens > 0 ? compRatio + '×' : '1.0×';
        const savPct = v.savingsPct != null ? v.savingsPct : (archTokens > 0 ? Math.round((savedTokens / archTokens) * 1000) / 10 : 0);

        $('kpi-saved').textContent = formatK(savedTokens) + 't';
        $('kpi-saved-sub').textContent = (archTokens > 0 ? formatK(archTokens) + 't stored (' + ratioStr + ') · ' : '') + liveBlockCount + ' live' + (blocks.length > liveBlockCount ? ' / ' + blocks.length + ' total' : '') + ' block(s)';
        const savedRatio = (usedTokens + savedTokens) > 0 ? Math.min(100, Math.round((savedTokens / (usedTokens + savedTokens)) * 100)) : 0;
        $('saved-fill').style.width = savedRatio + '%';

        // Vault Storage Card
        const vHint = $('vault-ratio-hint');
        if (vHint) vHint.textContent = ratioStr + ' compression (' + savPct + '% saved)';
        const vArch = $('vault-archived');
        if (vArch) vArch.textContent = formatK(archTokens) + 't';
        const vArchSub = $('vault-archived-sub');
        if (vArchSub) vArchSub.textContent = (v.archivedMessages || 0) + ' msgs · ' + liveBlockCount + ' live blocks';
        const vSum = $('vault-summaries');
        if (vSum) vSum.textContent = formatK(sumTokens) + 't';
        const vSumSub = $('vault-summaries-sub');
        if (vSumSub) vSumSub.textContent = liveBlockCount + ' active blocks in context';
        const vRat = $('vault-ratio');
        if (vRat) vRat.textContent = ratioStr;
        const vRatSub = $('vault-ratio-sub');
        if (vRatSub) vRatSub.textContent = '-' + formatK(savedTokens) + 't (' + savPct + '%)';
        const vSav = $('vault-saved');
        if (vSav) vSav.textContent = formatK(savedTokens) + 't';
        const vSavSub = $('vault-saved-sub');
        if (vSavSub) vSavSub.textContent = 'Net prompt tokens saved';
        // 4. Trajectory + Cache Hit Rate Charts & Cache Economics Table
        const lines = rounds.map((r, idx) => {
          const inp = Number(r.total_in) || 0;
          const ca = Math.min(inp, Number(r.cache_read) || 0);
          return {
            seq: idx + 1,
            at: Number(r.ts) || 0,
            input: inp,
            cached: ca,
            write: Number(r.cache_write) || 0,
            hitPct: inp > 0 ? (ca / inp) * 100 : null,
            foldEventId: r.fold_event_id || null,
          };
        });

        const foldMarks = blocks.map((b) => {
          let seq = null;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].foldEventId === b.block_id || lines[i].at >= b.created_at) { seq = lines[i].seq; break; }
          }
          return {
            id: b.block_id,
            seq,
            at: Number(b.created_at) || 0,
            S: Math.max(0, (Number(b.tokens_before) || 0) - (Number(b.tokens_after) || 0)),
          };
        });
        const knownIds = new Set(foldMarks.map((f) => f.id));
        lines.forEach((l) => {
          if (l.foldEventId && !knownIds.has(l.foldEventId)) {
            foldMarks.push({ id: l.foldEventId, seq: l.seq, at: l.at, S: 0 });
            knownIds.add(l.foldEventId);
          }
        });

        trajAux.win = winTokens;
        trajAux.baseIn = Number(st.baselineTokens) || sysTok || 0;
        trajZoom.bind({ lines, folds: foldMarks }, true);
        hitZoom.bind({ lines, folds: foldMarks }, true);

        const hasSamples = lines.length > 0;
        $('traj-legend').hidden = !hasSamples;
        $('traj-hint').hidden = !hasSamples;
        $('hit-legend').hidden = !hasSamples;

        if (hasSamples) {
          const causes = classifyLineCauses(lines, foldMarks);
          const present = {};
          causes.forEach((c) => { if (c !== 'new') present[c] = true; });
          $('traj-legend').innerHTML =
            legendChip('background:var(--accent-cyan)', 'input tokens') +
            legendChip('background:var(--accent-cyan);opacity:0.35', 'cached prefix') +
            (foldMarks.length ? legendChip('', 'fold event', 'var(--accent-red)') : '') +
            (winTokens > 0 ? legendChip('', 'context window', 'var(--accent-red)') : '') +
            (present.comp ? legendChip('background:' + CAUSE_COLOR.comp, 'post-fold rebuild') : '') +
            (present.cold ? legendChip('background:' + CAUSE_COLOR.cold, 'cold start') : '') +
            (present.seam ? legendChip('background:' + CAUSE_COLOR.seam, 'prefix divergence') : '') +
            (present.rest ? legendChip('background:' + CAUSE_COLOR.rest, 'cache TTL gap') : '') +
            (trajAux.baseIn >= 200 ? legendChip('', 'baseline (sys+tools)', 'var(--text-muted)') : '');

          $('hit-legend').innerHTML =
            legendChip('background:var(--accent-green)', 'hit %') +
            ['comp', 'cold', 'seam', 'rest'].filter((c) => present[c]).map((c) => legendChip('background:' + CAUSE_COLOR[c], CAUSE_LABEL[c])).join('') +
            (foldMarks.length ? legendChip('', 'fold event', 'var(--accent-red)') : '');
        }

        let totalIn = 0, totalRead = 0;
        lines.forEach((l) => { totalIn += l.input; totalRead += l.cached; });
        if (totalIn > 0) {
          const hitPct = Math.round((totalRead / totalIn) * 100);
          $('kpi-cache').textContent = hitPct + '%';
          $('kpi-cache-sub').textContent = formatK(totalRead) + ' / ' + formatK(totalIn) + ' cache read';
          $('cache-fill').style.width = hitPct + '%';
        } else {
          $('kpi-cache').textContent = '0%';
          $('kpi-cache-sub').textContent = '0 / 0 cache read';
          $('cache-fill').style.width = '0%';
        }

        const cacheTbody = $('cache-tbody');
        if (!lines.length) {
          cacheTbody.innerHTML = '<tr><td colspan="8" class="chart-empty">No cache rounds recorded yet.</td></tr>';
        } else {
          const causes = classifyLineCauses(lines, foldMarks);
          cacheTbody.innerHTML = lines.slice(-40).reverse().map((l) => {
            const c = causes[l.seq - 1];
            const rHit = l.hitPct != null ? l.hitPct.toFixed(1) + '%' : '—';
            const missed = Math.max(0, l.input - l.cached);
            const attr = [];
            if (l.foldEventId) attr.push('<span class="tag-tier tag-tier1">fold ' + escapeHtml(l.foldEventId) + '</span>');
            if (c !== 'new') attr.push('<span style="color:' + CAUSE_COLOR[c] + ';font-size:12px">' + escapeHtml(CAUSE_LABEL[c]) + '</span>');
            if (!attr.length) attr.push('<span style="color:var(--text-muted);font-size:12px">warm prefix</span>');
            return '<tr>' +
              '<td class="num">#' + l.seq + '</td>' +
              '<td class="mono">' + escapeHtml(fmtDT(l.at)) + '</td>' +
              '<td class="num">' + formatK(l.input) + '</td>' +
              '<td class="num" style="color:var(--accent-green)">' + formatK(l.cached) + '</td>' +
              '<td class="num" style="color:var(--accent-amber)">' + formatK(l.write) + '</td>' +
              '<td class="num">' + formatK(missed) + '</td>' +
              '<td class="num">' + rHit + '</td>' +
              '<td>' + attr.join(' · ') + '</td>' +
              '</tr>';
          }).join('');
        }

        // 5. Fold Blocks Table
        const blocksTbody = $('blocks-tbody');
        if (!blocks.length) {
          blocksTbody.innerHTML = '<tr><td colspan="8" class="chart-empty">No fold blocks yet.</td></tr>';
        } else {
          blocksTbody.innerHTML = blocks.slice().reverse().map((b) => {
            const tierCls = 'tag-tier tag-tier' + b.tier;
            const saved = Math.max(0, (b.tokens_before || 0) - (b.tokens_after || 0));
            const pctSaved = b.tokens_before > 0 ? Math.round((saved / b.tokens_before) * 100) : 0;
            const status = blockStatus(b);
            const statusCls = 'status-pill ' + status.css;
            return '<tr class="clickable ' + (b.status === 'active' ? '' : 'inactive-row') + '" data-block-id="' + escapeHtml(b.block_id) + '" onclick="openBlockDrawer(\\'' + escapeHtml(b.block_id) + '\\')">' +
              '<td class="mono"><strong>' + escapeHtml(b.block_id) + '</strong></td>' +
              '<td><span class="' + tierCls + '">Tier ' + b.tier + '</span></td>' +
              '<td><span class="' + statusCls + '">' + escapeHtml(status.label) + '</span></td>' +
              '<td class="mono" style="color:var(--text-secondary)">' + escapeHtml(b.coverage || '—') + '</td>' +
              '<td>' + escapeHtml(b.topic) + '</td>' +
              '<td class="num">' + formatK(b.tokens_before) + ' → <span style="color:var(--accent-green)">' + formatK(b.tokens_after) + '</span> <span style="color:var(--text-muted)">(-' + pctSaved + '%)</span></td>' +
              '<td class="num">' + escapeHtml(fmtDT(b.created_at)) + '</td>' +
              '<td class="num" onclick="event.stopPropagation()">' +
                '<button class="btn btn-sm" onclick="unfoldBlock(\\'' + escapeHtml(b.block_id) + '\\', \\'file\\')">Unfold</button>' +
              '</td>' +
              '</tr>';
          }).join('');
        }

        if (selectedDrawerId) openBlockDrawer(selectedDrawerId);

        // 6. Token-Weighted Context Zones
        const zones = st.zones || [];
        if (zones.length > 0) {
          const totalZ = Math.max(1, zones.reduce((s, z) => s + Math.max(1, Number(z.tokens) || 1), 0));
          $('zones-bar').innerHTML = zones.map((z) => {
            const weight = Math.max(1, Number(z.tokens) || 1);
            const cls = 'zone-seg zone-' + z.kind;
            return '<div class="' + cls + '" style="flex:' + weight + ';" title="' + escapeHtml(z.kind + ' · ' + z.start + '..' + z.end + ' · ' + formatK(z.tokens || 0) + 't') + '">' + escapeHtml(z.start + '..' + z.end) + '</div>';
          }).join('');
          $('zones-tbody').innerHTML = zones.map((z) => {
            const share = (((Number(z.tokens) || 0) / totalZ) * 100).toFixed(1) + '%';
            return '<tr>' +
              '<td><span class="status-pill" style="background:var(--bg-elevated);color:var(--text-primary)">' + escapeHtml(z.kind) + '</span></td>' +
              '<td class="mono">' + escapeHtml(z.start + '..' + z.end) + '</td>' +
              '<td class="num">' + (z.messages != null ? z.messages : '—') + '</td>' +
              '<td class="num">' + formatK(z.tokens || 0) + '</td>' +
              '<td class="num">' + share + '</td>' +
              '</tr>';
          }).join('');
        }
      } catch (err) {
        console.error('Refresh error', err);
      }
    }

    async function unfoldBlock(id, mode) {
      try {
        const res = await apiFetch(withSession('/api/unfold'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, mode: mode || 'file' }),
        });
        const data = await res.json();
        if (data.ok) {
          toast(
            mode === 'inline'
              ? 'Unfolded ' + id + ' inline into active context'
              : 'Unfolded ' + id + ' → ' + data.path,
            'ok',
          );
        } else {
          toast('Unfold failed: ' + (data.error || 'unknown error'), 'err');
        }
        refreshData();
      } catch (e) {
        toast('Network error while unfolding ' + id, 'err');
      }
    }

    let searchTimer = null;
    function debouncedSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 200);
    }

    async function runSearch() {
      const q = $('search-input').value.trim();
      const tbody = $('search-tbody');
      if (!q) {
        tbody.innerHTML = '<tr><td colspan="4" class="chart-empty">Enter search terms above to query SQLite FTS5 index.</td></tr>';
        return;
      }
      const res = await apiFetch('/api/search?q=' + encodeURIComponent(q));
      if (!res.ok) return;
      const result = await res.json();
      const blocks = result.blocks || [];
      const messages = result.messages || [];
      if (!blocks.length && !messages.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="chart-empty">No matches for "' + escapeHtml(q) + '".</td></tr>';
      } else {
        const blockRows = blocks.map((h) =>
          '<tr class="clickable" data-search-block-id="' + escapeHtml(h.blockId) + '">' +
            '<td class="mono"><strong>' + escapeHtml(h.blockId) + '</strong></td>' +
            '<td><span class="tag-tier tag-tier' + h.tier + '">Tier ' + h.tier + '</span></td>' +
            '<td>' + escapeHtml(h.topic) + '</td>' +
            '<td class="mono" style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(h.snippet || '') + '</td>' +
          '</tr>'
        );
        const messageRows = messages.map((h) =>
          '<tr>' +
            '<td class="mono"><strong>' + escapeHtml(h.ref) + '</strong></td>' +
            '<td><span class="status-pill">' + escapeHtml(h.role) + '</span></td>' +
            '<td>' + escapeHtml(h.sessionId) + '</td>' +
            '<td class="mono" style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(h.snippet || '') + '</td>' +
          '</tr>'
        );
        tbody.innerHTML = blockRows.concat(messageRows).join('');
      }
    }

    // Live SSE connection
    const events = new EventSource('/api/events?token=' + encodeURIComponent(dashboardToken));
    events.addEventListener('open', () => {
      $('sse-dot').classList.remove('offline');
      $('sse-label').textContent = 'Live';
    });
    events.addEventListener('error', () => {
      $('sse-dot').classList.add('offline');
      $('sse-label').textContent = 'Reconnecting';
    });
    // Only the focused session's events matter; session-tree changes always do.
    ['fold', 'unfold', 'round', 'refresh', 'sessions'].forEach((ev) => {
      events.addEventListener(ev, (e) => {
        let sessionId = null;
        try {
          sessionId = JSON.parse(e.data).sessionId;
        } catch {}
        if (ev === 'sessions' || ev === 'refresh' || !sessionId || sessionId === targetSession()) refreshData();
      });
    });

    refreshData();
    setInterval(refreshData, 4000);
  </script>
</body>
</html>`;
}
