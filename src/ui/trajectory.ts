import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { node, row, span, text } from "./native.ts";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CacheRound, StatusBlockRow } from "../engine.ts";
import { formatTokens } from "../kernel/nudge.ts";

interface NativeChartMark {
  value: number;
  tone?: TspTone;
  title?: string;
}

export type TrajectoryCause = "new" | "cold" | "comp" | "seam" | "rest";

export const TRAJ_W = 960;
export const TRAJ_H = 260;
export const TRAJ_PL = 56;
export const TRAJ_PR = 16;
export const TRAJ_PT = 14;
export const TRAJ_PB = 26;
export const TRAJ_MIN_SAMPLES = 5;

export const CAUSE_COLOR: Readonly<Record<Exclude<TrajectoryCause, "new">, string>> = {
  cold: "#6e7681",
  comp: "#d29922",
  seam: "#ef4444",
  rest: "#8b949e",
};

export const CAUSE_LABEL: Readonly<Record<Exclude<TrajectoryCause, "new">, string>> = {
  cold: "cold start (no prior cache)",
  comp: "post-fold rebuild",
  seam: "prefix divergence",
  rest: "cache TTL expiry",
};

export interface TrajectoryLine {
  seq: number;
  at: number;
  input: number;
  cached: number;
  cacheWrite: number;
  missed: number;
  hitPct: number | null;
  foldEventId: string | null;
  cause: TrajectoryCause;
}

export interface TrajectoryFoldMark {
  id: string;
  tier: number;
  at: number;
  seq: number | null;
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  topic: string;
}

export interface TrajectoryData {
  lines: TrajectoryLine[];
  folds: TrajectoryFoldMark[];
  windowTokens: number;
  baselineTokens: number;
  baselineMeasured: boolean;
  peakInput: number;
  latestInput: number;
  totalInput: number;
  totalCached: number;
  overallHitPct: number | null;
  reclaimedTotal: number;
}

/**
 * Ported from billion-context `classifyLineCauses`: classifies each request's
 * uncached gap (`input − cached`) so both the Context Trajectory bands and
 * Cache Hit Rate dip markers share identical attribution buckets.
 */
export function classifyLineCauses(
  lines: readonly Pick<TrajectoryLine, "at" | "input" | "cached" | "hitPct" | "foldEventId">[],
  folds: readonly Pick<TrajectoryFoldMark, "at" | "id">[],
): TrajectoryCause[] {
  const GAP_MS = 600_000;
  let foldTailClaims = 0;
  return lines.map((l, i) => {
    if (i === 0) return !(l.cached || 0) ? "cold" : "new";
    const p = lines[i - 1]!;
    const missed = Math.max(0, (l.input || 0) - (l.cached || 0));
    const growth = Math.max(0, (l.input || 0) - (p.input || 0));
    const warm = (l.hitPct ?? 0) >= 85;
    const foldBetween = folds.some((f) => (f.at || 0) >= (p.at || 0) && (f.at || 0) <= (l.at || 0));
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

    if ((foldOwned || tailComp) && missed > growth + 256) return "comp";
    if ((l.at || 0) - (p.at || 0) > GAP_MS && missed > growth + 2048) return "rest";
    if ((p.hitPct ?? 0) >= 85 && (l.hitPct ?? 100) < 50 && missed > growth + 4096) return "seam";
    return "new";
  });
}

