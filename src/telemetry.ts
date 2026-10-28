import type { DbToolTelemetryRow } from "./persist/db.ts";
import type { OrigamiRuntime } from "./runtime.ts";

export interface ToolTelemetryEvent {
  tool: string;
  durationMs: number;
  ok: boolean;
  error?: string | null;
  inputSummary: string;
  outputSummary: string;
  stumble?: boolean;
  stumbleReason?: string | null;
  metrics?: Record<string, unknown>;
}

interface SessionTelemetryState {
  consecutiveErrors: number;
  consecutiveSearchMisses: number;
  recentSearchQueries: string[];
  lastTool: string | null;
  lastTs: number;
  sawHighCacheHit: boolean;
  lowCacheRun: number;
  cacheCollapsed: boolean;
  cacheCollapseReason: string | null;
}

const sessionStates = new Map<string, SessionTelemetryState>();

function getSessionState(sessionId: string): SessionTelemetryState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      consecutiveErrors: 0,
      consecutiveSearchMisses: 0,
      recentSearchQueries: [],
      lastTool: null,
      lastTs: 0,
      sawHighCacheHit: false,
      lowCacheRun: 0,
      cacheCollapsed: false,
      cacheCollapseReason: null,
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

export function evaluateStumble(
  sessionId: string,
  tool: string,
  ok: boolean,
  error: string | null | undefined,
  metrics: Record<string, unknown> = {},
): { stumble: boolean; stumbleReason: string | null } {
  const state = getSessionState(sessionId);
  let stumble = false;
  const reasons: string[] = [];

  if (!ok) {
    state.consecutiveErrors++;
    stumble = true;
    if (state.consecutiveErrors >= 2) {
      reasons.push(`Repeated tool failure (${state.consecutiveErrors} consecutive errors)`);
    } else {
      reasons.push(error ? `Tool error: ${error}` : "Tool execution failed");
    }
  } else {
    state.consecutiveErrors = 0;
  }

  if (tool === "fold_search") {
    const hits = Number(metrics.blockHits ?? 0) + Number(metrics.messageHits ?? 0);
    const query = String(metrics.query ?? "").trim().toLowerCase();

    if (hits === 0) {
      state.consecutiveSearchMisses++;
      stumble = true;
      if (state.consecutiveSearchMisses >= 2) {
        reasons.push(`Frustration loop: ${state.consecutiveSearchMisses} consecutive searches returned 0 hits`);
      } else {
        reasons.push("Search returned 0 hits (vocabulary mismatch)");
      }
    } else {
      state.consecutiveSearchMisses = 0;
    }

    if (query && state.recentSearchQueries.includes(query)) {
      stumble = true;
      reasons.push(`Repeated identical search query: "${query}"`);
    }
    if (query) {
      state.recentSearchQueries.push(query);
      if (state.recentSearchQueries.length > 5) state.recentSearchQueries.shift();
    }
  }

  if (tool === "fold_recall") {
    const missing = Number(metrics.missingRefs ?? 0);
    if (missing > 0) {
      stumble = true;
      reasons.push(`Recall missing ${missing} requested ref(s) from archive/branch`);
    }
  }

  if (tool === "fold") {
    if (!ok && error) {
      stumble = true;
      reasons.push(`Fold rejected: ${error}`);
    }
  }

  if (tool === "unfold") {
    if (!ok && error) {
      stumble = true;
      reasons.push(`Unfold rejected: ${error}`);
    }
  }

  state.lastTool = tool;
  state.lastTs = Date.now();

  return {
    stumble,
    stumbleReason: reasons.length > 0 ? reasons.join(" · ") : null,
  };
}

export function recordToolTelemetry(
  rt: OrigamiRuntime,
  event: ToolTelemetryEvent,
): DbToolTelemetryRow | null {
  const sessionId = rt.sessionId;
  const evaluated = evaluateStumble(
    sessionId,
    event.tool,
    event.ok,
    event.error,
    event.metrics ?? {},
  );

  const stumble = event.stumble ?? evaluated.stumble;
  const stumbleReason = event.stumbleReason ?? evaluated.stumbleReason;

  const row: DbToolTelemetryRow = {
    session_id: sessionId,
    ts: Date.now(),
    tool: event.tool,
    duration_ms: Math.max(0, Math.round(event.durationMs)),
    ok: event.ok ? 1 : 0,
    error: event.error ?? null,
    input_summary: event.inputSummary,
    output_summary: event.outputSummary,
    stumble: stumble ? 1 : 0,
    stumble_reason: stumbleReason,
    metrics: JSON.stringify(event.metrics ?? {}),
  };

  if (rt.db) {
    try {
      rt.db.recordToolCall(row);
    } catch (e) {
      // Database logging should never crash the tool invocation
      console.warn("origami: failed to write tool telemetry to db", e);
    }
  }

  return row;
}

/**
 * Upstream prompt-cache collapse detector (Billion-Context #499, #1847, cache-warn.ts).
 * A warm session normally rides the provider's prefix cache (85%+ hit). When a restart,
 * mid-prompt timestamp, or deployment change drops the upstream KV cache, the resend
 * is expensive but silent: requests succeed, but every turn is billed and processed cold.
 *
 * Detects when a session with demonstrated healthy cache (≥50% on a request ≥8Kt)
 * logs 4 consecutive large requests at ~0% hit (≤10%).
 */
export function evaluateCacheRound(
  sessionId: string,
  totalIn: number,
  cacheRead: number,
): { collapsed: boolean; reason: string | null } {
  const state = getSessionState(sessionId);
  if (totalIn < 8000) {
    return { collapsed: state.cacheCollapsed, reason: state.cacheCollapseReason };
  }
  const hit = cacheRead / totalIn;
  if (hit >= 0.5) {
    state.sawHighCacheHit = true;
    state.lowCacheRun = 0;
    state.cacheCollapsed = false;
    state.cacheCollapseReason = null;
    return { collapsed: false, reason: null };
  }
  if (!state.sawHighCacheHit) {
    return { collapsed: false, reason: null };
  }
  if (hit > 0.1) {
    state.lowCacheRun = 0;
    return { collapsed: false, reason: null };
  }
  state.lowCacheRun++;
  if (state.lowCacheRun >= 4) {
    state.cacheCollapsed = true;
    state.cacheCollapseReason = `Prompt cache collapse: ${state.lowCacheRun} consecutive large requests (≥8Kt) at ~0% hit (last: ${Math.round(hit * 100)}%) after earlier ≥50% hits`;
    return { collapsed: true, reason: state.cacheCollapseReason };
  }
  return { collapsed: false, reason: null };
}

export function getCacheCollapseStatus(sessionId: string): { collapsed: boolean; reason: string | null } {
  const state = getSessionState(sessionId);
  return { collapsed: state.cacheCollapsed, reason: state.cacheCollapseReason };
}

export function _resetTelemetryForTest(sessionId?: string): void {
  if (sessionId) sessionStates.delete(sessionId);
  else sessionStates.clear();
}
