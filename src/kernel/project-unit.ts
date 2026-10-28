import type { BoundMessage, RefRange } from "./types.ts";
import { formatRef, parseRef } from "./types.ts";
import { widenSelectedToolPairs } from "./tool-pairs.ts";
export interface ProjectUnitInput {
  bound: readonly BoundMessage[];
  ranges: readonly RefRange[];
  foldedRefs: ReadonlySet<string>;
  pinnedHeadRef: string | null;
  activeTurn: number;
  /** Turns at or after this one are the protected recent tail. Defaults to `activeTurn`. */
  protectedFromTurn?: number;
}

export interface ProjectedSpan {
  indices: number[];
  refs: string[];
  ranges: RefRange[];
  tokens: number;
}

export interface ProjectUnitOk {
  ok: true;
  projected: ProjectedSpan;
  widened: boolean;
  turnCount: number;
}

export interface ProjectUnitErr {
  ok: false;
  error: string;
}

export type ProjectUnitResult = ProjectUnitOk | ProjectUnitErr;

function refValue(ref: string): number {
  return parseRef(ref);
}

export function spanHits(ref: string, ranges: readonly RefRange[]): boolean {
  const n = refValue(ref);
  for (const r of ranges) {
    if (n >= refValue(r.start) && n <= refValue(r.end)) return true;
  }
  return false;
}

function compressToRanges(bound: readonly BoundMessage[], indices: readonly number[]): RefRange[] {
  const out: RefRange[] = [];
  let open: RefRange | null = null;
  for (const i of indices) {
    const ref = bound[i]!.ref;
    if (open && refValue(ref) === refValue(open.end) + 1) {
      open.end = ref;
    } else {
      if (open) out.push(open);
      open = { start: ref, end: ref };
    }
  }
  if (open) out.push(open);
  return out;
}

export function projectUnit(input: ProjectUnitInput): ProjectUnitResult {
  const { bound, ranges, foldedRefs, pinnedHeadRef, activeTurn } = input;
  const protectedFromTurn = Math.min(activeTurn, input.protectedFromTurn ?? activeTurn);
  if (ranges.length === 0) return { ok: false, error: "empty range" };

  const maxRefNum = bound.reduce((max, m) => (m.ref && /^m\d{5,}$/.test(m.ref) ? Math.max(max, parseRef(m.ref)) : max), 0);
  const highestRef = formatRef(maxRefNum);

  for (const r of ranges) {
    const s = parseRef(r.start);
    const e = parseRef(r.end);
    if (s > maxRefNum && e > maxRefNum) {
      return {
        ok: false,
        error: `range ${r.start}..${r.end} is above this session's highest ref (${highestRef}); check for stale refs from another session`,
      };
    }
    if (s <= maxRefNum && e > maxRefNum) {
      return {
        ok: false,
        error: `endRef ${r.end} is above the highest stored ref (${highestRef}); retry with endRef ≤ ${highestRef}`,
      };
    }
  }
  const membersByTurn = new Map<number, number[]>();
  for (let i = 0; i < bound.length; i++) {
    const m = bound[i]!;
    if (m.ephemeral) continue;
    const list = membersByTurn.get(m.turn);
    if (list) list.push(i);
    else membersByTurn.set(m.turn, [i]);
  }

  const touchedTurns = new Set<number>();
  for (const m of bound) {
    if (m.ephemeral) continue;
    if (spanHits(m.ref, ranges)) touchedTurns.add(m.turn);
  }

  const selected = new Set<number>();
  let splits = 0;
  let headHit = false;
  let turnHit = false;
  let tailHit = false;

  for (const turn of touchedTurns) {
    const members = membersByTurn.get(turn) ?? [];
    const inSpan = members.filter((i) => spanHits(bound[i]!.ref, ranges));
    const hasHead = pinnedHeadRef !== null && members.some((i) => bound[i]!.ref === pinnedHeadRef);
    const isInFlight = turn === activeTurn;
    const isTail = turn >= protectedFromTurn;

    if (hasHead || isInFlight || isTail) {
      if (inSpan.length === members.length) {
        if (hasHead) headHit = true;
        else if (isInFlight) turnHit = true;
        else tailHit = true;
      } else {
        splits++;
      }
      continue;
    }

    for (const i of members) selected.add(i);
  }

  if (splits > 0) return { ok: false, error: `range splits ${splits} turn(s)` };
  if (headHit) return { ok: false, error: "range inside protected head" };
  if (turnHit) return { ok: false, error: "range includes current in-flight turn" };
  if (tailHit) return { ok: false, error: `range includes protected recent tail (turn ${protectedFromTurn} onward)` };
  if (selected.size === 0) return { ok: false, error: "range matches no messages" };

  const headTurn = pinnedHeadRef !== null ? pinnedHeadTurn(bound, pinnedHeadRef) : -1;
  const isEligible = (idx: number) => {
    const m = bound[idx];
    if (!m || m.ephemeral) return false;
    if (m.turn === headTurn) return false;
    if (m.turn === activeTurn) return false;
    if (m.turn >= protectedFromTurn) return false;
    return true;
  };

  const toolPairOutcome = widenSelectedToolPairs({ selected, bound, isEligible });
  if (toolPairOutcome.split) {
    return {
      ok: false,
      error: `range splits tool pair: caller ${toolPairOutcome.split.callerRef} and partner ${toolPairOutcome.split.partnerRef} (${toolPairOutcome.split.reason})`,
    };
  }
  const indices = [...selected].sort((a, b) => a - b);
  const anyNew = indices.some((i) => !foldedRefs.has(bound[i]!.ref));
  if (!anyNew) return { ok: false, error: "range matches no messages" };

  const foldable = new Set<number>();
  for (const i of indices) {
    const m = bound[i]!;
    if (!foldedRefs.has(m.ref) && spanHits(m.ref, ranges)) foldable.add(i);
  }

  return {
    ok: true,
    projected: {
      indices,
      refs: indices.map((i) => bound[i]!.ref),
      ranges: compressToRanges(bound, indices),
      tokens: 0,
    },
    widened: selected.size > foldable.size || toolPairOutcome.widened,
    turnCount: touchedTurns.size,
  };
}

