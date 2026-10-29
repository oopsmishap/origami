/**
 * Harness-driven recall: when the current turn touches files, symbols, errors or commits
 * a folded block's manifest recorded, tell the model which block to recall instead of
 * trusting it to remember that the work was folded.
 */
import type { Block } from "./types.ts";

export interface RecallHint {
  blockId: string;
  coverage: string;
  topic: string;
  matched: string[];
}

const MAX_MATCHED_SHOWN = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathMatches(probe: string, path: string): boolean {
  if (probe.includes(path)) return true;
  const segments = path.split("/").filter(Boolean);
  return segments.length >= 2 && probe.includes(segments.slice(-2).join("/"));
}

export function matchRecallHints(i: { blocks: readonly Block[]; probe: string; exclude: ReadonlySet<string>; max: number }): RecallHint[] {
  if (i.max <= 0 || i.probe.length === 0) return [];
  const scored: { block: Block; matched: string[] }[] = [];
  for (const block of i.blocks) {
    const m = block.manifest;
    if (block.status !== "active" || !m || i.exclude.has(block.id)) continue;
    const matched: string[] = [];
    for (const p of m.paths) if (pathMatches(i.probe, p)) matched.push(p);
    for (const s of m.symbols) {
      if (new RegExp(`(?<![\\w$])${escapeRegExp(s)}(?![\\w$])`).test(i.probe)) matched.push(s);
    }
    for (const e of m.errors) if (i.probe.includes(e.slice(0, 40))) matched.push(e);
    for (const c of m.commits) if (i.probe.includes(c.slice(0, 7))) matched.push(c);
    if (matched.length > 0) scored.push({ block, matched });
  }
  scored.sort((a, b) => b.matched.length - a.matched.length || b.block.createdAt - a.block.createdAt);
  return scored.slice(0, i.max).map(({ block, matched }) => ({
    blockId: block.id,
    coverage: block.ranges.map((r) => (r.start === r.end ? r.start : `${r.start}..${r.end}`)).join(","),
    topic: block.topic,
    matched: matched.slice(0, MAX_MATCHED_SHOWN),
  }));
}

export function formatRecallHints(h: readonly RecallHint[]): string {
  return [
    "[origami recall] Folded history matches your current work:",
    ...h.map((x) => `- ${x.blockId} (${x.coverage}) "${x.topic}" — matches: ${x.matched.join(", ")}`),
    "Use fold_recall on those refs (or fold_search) before relying on memory of that work.",
  ].join("\n");
}
