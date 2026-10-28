export interface ContextMapSegment<T> {
  readonly id: T;
  readonly tokens: number;
}

export interface ContextMapCell<T> {
  readonly id: T;
  readonly full: boolean;
}

/** Lay ordered token segments over a fixed grid; each cell belongs to its largest overlap. */
export function planContextMap<T>(
  segments: readonly ContextMapSegment<T>[],
  windowTokens: number,
  columns: number,
  rows: number,
): ContextMapCell<T>[] {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0 || !Number.isInteger(columns) || !Number.isInteger(rows) || columns <= 0 || rows <= 0) return [];
  const tokensPerCell = windowTokens / (columns * rows);
  const ranges: { id: T; start: number; end: number }[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (!Number.isFinite(segment.tokens) || segment.tokens <= 0) continue;
    const end = Math.min(windowTokens, cursor + segment.tokens);
    if (end > cursor) ranges.push({ id: segment.id, start: cursor, end });
    cursor = end;
    if (cursor >= windowTokens) break;
  }
  const cells: ContextMapCell<T>[] = [];
  let first = 0;
  for (let index = 0; index < columns * rows; index++) {
    const start = index * tokensPerCell;
    const end = (index + 1) * tokensPerCell;
    while (first < ranges.length && ranges[first]!.end <= start) first++;
    let winner: T | undefined;
    let overlap = 0;
    for (let part = first; part < ranges.length && ranges[part]!.start < end; part++) {
      const range = ranges[part]!;
      const covered = Math.min(end, range.end) - Math.max(start, range.start);
      if (covered > overlap) {
        overlap = covered;
        winner = range.id;
      }
    }
    if (winner !== undefined) cells.push({ id: winner, full: overlap / tokensPerCell >= 0.7 });
  }
  return cells;
}