export function buildTrajectoryData(input: {
  rounds: readonly CacheRound[];
  blocks: readonly StatusBlockRow[];
  windowTokens: number;
  baselineTokens?: number;
}): TrajectoryData {
  const rawLines = input.rounds.map((r, idx) => {
    const totalIn = Math.max(0, r.totalIn || 0);
    const cached = Math.max(0, Math.min(totalIn, r.cacheRead || 0));
    const missed = Math.max(0, totalIn - cached);
    const hitPct = totalIn > 0 ? (cached / totalIn) * 100 : null;
    return {
      seq: idx + 1,
      at: r.ts,
      input: totalIn,
      cached,
      cacheWrite: Math.max(0, r.cacheWrite || 0),
      missed,
      hitPct,
      foldEventId: r.foldEventId,
      cause: "new" as TrajectoryCause,
    };
  });

  const blockById = new Map(input.blocks.map((b) => [b.id, b]));
  const folds: TrajectoryFoldMark[] = [];
  const seenFoldIds = new Set<string>();

  for (const b of input.blocks) {
    let seq: number | null = null;
    for (const l of rawLines) {
      if (l.foldEventId === b.id || l.at >= b.createdAt) {
        seq = l.seq;
        break;
      }
    }
    folds.push({
      id: b.id,
      tier: b.tier,
      at: b.createdAt,
      seq,
      tokensBefore: b.tokensBefore,
      tokensAfter: b.tokensAfter,
      saved: Math.max(0, b.tokensBefore - b.tokensAfter),
      topic: b.topic,
    });
    seenFoldIds.add(b.id);
  }

  for (const l of rawLines) {
    if (l.foldEventId && !seenFoldIds.has(l.foldEventId)) {
      const known = blockById.get(l.foldEventId);
      folds.push({
        id: l.foldEventId,
        tier: known?.tier ?? 1,
        at: l.at,
        seq: l.seq,
        tokensBefore: known?.tokensBefore ?? 0,
        tokensAfter: known?.tokensAfter ?? 0,
        saved: known ? Math.max(0, known.tokensBefore - known.tokensAfter) : 0,
        topic: known?.topic ?? l.foldEventId,
      });
      seenFoldIds.add(l.foldEventId);
    }
  }

  folds.sort((a, b) => a.at - b.at);

  const causes = classifyLineCauses(rawLines, folds);
  const lines: TrajectoryLine[] = rawLines.map((l, i) => ({
    ...l,
    cause: causes[i] ?? "new",
  }));

  let peakInput = 0;
  let totalInput = 0;
  let totalCached = 0;
  for (const l of lines) {
    if (l.input > peakInput) peakInput = l.input;
    totalInput += l.input;
    totalCached += l.cached;
  }

  const baselineMeasured = Boolean(input.baselineTokens && input.baselineTokens > 0);
  const baselineTokens = baselineMeasured
    ? input.baselineTokens!
    : lines.length >= 20
      ? (() => {
          const ds = lines.map((l) => l.missed).sort((a, b) => a - b);
          return ds[Math.floor(ds.length * 0.1)] ?? 0;
        })()
      : 0;

  const reclaimedTotal = input.blocks
    .filter((b) => b.status === "active")
    .reduce((s, b) => s + Math.max(0, b.tokensBefore - b.tokensAfter), 0);

  return {
    lines,
    folds,
    windowTokens: Math.max(0, input.windowTokens || 0),
    baselineTokens,
    baselineMeasured,
    peakInput,
    latestInput: lines.length > 0 ? lines[lines.length - 1]!.input : 0,
    totalInput,
    totalCached,
    overallHitPct: totalInput > 0 ? (totalCached / totalInput) * 100 : null,
    reclaimedTotal,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtShortTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sliceTrajectory(
  data: TrajectoryData,
  range?: [number, number] | null,
): { lines: TrajectoryLine[]; folds: TrajectoryFoldMark[] } {
  if (!range || data.lines.length === 0) {
    return { lines: data.lines, folds: data.folds };
  }
  const a = Math.max(0, Math.min(data.lines.length - 1, range[0]));
  const b = Math.max(a, Math.min(data.lines.length - 1, range[1]));
  const lines = data.lines.slice(a, b + 1);
  const t0 = lines[0]?.at ?? 0;
  const t1 = lines[lines.length - 1]?.at ?? 0;
  const seqSet = new Set(lines.map((l) => l.seq));
  const folds = data.folds.filter(
    (f) => (f.seq != null && seqSet.has(f.seq)) || (f.at >= t0 && f.at <= t1),
  );
  return { lines, folds };
}

function renderFoldMarkLines(
  folds: readonly TrajectoryFoldMark[],
  lines: readonly TrajectoryLine[],
  x: (i: number) => number,
  PT: number,
  ih: number,
): string {
  let out = "";
  const buckets: { fx: number; items: TrajectoryFoldMark[] }[] = [];
  for (const f of folds) {
    let idx = lines.findIndex((l) => l.foldEventId === f.id || l.at >= f.at);
    if (idx < 0) idx = lines.length - 1;
    if (idx < 0) continue;
    const fx = x(idx);
    const hit = buckets.find((b) => Math.abs(b.fx - fx) <= 1.5);
    if (hit) hit.items.push(f);
    else buckets.push({ fx, items: [f] });
  }
  for (const bk of buckets) {
    const n = bk.items.length;
    const ids = bk.items
      .map((m) => m.id)
      .slice(0, 5)
      .join("·");
    const saved = bk.items.reduce((s, m) => s + m.saved, 0);
    const tip =
      `fold${n > 1 ? ` ×${n}` : ""} ${ids}${bk.items.length > 5 ? "…" : ""}` +
      ` · ${fmtShortTime(bk.items[0]!.at)}` +
      (saved > 0 ? ` · -${formatTokens(saved)}` : "");
    out +=
      `<line x1="${bk.fx.toFixed(1)}" y1="${PT}" x2="${bk.fx.toFixed(1)}" y2="${PT + ih}" ` +
      `stroke="var(--accent-red, #ef4444)" stroke-width="1.3" stroke-dasharray="3 3">` +
      `<title>${escapeXml(tip)}</title></line>`;
  }
  return out;
}

function renderSeqTickLines(
  lines: readonly TrajectoryLine[],
  x: (i: number) => number,
  W: number,
  H: number,
  PL: number,
  PR: number,
): string {
  const barW = lines.length > 1 ? (W - PL - PR) / (lines.length - 1) : 1;
  const tStep = Math.max(1, Math.ceil(24 / barW));
  const xtArr: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= tStep) {
    const l = lines[i]!;
    xtArr.push(
      `<text transform="translate(${x(i).toFixed(1)},${H - 28}) rotate(-90)" ` +
        `text-anchor="end" font-size="10" fill="var(--text-muted)">${l.seq}</text>`,
    );
  }
  const firstAt = lines[0]?.at;
  const lastAt = lines.length > 1 ? lines[lines.length - 1]?.at : undefined;
  const xtTime =
    (firstAt
      ? `<text x="${PL}" y="${H - 8}" text-anchor="start" font-size="9.5" fill="var(--text-muted)">${escapeXml(fmtShortTime(firstAt))}</text>`
      : "") +
    (lastAt
      ? `<text x="${W - PR}" y="${H - 8}" text-anchor="end" font-size="9.5" fill="var(--text-muted)">${escapeXml(fmtShortTime(lastAt))}</text>`
      : "");
  return xtArr.join("") + xtTime;
}

/**
 * Ported from billion-context `trajectorySvg`: renders per-request input tokens,
 * cached prefix area, cause-attributed uncached gap bands, fold markers, context
 * window ceiling, and non-compressible baseline floor as a crisp responsive SVG.
 */
export function renderTrajectorySvg(data: TrajectoryData, range?: [number, number] | null): string {
  const { lines, folds } = sliceTrajectory(data, range);
  if (lines.length === 0) return "";

  const W = TRAJ_W;
  const H = TRAJ_H;
  const PL = TRAJ_PL;
  const PR = TRAJ_PR;
  const PT = TRAJ_PT;
  const PB = TRAJ_PB;
  const iw = W - PL - PR;
  const ih = H - PT - PB;

  let maxY = 0;
  for (const l of lines) {
    if (l.input > maxY) maxY = l.input;
  }
  if (data.windowTokens > 0 && data.windowTokens > maxY) {
    maxY = data.windowTokens * 1.05;
  }
  if (maxY <= 0) maxY = 1;

  const x = (i: number) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
  const y = (v: number) => PT + ih - (Math.max(0, v) / maxY) * ih;

  let grid = "";
  let ticks = "";
  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g;
    const yy = y(v);
    grid += `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" stroke="var(--border-subtle, var(--border))" stroke-width="1"/>`;
    ticks += `<text x="${PL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${formatTokens(Math.round(v))}</text>`;
  }

  let area = `M${x(0).toFixed(1)},${y(lines[0]!.input).toFixed(1)}`;
  let stroke = "";
  lines.forEach((l, i) => {
    area += ` L${x(i).toFixed(1)},${y(l.cached).toFixed(1)}`;
    stroke += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(l.input).toFixed(1)} `;
  });
  area += ` L${x(lines.length - 1).toFixed(1)},${(PT + ih).toFixed(1)} L${x(0).toFixed(1)},${(PT + ih).toFixed(1)} Z`;

  let bands = "";
  let hovers = "";
  const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
  lines.forEach((l, i) => {
    const c = l.cause;
    const yIn = y(l.input);
    const yCa = y(l.cached);
    const x0 = Math.max(PL, x(i) - swSeg / 2);
    const x1 = Math.min(W - PR, x(i) + swSeg / 2);
    if (c !== "new") {
      const color = CAUSE_COLOR[c];
      bands +=
        `<rect x="${x0.toFixed(1)}" y="${yIn.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" ` +
        `height="${Math.max(3, yCa - yIn).toFixed(1)}" fill="${color}" opacity="0.35" rx="1"/>`;
      bands +=
        `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${(yCa - 2).toFixed(1)}" ` +
        `y2="${(PT + ih).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.45"/>`;
    }
    const hitPctLine = l.hitPct != null ? `${l.hitPct.toFixed(1)}%` : "—";
    const tip =
      `#${l.seq} · ${fmtShortTime(l.at)}\n` +
      `in ${formatTokens(l.input)} · cached ${formatTokens(l.cached)} · missed ${formatTokens(l.missed)} · hit ${hitPctLine}` +
      (c === "new" ? "" : `\n${CAUSE_LABEL[c]}`);
    hovers +=
      `<rect x="${x0.toFixed(1)}" y="${PT}" width="${Math.max(1, x1 - x0).toFixed(1)}" ` +
      `height="${ih}" fill="transparent"><title>${escapeXml(tip)}</title></rect>`;
  });

  const singleDot =
    lines.length === 1
      ? `<circle cx="${x(0).toFixed(1)}" cy="${y(lines[0]!.input).toFixed(1)}" r="3.5" fill="var(--accent-cyan, var(--accent))"/>`
      : "";

  const foldMarks = renderFoldMarkLines(folds, lines, x, PT, ih);

  let ceiling = "";
  if (data.windowTokens > 0) {
    const yy = y(data.windowTokens);
    ceiling =
      `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" ` +
      `stroke="var(--accent-red, #ef4444)" stroke-width="1.5" stroke-dasharray="6 4"/>` +
      `<text x="${W - PR}" y="${Math.max(10, yy - 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--accent-red, #ef4444)">` +
      `context window ${formatTokens(data.windowTokens)}</text>`;
  }

  let baseline = "";
  if (data.baselineTokens >= 200 && data.baselineTokens < maxY) {
    const yy = y(data.baselineTokens);
    const label = data.baselineMeasured ? "baseline (sys+tools)" : "est. baseline";
    baseline =
      `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" ` +
      `stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="2 4"/>` +
      `<text x="${PL + 4}" y="${Math.max(10, yy - 4).toFixed(1)}" font-size="9.5" fill="var(--text-muted)">` +
      `${label} ${formatTokens(data.baselineTokens)}</text>`;
  }

  const xt = renderSeqTickLines(lines, x, W, H, PL, PR);
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img">` +
    grid +
    `<path d="${area}" fill="var(--accent-cyan, var(--accent))" opacity="0.18"/>` +
    bands +
    hovers +
    `<path d="${stroke.trim()}" fill="none" stroke="var(--accent-cyan, var(--accent))" stroke-width="1.8"/>` +
    singleDot +
    foldMarks +
    ceiling +
    baseline +
    ticks +
    xt +
    `</svg>`
  );
}

