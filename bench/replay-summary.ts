import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FoldKeep, FoldSpec } from "../src/engine.ts";

export type ReplaySummarySource = "extractive" | "cache";
export interface ReplaySummaryRecord { key: string; tier: 1 | 2 | 3; range: string; topic: string; summary: string; keep?: FoldKeep[] }
export interface ReplaySummaryRequest { key: string; tier: 1 | 2 | 3; range: string; source: string; sourceDigest: string }

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export function replaySummaryKey(tier: 1 | 2 | 3, orderedIds: readonly string[], sourceDigests: readonly string[]): string {
  return sha256(`${tier}\0${orderedIds.join(",")}\0${sourceDigests.join(",")}`);
}
export function replaySummaryRequest(tier: 1 | 2 | 3, range: string, orderedIds: readonly string[], sourceText: string): ReplaySummaryRequest {
  const sourceDigest = sha256(sourceText);
  const source = sourceText.length <= 120_000 ? sourceText : `${sourceText.slice(0, 60_000)}\n[...middle omitted...]\n${sourceText.slice(-60_000)}`;
  return { key: replaySummaryKey(tier, orderedIds, [sourceDigest]), tier, range, source, sourceDigest };
}

export function parseReplaySummaryCache(text: string): Map<string, ReplaySummaryRecord> {
  const records = new Map<string, ReplaySummaryRecord>();
  const bytes = new Map<string, string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch (error) { throw new Error(`invalid summary cache line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    const record = value as Partial<ReplaySummaryRecord>;
    if (!record || typeof record.key !== "string" || !record.key || (record.tier !== 1 && record.tier !== 2 && record.tier !== 3) || typeof record.range !== "string" || typeof record.topic !== "string" || typeof record.summary !== "string") throw new Error(`invalid summary cache line ${index + 1}: missing required fields`);
    const canonical = JSON.stringify(record);
    const previous = bytes.get(record.key);
    if (previous !== undefined && previous !== canonical) throw new Error(`duplicate summary key ${record.key} has different records`);
    bytes.set(record.key, canonical);
    records.set(record.key, record as ReplaySummaryRecord);
  }
  return records;
}

export function loadReplaySummaryCache(path: string): Map<string, ReplaySummaryRecord> {
  return parseReplaySummaryCache(readFileSync(path, "utf8"));
}

export function cachedFoldSpec(request: ReplaySummaryRequest, cache: ReadonlyMap<string, ReplaySummaryRecord>): FoldSpec {
  const record = cache.get(request.key);
  if (!record) throw new Error(`missing replay summary ${request.key}`);
  if (record.tier !== request.tier || record.range !== request.range) throw new Error(`replay summary ${request.key} does not match requested tier/range`);
  return { range: record.range, tier: record.tier, topic: record.topic, summary: record.summary, ...(record.keep ? { keep: record.keep } : {}) };
}
