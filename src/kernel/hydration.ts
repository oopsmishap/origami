/**
 * Just-In-Time (JIT) Reactive Hydration — Dynamic Ghost Pointers.
 *
 * Solves the documented 0% spontaneous model retrieval adoption:
 * When the active turn touches files, symbols, errors, or commits recorded in a
 * folded block's manifest, Origami automatically and reactively hydrates the
 * exact pinned decisions, constraints, and interface contracts from that block
 * directly into an ephemeral tail message for the upcoming turn.
 *
 * Zero manual search turns required. Zero KV-cache invalidation of the stable prefix.
 */
import type { Block, LedgerRecord } from "./types.ts";
import { pathMentioned } from "./manifest.ts";

export interface HydrationMatch {
  blockId: string;
  coverage: string;
  topic: string;
  matched: string[];
  ledger: LedgerRecord[];
  summaryExcerpts: string[];
  ghostPointers: string[];
}

export interface HydrationOptions {
  blocks: readonly Block[];
  probe: string;
  exclude?: ReadonlySet<string>;
  maxBlocks?: number;
  maxRecordsPerBlock?: number;
  maxCharsPerBlock?: number;
  mode?: "decisions" | "full" | "pointers";
}

const DEFAULT_MAX_BLOCKS = 2;
const DEFAULT_MAX_RECORDS = 3;
const DEFAULT_MAX_CHARS = 600;
const MAX_MATCHED_DISPLAY = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(p: string): string {
  return p.replace(/^(\.\.\/|\.\/)+/, "").replace(/\\/g, "/");
}

function pathMatches(probe: string, path: string): boolean {
  return pathMentioned(probe, path);
}

export function matchHydration(options: HydrationOptions): HydrationMatch[] {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxRecords = options.maxRecordsPerBlock ?? DEFAULT_MAX_RECORDS;
  const maxChars = options.maxCharsPerBlock ?? DEFAULT_MAX_CHARS;
  const mode = options.mode ?? "decisions";

  if (maxBlocks <= 0 || !options.probe || options.probe.trim().length === 0) return [];

  const scored: {
    block: Block;
    matched: string[];
    score: number;
  }[] = [];

  for (const block of options.blocks) {
    if (block.status !== "active" || !block.manifest) continue;
    if (options.exclude?.has(block.id)) continue;

    const m = block.manifest;
    const matched: string[] = [];
    let score = 0;

    for (const p of m.paths) {
      if (pathMatches(options.probe, p)) {
        matched.push(p);
        score += 10;
      }
    }
    for (const s of m.symbols) {
      if (new RegExp(`(?<![\\w$])${escapeRegExp(s)}(?![\\w$])`).test(options.probe)) {
        matched.push(s);
        score += 8;
      }
    }
    for (const e of m.errors) {
      if (options.probe.includes(e.slice(0, 40))) {
        matched.push(e);
        score += 12;
      }
    }
    for (const c of m.commits) {
      if (options.probe.includes(c.slice(0, 7))) {
        matched.push(c);
        score += 10;
      }
    }

    if (matched.length > 0) {
      scored.push({ block, matched: [...new Set(matched)], score });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || b.block.createdAt - a.block.createdAt);

  const selectedBlocks = scored.slice(0, maxBlocks);
  const out: HydrationMatch[] = [];

  for (const { block, matched } of selectedBlocks) {
    const coverage = block.ranges.map((r) => (r.start === r.end ? r.start : `${r.start}..${r.end}`)).join(",");
    const ghostPointers: string[] = [];

    // 1. Ledger Extraction
    let selectedLedger: LedgerRecord[] = [];
    if (mode !== "pointers" && block.ledger && block.ledger.length > 0) {
      const records = block.ledger;
      // Score records: relevance to matched paths/symbols first, then constraints > decisions > objectives
      const recordScored = records.map((rec) => {
        let recScore = 0;
        const normText = rec.text.toLowerCase();
        for (const item of matched) {
          const normItem = normalizePath(item).toLowerCase();
          if (normText.includes(normItem)) recScore += 15;
          const baseName = normItem.split("/").pop();
          if (baseName && baseName.length >= 4 && normText.includes(baseName)) recScore += 8;
        }
        if (rec.kind === "constraint") recScore += 50;
        else if (rec.kind === "decision") recScore += 40;
        else if (rec.kind === "objective") recScore += 20;
        else if (rec.kind === "intent") recScore += 5;
        return { rec, recScore };
      });

      recordScored.sort((a, b) => b.recScore - a.recScore);

      let totalChars = 0;
      for (const { rec } of recordScored) {
        if (selectedLedger.length >= maxRecords) break;
        const clippedText = rec.text.length > 250 ? `${rec.text.slice(0, 247)}...` : rec.text;
        if (totalChars + clippedText.length > maxChars && selectedLedger.length > 0) continue;
        selectedLedger.push(clippedText === rec.text ? rec : { ...rec, text: clippedText });
        totalChars += clippedText.length;
        if (rec.ref) {
          ghostPointers.push(`${block.id}#${rec.ref}`);
        }
      }
    }

    // 2. Summary Excerpts
    const summaryExcerpts: string[] = [];
    if (mode === "full" && block.summary) {
      const lines = block.summary.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (summaryExcerpts.length >= 2) break;
        const normLine = line.toLowerCase();
        const mentionsMatch = matched.some((m) => {
          const base = normalizePath(m).split("/").pop()?.toLowerCase();
          return normLine.includes(normalizePath(m).toLowerCase()) || (base && base.length >= 4 && normLine.includes(base));
        });
        if (mentionsMatch && !summaryExcerpts.includes(line)) {
          // Clean bullet prefix if present
          const cleaned = line.replace(/^[-*•]\s+/, "").slice(0, 180);
          summaryExcerpts.push(cleaned);
        }
      }
    }

    // If ghostPointers is empty, add coverage bounds
    if (ghostPointers.length === 0 && block.ranges.length > 0) {
      ghostPointers.push(`${block.id}#${block.ranges[0]!.start}`);
    }

    out.push({
      blockId: block.id,
      coverage,
      topic: block.topic,
      matched: matched.slice(0, MAX_MATCHED_DISPLAY),
      ledger: selectedLedger,
      summaryExcerpts,
      ghostPointers: [...new Set(ghostPointers)],
    });
  }

  return out;
}

export function formatHydration(matches: readonly HydrationMatch[]): string {
  if (matches.length === 0) return "";

  const lines: string[] = ["[origami hydration] Active context matches folded history:"];

  for (const m of matches) {
    const matchLine = `- ${m.blockId} (${m.coverage}) "${m.topic}" — matches: ${m.matched.join(", ")}`;
    lines.push(matchLine);

    for (const rec of m.ledger) {
      const refSuffix = rec.ref ? ` (${rec.ref})` : "";
      lines.push(`  • [${rec.kind}] ${rec.text}${refSuffix}`);
    }

    for (const excerpt of m.summaryExcerpts) {
      lines.push(`  • Context: ${excerpt}`);
    }

    if (m.ghostPointers.length > 0) {
      lines.push(`  • Ghost pointers: ${m.ghostPointers.join(", ")}`);
    }
  }

  lines.push("Key constraints and decisions are hydrated above. Deep raw lines remain accessible via fold_recall.");
  return lines.join("\n");
}