/**
 * Ported from billion-context `hitRateSvg`: fixed 0–100% Y axis with cause-colored
 * dip markers and fold verticals over the exact same sample geometry.
 */
export function renderHitRateSvg(data: TrajectoryData, range?: [number, number] | null): string {
  const { lines, folds } = sliceTrajectory(data, range);
  if (lines.length === 0) return "";

  const W = TRAJ_W;
  const H = TRAJ_H;
  const PL = TRAJ_PL;
  const PR = TRAJ_PR;
  const PT = TRAJ_PT;
  const PB = TRAJ_PB;
  const iw = W - PL - PR;
  const ih = H - PT - PB;

  const x = (i: number) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
  const y = (pct: number) => PT + ih - (Math.max(0, Math.min(100, pct)) / 100) * ih;

  let grid = "";
  let ticks = "";
  for (let g = 0; g <= 4; g++) {
    const v = 25 * g;
    const yy = y(v);
    grid += `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" stroke="var(--border-subtle, var(--border))" stroke-width="1"/>`;
    ticks += `<text x="${PL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${v}%</text>`;
  }

  let stroke = "";
  let started = false;
  lines.forEach((l, i) => {
    if (l.hitPct == null) {
      started = false;
      return;
    }
    stroke += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(l.hitPct).toFixed(1)} `;
    started = true;
  });

  let dots = "";
  let hovers = "";
  const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
  lines.forEach((l, i) => {
    const c = l.cause;
    const x0 = Math.max(PL, x(i) - swSeg / 2);
    const x1 = Math.min(W - PR, x(i) + swSeg / 2);
    if (l.hitPct != null && c !== "new") {
      dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(l.hitPct).toFixed(1)}" r="2.8" fill="${CAUSE_COLOR[c]}"/>`;
    }
    const hitTxt = l.hitPct == null ? "—" : `${l.hitPct.toFixed(1)}%`;
    const tip =
      `#${l.seq} · ${fmtShortTime(l.at)}\n` +
      `in ${formatTokens(l.input)} · cached ${formatTokens(l.cached)} · missed ${formatTokens(l.missed)} · hit ${hitTxt}` +
      (c === "new" ? "" : `\n${CAUSE_LABEL[c]}`);
    hovers +=
      `<rect x="${x0.toFixed(1)}" y="${PT}" width="${Math.max(1, x1 - x0).toFixed(1)}" ` +
      `height="${ih}" fill="transparent"><title>${escapeXml(tip)}</title></rect>`;
  });

  const singleDot =
    lines.length === 1 && lines[0]!.hitPct != null && lines[0]!.cause === "new"
      ? `<circle cx="${x(0).toFixed(1)}" cy="${y(lines[0]!.hitPct!).toFixed(1)}" r="3.2" fill="var(--accent-green, #10b981)"/>`
      : "";

  const foldMarks = renderFoldMarkLines(folds, lines, x, PT, ih);
  const xt = renderSeqTickLines(lines, x, W, H, PL, PR);

  return (
    `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img">` +
    grid +
    (stroke.trim()
      ? `<path d="${stroke.trim()}" fill="none" stroke="var(--accent-green, #10b981)" stroke-width="1.8"/>`
      : "") +
    dots +
    singleDot +
    hovers +
    foldMarks +
    ticks +
    xt +
    `</svg>`
  );
}

const VBLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface BinnedColumn {
  seqStart: number;
  seqEnd: number;
  input: number;
  cached: number;
  hitPct: number | null;
  cause: TrajectoryCause;
  hasFold: boolean;
  foldIds: string[];
}

export function binTrajectoryColumns(data: TrajectoryData, maxCols: number, expand = true): BinnedColumn[] {
  const { lines, folds } = data;
  if (lines.length === 0 || maxCols <= 0) return [];

  const foldSeqMap = new Map<number, string[]>();
  for (const f of folds) {
    let seq = f.seq;
    if (seq == null && lines.length > 0) {
      const hit = lines.find((l) => l.at >= f.at);
      seq = hit ? hit.seq : lines[lines.length - 1]!.seq;
    }
    if (seq != null) {
      const arr = foldSeqMap.get(seq) ?? [];
      arr.push(f.id);
      foldSeqMap.set(seq, arr);
    }
  }

  if (lines.length === 1) {
    const l = lines[0]!;
    const fIds = foldSeqMap.get(l.seq) ?? [];
    return [{
      seqStart: l.seq,
      seqEnd: l.seq,
      input: l.input,
      cached: l.cached,
      hitPct: l.hitPct,
      cause: l.cause,
      hasFold: fIds.length > 0,
      foldIds: fIds,
    }];
  }

  if (!expand) {
    if (lines.length <= maxCols) {
      return lines.map((l) => {
        const fIds = foldSeqMap.get(l.seq) ?? [];
        return {
          seqStart: l.seq,
          seqEnd: l.seq,
          input: l.input,
          cached: l.cached,
          hitPct: l.hitPct,
          cause: l.cause,
          hasFold: fIds.length > 0,
          foldIds: fIds,
        };
      });
    }
  } else if (lines.length <= maxCols) {
    const targetCols = Math.min(maxCols, Math.max(lines.length, Math.min(64, lines.length * 3)));
    if (targetCols === lines.length) {
      return lines.map((l) => {
        const fIds = foldSeqMap.get(l.seq) ?? [];
        return {
          seqStart: l.seq,
          seqEnd: l.seq,
          input: l.input,
          cached: l.cached,
          hitPct: l.hitPct,
          cause: l.cause,
          hasFold: fIds.length > 0,
          foldIds: fIds,
        };
      });
    }
    const foldColMap = new Map<number, string[]>();
    lines.forEach((l, i) => {
      const fIds = foldSeqMap.get(l.seq);
      if (fIds && fIds.length > 0) {
        const colIdx = Math.round((i * (targetCols - 1)) / (lines.length - 1));
        const prev = foldColMap.get(colIdx) ?? [];
        prev.push(...fIds);
        foldColMap.set(colIdx, prev);
      }
    });
    const expanded: BinnedColumn[] = [];
    for (let c = 0; c < targetCols; c++) {
      const pos = (c * (lines.length - 1)) / (targetCols - 1);
      const loIdx = Math.floor(pos);
      const hiIdx = Math.min(lines.length - 1, Math.ceil(pos));
      const t = pos - loIdx;
      const lo = lines[loIdx]!;
      const hi = lines[hiIdx]!;
      const near = t < 0.5 ? lo : hi;
      const input = Math.round(lo.input + (hi.input - lo.input) * t);
      const cached = Math.round(lo.cached + (hi.cached - lo.cached) * t);
      const fIds = foldColMap.get(c) ?? [];
      expanded.push({
        seqStart: near.seq,
        seqEnd: near.seq,
        input,
        cached,
        hitPct: input > 0 ? (cached / input) * 100 : null,
        cause: near.cause,
        hasFold: fIds.length > 0,
        foldIds: fIds,
      });
    }
    return expanded;
  }

  const cols: BinnedColumn[] = [];
  for (let c = 0; c < maxCols; c++) {
    const startIdx = Math.floor((c * lines.length) / maxCols);
    const endIdx = Math.max(startIdx + 1, Math.floor(((c + 1) * lines.length) / maxCols));
    const slice = lines.slice(startIdx, endIdx);
    let maxIn = 0;
    let maxCa = 0;
    let sumIn = 0;
    let sumCa = 0;
    let dominantCause: TrajectoryCause = "new";
    const foldIds: string[] = [];

    for (const s of slice) {
      if (s.input >= maxIn) {
        maxIn = s.input;
        maxCa = s.cached;
      }
      sumIn += s.input;
      sumCa += s.cached;
      if (s.cause === "seam") dominantCause = "seam";
      else if (s.cause === "comp" && dominantCause !== "seam") dominantCause = "comp";
      else if (s.cause !== "new" && dominantCause === "new") dominantCause = s.cause;

      const fIds = foldSeqMap.get(s.seq);
      if (fIds) foldIds.push(...fIds);
    }
    cols.push({
      seqStart: slice[0]!.seq,
      seqEnd: slice[slice.length - 1]!.seq,
      input: maxIn,
      cached: maxCa,
      hitPct: sumIn > 0 ? (sumCa / sumIn) * 100 : null,
      cause: dominantCause,
      hasFold: foldIds.length > 0,
      foldIds,
    });
  }
  return cols;
}

