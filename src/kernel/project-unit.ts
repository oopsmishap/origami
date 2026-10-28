import type { BoundMessage, RefRange } from "./types.ts";
import { parseRef } from "./types.ts";

export interface ProjectUnitInput {
  bound: readonly BoundMessage[];
  ranges: readonly RefRange[];
  foldedRefs: ReadonlySet<string>;
  pinnedHeadRef: string | null;
  activeTurn: number;
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

function spanHits(ref: string, ranges: readonly RefRange[]): boolean {
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
  if (ranges.length === 0) return { ok: false, error: "empty range" };

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

  for (const turn of touchedTurns) {
    const members = membersByTurn.get(turn) ?? [];
    const inSpan = members.filter((i) => spanHits(bound[i]!.ref, ranges));
    const hasHead = pinnedHeadRef !== null && members.some((i) => bound[i]!.ref === pinnedHeadRef);
    const isInFlight = turn === activeTurn;

    if (hasHead || isInFlight) {
      if (inSpan.length === members.length) {
        if (hasHead) headHit = true;
        else turnHit = true;
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
  if (selected.size === 0) return { ok: false, error: "range matches no messages" };

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
    widened: selected.size > foldable.size,
    turnCount: touchedTurns.size,
  };
}

export function protectedZoneMap(
  bound: readonly BoundMessage[],
  activeTurn: number,
  foldedRefs: ReadonlySet<string>,
  pinnedHeadRef: string | null,
) {
  type Zone = { kind: "protected" | "compressible" | "folded"; start: string; end: string };
  const zones: Zone[] = [];
  let run: Zone | null = null;
  for (const m of bound) {
    const pinnedTurn = pinnedHeadRef !== null && m.turn === pinnedHeadTurn(bound, pinnedHeadRef);
    const kind = m.ephemeral || m.turn === activeTurn || pinnedTurn ? "protected" : foldedRefs.has(m.ref) ? "folded" : "compressible";
    if (run && run.kind === kind) {
      run.end = m.ref;
    } else {
      if (run) zones.push(run);
      run = { kind, start: m.ref, end: m.ref };
    }
  }
  if (run) zones.push(run);
  return zones;
}

function pinnedHeadTurn(bound: readonly BoundMessage[], pinnedHeadRef: string): number {
  for (const m of bound) {
    if (m.ref === pinnedHeadRef) return m.turn;
  }
  return -1;
}