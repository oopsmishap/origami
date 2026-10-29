/**
 * Pre-commit coverage lint: which manifest items (paths, commits, leading errors) a
 * summary never mentions. Missing items are attached to the block as "Also covered"
 * so a later reader still knows to recall them; lint never rejects a fold.
 */
import type { BlockManifest } from "./manifest.ts";

export interface SummaryLint {
  required: number;
  missing: string[];
}

const LINTED_ERRORS = 3;

function mentionsPath(text: string, path: string): boolean {
  if (text.includes(path)) return true;
  const segments = path.split("/").filter(Boolean);
  return segments.length >= 2 && text.includes(segments.slice(-2).join("/"));
}

export function lintSummary(text: string, manifest: BlockManifest): SummaryLint {
  const missing: string[] = [];
  let required = 0;
  for (const p of manifest.paths) {
    required++;
    if (!mentionsPath(text, p)) missing.push(`path ${p}`);
  }
  for (const c of manifest.commits) {
    required++;
    if (!text.includes(c.slice(0, 7))) missing.push(`commit ${c.slice(0, 7)}`);
  }
  for (const e of manifest.errors.slice(0, LINTED_ERRORS)) {
    required++;
    if (!text.includes(e.slice(0, 40))) missing.push(`error ${e.slice(0, 80)}`);
  }
  return { required, missing };
}