/**
 * Multi-row ANSI TUI Context Trajectory + Cache Hit Rate chart using sub-cell
 * 1/8th Unicode blocks, fold event markers (`┆`), window ceiling (`┄`), and
 * cause-colored uncached gaps.
 */
export function renderAnsiTrajectory(data: TrajectoryData, width: number, plotRows = 8): string[] {
  const safeWidth = Math.max(30, width);
  if (data.lines.length === 0) {
    return [
      theme.fg("muted", "Context Trajectory"),
      theme.fg("dim", "  No request rounds recorded for this session yet."),
      theme.fg("dim", "  Input tokens, cached prefix area, and fold drops appear after the first model turn."),
    ];
  }

  const labelW = 7;
  const plotCols = Math.max(8, Math.min(safeWidth - labelW - 2, 72));
  const cols = binTrajectoryColumns(data, plotCols);

  // Domain ceiling: show peakInput comfortably, or windowTokens when close (>35% of window)
  let domainMax = Math.max(1, data.peakInput);
  const showCeilingRow = data.windowTokens > 0 && data.peakInput >= data.windowTokens * 0.35;
  if (showCeilingRow && data.windowTokens > domainMax) {
    domainMax = Math.round(data.windowTokens * 1.05);
  } else {
    domainMax = Math.round(domainMax * 1.08);
  }

  const ceilingRow =
    showCeilingRow && data.windowTokens > 0
      ? Math.min(plotRows - 1, Math.max(0, Math.round(((domainMax - data.windowTokens) / domainMax) * (plotRows - 1))))
      : -1;
  const baselineRow =
    data.baselineTokens >= 200 && data.baselineTokens < domainMax
      ? Math.min(plotRows - 1, Math.max(0, Math.round(((domainMax - data.baselineTokens) / domainMax) * (plotRows - 1))))
      : -1;

  const out: string[] = [];
  const hitSummary = data.overallHitPct != null ? `${data.overallHitPct.toFixed(1)}%` : "—";
  const header =
    `${theme.bold(theme.fg("accent", "Context Trajectory"))}  ` +
    `${theme.fg("muted", `latest ${formatTokens(data.latestInput)}`)}` +
    `${theme.fg("dim", " · ")}` +
    `${theme.fg("muted", `peak ${formatTokens(data.peakInput)}`)}` +
    (data.windowTokens > 0
      ? `${theme.fg("dim", " · ")}${theme.fg("muted", `window ${formatTokens(data.windowTokens)}`)}`
      : "") +
    `${theme.fg("dim", " · ")}` +
    `${theme.fg("success", `hit ${hitSummary}`)}`;
  out.push(truncateToWidth(header, safeWidth));

  for (let r = 0; r < plotRows; r++) {
    const rowTopVal = domainMax * (1 - r / plotRows);
    const isTick = r === 0 || r === Math.floor(plotRows / 2) || r === plotRows - 1;
    const yLabel = isTick
      ? formatTokens(r === plotRows - 1 ? 0 : Math.round(rowTopVal)).padStart(labelW - 1)
      : " ".repeat(labelW - 1);
    const axisGlyph = isTick ? "┤" : "│";
    let rowStr = `${theme.fg("dim", yLabel)}${theme.fg("border", axisGlyph)}`;

    const cellLow = domainMax * ((plotRows - 1 - r) / plotRows);
    const cellSpan = domainMax / plotRows;

    for (let c = 0; c < cols.length; c++) {
      const col = cols[c]!;
      const inUnits = Math.max(0, Math.min(8, Math.round(((col.input - cellLow) / cellSpan) * 8)));
      const caUnits = Math.max(0, Math.min(8, Math.round(((col.cached - cellLow) / cellSpan) * 8)));

      if (inUnits <= 0) {
        if (col.hasFold) {
          rowStr += theme.fg("error", "┆");
        } else if (r === ceilingRow) {
          rowStr += theme.fg("error", "┄");
        } else if (r === baselineRow) {
          rowStr += theme.fg("dim", "┈");
        } else {
          rowStr += " ";
        }
      } else {
        const ch = VBLOCKS[inUnits]!;
        if (caUnits >= inUnits) {
          rowStr += theme.fg("accent", ch);
        } else if (col.cause === "comp") {
          rowStr += theme.fg("warning", ch);
        } else if (col.cause === "seam") {
          rowStr += theme.fg("error", ch);
        } else if (col.cause === "cold" || col.cause === "rest") {
          rowStr += theme.fg("muted", ch);
        } else {
          rowStr += theme.fg("accent", ch);
        }
      }
    }

    if (r === ceilingRow && visibleWidth(rowStr) + 12 <= safeWidth) {
      rowStr += ` ${theme.fg("error", `win ${formatTokens(data.windowTokens)}`)}`;
    } else if (r === baselineRow && baselineRow !== ceilingRow && visibleWidth(rowStr) + 12 <= safeWidth) {
      rowStr += ` ${theme.fg("dim", `base ${formatTokens(data.baselineTokens)}`)}`;
    }

    out.push(truncateToWidth(rowStr, safeWidth));
  }

  // X-axis rule + fold tick callouts
  let xAxis = `${" ".repeat(labelW - 1)}${theme.fg("border", "└")}`;
  for (let c = 0; c < cols.length; c++) {
    xAxis += cols[c]!.hasFold ? theme.fg("error", "┴") : theme.fg("border", "─");
  }
  out.push(truncateToWidth(xAxis, safeWidth));

  // Sequence range & fold labels row
  const firstSeq = `#${cols[0]!.seqStart}`;
  const lastSeq = `#${cols[cols.length - 1]!.seqEnd}`;
  const foldSummary =
    data.folds.length > 0
      ? data.folds
          .slice(-4)
          .map((f) => `${f.id}(-${formatTokens(f.saved)})`)
          .join(" ")
      : "";
  const padBetween = Math.max(1, cols.length - firstSeq.length - lastSeq.length);
  const seqLine =
    `${" ".repeat(labelW)}${theme.fg("dim", firstSeq)}` +
    `${" ".repeat(padBetween)}${theme.fg("dim", lastSeq)}` +
    (foldSummary ? `  ${theme.fg("error", `┆ ${foldSummary}`)}` : "");
  out.push(truncateToWidth(seqLine, safeWidth));

  // 1-line Cache Hit Rate sparkline strip aligned with columns
  let spark = `${theme.fg("dim", "hit %".padStart(labelW - 1))}${theme.fg("border", "│")}`;
  for (const col of cols) {
    if (col.hitPct == null) {
      spark += theme.fg("dim", "·");
      continue;
    }
    const idx = Math.max(1, Math.min(8, Math.round((col.hitPct / 100) * 8)));
    const tone = col.hitPct >= 85 ? "success" : col.hitPct >= 50 ? "warning" : "error";
    spark += theme.fg(tone, VBLOCKS[idx]!);
  }
  out.push(truncateToWidth(spark, safeWidth));

  // Legend
  const legend =
    `${" ".repeat(labelW)}` +
    `${theme.fg("accent", "█")} ${theme.fg("muted", "cached/input")}  ` +
    `${theme.fg("warning", "█")} ${theme.fg("muted", "post-fold rebuild")}  ` +
    `${theme.fg("muted", "█")} ${theme.fg("muted", "cold/TTL")}  ` +
    `${theme.fg("error", "┆")} ${theme.fg("muted", "fold")}`;
  out.push(truncateToWidth(legend, safeWidth));

  return out;
}