/**
 * First turn of the protected recent tail: walk back from the newest message until at
 * least `minMessages` messages AND `minTokens` tokens are covered, then widen to the
 * whole turn. Never later than `activeTurn`.
 */
export function protectedTailTurn(
  bound: readonly BoundMessage[],
  activeTurn: number,
  minMessages: number,
  minTokens: number,
  tokensOf: (m: BoundMessage) => number,
): number {
  let messages = 0;
  let tokens = 0;
  let turn = activeTurn;
  for (let i = bound.length - 1; i >= 0; i--) {
    if (messages >= minMessages && tokens >= minTokens) break;
    const m = bound[i]!;
    if (m.ephemeral) continue;
    messages++;
    tokens += tokensOf(m);
    if (m.turn < turn) turn = m.turn;
  }
  return turn;
}

export function protectedZoneMap(
  bound: readonly BoundMessage[],
  protectedFromTurn: number,
  foldedRefs: ReadonlySet<string>,
  pinnedHeadRef: string | null,
) {
  type Zone = { kind: "protected" | "compressible" | "folded"; start: string; end: string };
  const zones: Zone[] = [];
  let run: Zone | null = null;
  const headTurn = pinnedHeadRef !== null ? pinnedHeadTurn(bound, pinnedHeadRef) : -1;
  for (const m of bound) {
    const pinnedTurn = pinnedHeadRef !== null && m.turn === headTurn;
    const kind = m.ephemeral || m.turn >= protectedFromTurn || pinnedTurn ? "protected" : foldedRefs.has(m.ref) ? "folded" : "compressible";
    if (run && run.kind === kind) {
      if (!run.start && m.ref) run.start = m.ref;
      if (m.ref) run.end = m.ref;
    } else {
      if (run) zones.push(run);
      run = { kind, start: m.ref, end: m.ref };
    }
  }
  if (run) zones.push(run);
  return zones;
}

export function pinnedHeadTurn(bound: readonly BoundMessage[], pinnedHeadRef: string): number {
  for (const m of bound) {
    if (m.ref === pinnedHeadRef) return m.turn;
  }
  return -1;
}

export interface UncoveredRun {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  advertised: boolean;
}

/**
 * Uncovered-history audit (Billion-Context #4331, uncovered.ts).
 * Identifies contiguous runs of raw messages that are:
 * 1. Outside the pinned head
 * 2. Older than the protected recent tail (compressible)
 * 3. Not covered by any active fold block
 * Also flags whether the run is currently advertised in the active nudge.
 */
export function detectUncoveredRuns(
  bound: readonly BoundMessage[],
  protectedFromTurn: number,
  foldedRefs: ReadonlySet<string>,
  pinnedHeadRef: string | null,
  bookkeepingRefs: ReadonlySet<string>,
  countTokens: (msg: BoundMessage) => number,
  advertisedRanges: readonly { start: string; end: string }[] = [],
): UncoveredRun[] {
  const headTurn = pinnedHeadRef !== null ? pinnedHeadTurn(bound, pinnedHeadRef) : -1;
  const entries: { ref: string; tokens: number }[] = [];

  for (const m of bound) {
    if (m.ephemeral || !/^m\d{5,}$/.test(m.ref) || bookkeepingRefs.has(m.ref)) continue;
    const isPinned = headTurn !== -1 && m.turn === headTurn;
    const isProtectedTail = m.turn >= protectedFromTurn;
    if (isPinned || isProtectedTail) continue;
    if (foldedRefs.has(m.ref)) continue;

    const tokens = countTokens(m);
    if (tokens <= 0) continue;
    entries.push({ ref: m.ref, tokens });
  }

  if (entries.length === 0) return [];

  const rawRuns: { startRef: string; endRef: string; count: number; tokens: number }[] = [];
  let cur: { startRef: string; endRef: string; count: number; tokens: number; lastNum: number } | null = null;

  for (const e of entries) {
    const num = parseRef(e.ref);
    if (cur && num === cur.lastNum + 1) {
      cur.endRef = e.ref;
      cur.count++;
      cur.tokens += e.tokens;
      cur.lastNum = num;
    } else {
      if (cur) rawRuns.push({ startRef: cur.startRef, endRef: cur.endRef, count: cur.count, tokens: cur.tokens });
      cur = { startRef: e.ref, endRef: e.ref, count: 1, tokens: e.tokens, lastNum: num };
    }
  }
  if (cur) rawRuns.push({ startRef: cur.startRef, endRef: cur.endRef, count: cur.count, tokens: cur.tokens });

  const advWindows = advertisedRanges.map((r) => [parseRef(r.start), parseRef(r.end)] as const);

  return rawRuns.map((r) => {
    const s = parseRef(r.startRef);
    const e = parseRef(r.endRef);
    const advertised = advWindows.some(([lo, hi]) => !(e < lo || s > hi));
    return {
      startRef: r.startRef,
      endRef: r.endRef,
      count: r.count,
      tokens: r.tokens,
      advertised,
    };
  });
}