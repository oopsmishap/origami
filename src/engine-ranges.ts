import type { RefRange } from "./kernel/types.ts";
import { formatRef, parseRangeSpec, parseRef } from "./kernel/types.ts";

export function parseRangeList(spec: string): RefRange[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseRangeSpec(s));
}

export function parseBlockRangeList(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("..");
    if (i < 0) {
      out.push(s);
      continue;
    }
    const a = s.slice(0, i).trim();
    const b = s.slice(i + 2).trim();
    const na = Number.parseInt(a.replace(/^b/, ""), 10);
    const nb = Number.parseInt(b.replace(/^b/, ""), 10);
    if (!Number.isInteger(na) || !Number.isInteger(nb)) throw new Error(`invalid block range: ${s}`);
    if (na > nb) throw new Error(`reversed block range: ${s}`);
    for (let n = na; n <= nb; n++) out.push(`b${n}`);
  }
  return out;
}

export function rangesFromRefs(refs: readonly string[]): RefRange[] {
  const nums = [...new Set(refs.map(parseRef))].sort((a, b) => a - b);
  const out: RefRange[] = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && parseRef(last.end) === n - 1) last.end = formatRef(n);
    else out.push({ start: formatRef(n), end: formatRef(n) });
  }
  return out;
}

export function formatCoverage(ranges: readonly RefRange[]): string {
  return ranges.map((r) => `${r.start}..${r.end}`).join(", ");
}

export function mergeRanges(ranges: readonly RefRange[]): RefRange[] {
  const sorted = [...ranges].sort((a, b) => parseRef(a.start) - parseRef(b.start));
  const out: RefRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && parseRef(r.start) <= parseRef(last.end) + 1) {
      if (parseRef(r.end) > parseRef(last.end)) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