/**
 * Native Tern TSP descriptors for Context Trajectory (`kind: "spark"`) and
 * Prompt Cache Hit Rate (`kind: "spark"`), plus fold & round summary table.
 */
export function describeNativeTrajectory(data: TrajectoryData, maxCols = 70): NativeNode[] {
  if (data.lines.length === 0) {
    return [
      text([span("No request rounds recorded for this session yet.", "muted")], {
        role: "omp.origami.empty",
      }),
    ];
  }

  const foldBySeq = new Map<number, TrajectoryFoldMark[]>();
  for (const f of data.folds) {
    if (f.seq != null) {
      const list = foldBySeq.get(f.seq) ?? [];
      list.push(f);
      foldBySeq.set(f.seq, list);
    }
  }

  const binned = binTrajectoryColumns(data, maxCols, false);
  const series = binned.map((c) => {
    const tone: TspTone | undefined =
      c.cause === "seam"
        ? "error"
        : c.hasFold || c.cause === "comp"
          ? "warning"
          : c.cause === "cold" || c.cause === "rest"
            ? "muted"
            : undefined;
    const hitStr = c.hitPct != null ? `${c.hitPct.toFixed(1)}%` : "—";
    const foldNote =
      c.foldIds.length > 0 ? `\nfold ${c.foldIds.join(", ")}` : "";
    const causeNote = c.cause !== "new" ? `\n${CAUSE_LABEL[c.cause]}` : "";
    const seqLabel =
      c.seqStart === c.seqEnd ? `#${c.seqStart}` : `#${c.seqStart}..#${c.seqEnd}`;
    const inLabel =
      c.seqStart === c.seqEnd
        ? `in ${formatTokens(c.input)}`
        : `peak in ${formatTokens(c.input)}`;
    return {
      label: seqLabel,
      value: c.input,
      ...(tone ? { tone } : {}),
      title: `${seqLabel} · ${inLabel} · cached ${formatTokens(c.cached)} · hit ${hitStr}${foldNote}${causeNote}`,
    };
  });

  const marks: NativeChartMark[] = [];
  if (data.windowTokens > 0 && data.peakInput >= data.windowTokens * 0.25) {
    marks.push({
      value: data.windowTokens,
      tone: "error",
      title: `Context window ${formatTokens(data.windowTokens)}`,
    });
  }
  if (data.baselineTokens >= 200) {
    marks.push({
      value: data.baselineTokens,
      tone: "muted",
      title: `${data.baselineMeasured ? "Baseline (sys+tools)" : "Estimated baseline"} ${formatTokens(data.baselineTokens)}`,
    });
  }

  const maxDomain =
    data.windowTokens > 0 && data.peakInput >= data.windowTokens * 0.5
      ? Math.round(data.windowTokens * 1.05)
      : Math.max(1, Math.round(data.peakInput * 1.08));

  const trajSummary: TspSpan[] = [
    span("Context Trajectory", "strong"),
    span(` · latest ${formatTokens(data.latestInput)} · peak ${formatTokens(data.peakInput)}`, "muted"),
    ...(data.folds.length > 0
      ? [span(` · ${data.folds.length} fold(s) (-${formatTokens(data.reclaimedTotal)})`, "accent")]
      : []),
  ];

  const hitSeries = binned.map((c) => {
    const pct = c.hitPct ?? 0;
    const tone: TspTone | undefined =
      pct >= 85 ? undefined : pct >= 50 ? "warning" : "error";
    const seqLabel =
      c.seqStart === c.seqEnd ? `#${c.seqStart}` : `#${c.seqStart}..#${c.seqEnd}`;
    return {
      label: seqLabel,
      value: Math.round(pct * 10) / 10,
      ...(tone ? { tone } : {}),
      title: `${seqLabel} · hit ${c.hitPct != null ? `${c.hitPct.toFixed(1)}%` : "—"} (${formatTokens(c.cached)} / ${formatTokens(c.input)})`,
    };
  });

  const hitSummary: TspSpan[] = [
    span("Prompt Cache Hit Rate", "strong"),
    span(
      ` · overall ${data.overallHitPct != null ? `${data.overallHitPct.toFixed(1)}%` : "—"} (${formatTokens(data.totalCached)} / ${formatTokens(data.totalInput)})`,
      "muted",
    ),
  ];

  // Added by newer TSP revisions; older terminals ignore unknown optional fields.
  const trajectoryDomain: Record<string, unknown> = { min: 0, max: maxDomain, ...(marks.length > 0 ? { marks } : {}) };
  const hitDomain: Record<string, unknown> = { min: 0, max: 100, marks: [{ value: 85, tone: "muted", title: "Warm cache threshold (85%)" }] };

  const nodes: NativeNode[] = [
    node(
      "chart",
      {
        kind: "spark",
        size: "lg",
        ...trajectoryDomain,
        token: "accent",
        series,
        summary: trajSummary,
      },
      undefined,
      "traj-chart",
    ),
    node(
      "chart",
      {
        kind: "spark",
        size: "md",
        ...hitDomain,
        token: "success",
        series: hitSeries,
        summary: hitSummary,
      },
      undefined,
      "hit-chart",
    ),
  ];

  // Compact recent ledger table
  const recent = data.lines.slice(-10).reverse();
  nodes.push(
    node(
      "table",
      {
        cols: [
          { id: "seq", head: "#", align: "end" },
          { id: "time", head: "Time" },
          { id: "input", head: "Input", align: "end" },
          { id: "cached", head: "Cached", align: "end" },
          { id: "hit", head: "Hit %", align: "end" },
          { id: "attr", head: "Attribution", grow: 1 },
        ],
        rows: recent.map((l) => {
          const hitStr = l.hitPct != null ? `${l.hitPct.toFixed(1)}%` : "—";
          const hitToken = l.hitPct == null ? "dim" : l.hitPct >= 85 ? "success" : l.hitPct >= 50 ? "warning" : "error";
          const attrParts: TspSpan[] = [];
          if (l.foldEventId) attrParts.push(span(`fold ${l.foldEventId}`, "accent"));
          if (l.cause !== "new") {
            if (attrParts.length > 0) attrParts.push(span(" · ", "dim"));
            attrParts.push(
              span(
                CAUSE_LABEL[l.cause],
                l.cause === "seam" ? "error" : l.cause === "comp" ? "warning" : "muted",
              ),
            );
          }
          if (attrParts.length === 0) attrParts.push(span("prefix hit", "dim"));
          return {
            id: `r-${l.seq}`,
            cells: {
              seq: [span(`#${l.seq}`, "mono")],
              time: [span(new Date(l.at).toISOString().slice(11, 19), "mono muted")],
              input: [span(formatTokens(l.input), "mono")],
              cached: [span(formatTokens(l.cached), "mono success")],
              hit: [span(hitStr, `${hitToken} mono`)],
              attr: attrParts,
            },
          };
        }),
      },
      undefined,
      "traj-table",
    ),
  );

  // Legend row
  nodes.push(
    row(
      [
        text([span("■ ", "accent"), span("input/cached", "muted")]),
        text([span("■ ", "warning"), span("post-fold rebuild", "muted")]),
        text([span("■ ", "muted"), span("cold/TTL", "muted")]),
        text([span("■ ", "error"), span("seam/window", "muted")]),
      ],
      { gap: "md", wrap: true, role: "omp.origami.legend" },
    ),
  );

  return nodes;
}
