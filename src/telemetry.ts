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
