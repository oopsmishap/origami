/**
 * Deterministic replay of real omp session journals through the Origami engine.
 *
 * Every assistant message on the session's active branch is one provider request whose
 * context is the branch prefix before it. "recorded" keeps the journal's own fold events;
 * "simulated" drops them and folds mechanically whenever the engine nudges. A simulated
 * prompt cache prices each request, and far-recall probes (errors and commits seen in tool
 * results) check whether old facts are still in context, reachable through a recall hint,
 * or lost.
 */
import type { OrigamiConfig } from "../src/config.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { entryMessage } from "../src/kernel/registry.ts";
import { extractManifest } from "../src/kernel/manifest.ts";
import { matchRecallHints } from "../src/kernel/recall-hints.ts";
import type { SessionEntryLike } from "../src/kernel/state.ts";
import { parseRef } from "../src/kernel/types.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { kernelMessagesFromEntries } from "../src/runtime.ts";
import { createReplayPolicyState, decideReplayPolicy, type ReplayPolicy } from "./replay-policy.ts";
import { cachedFoldSpec, replaySummaryRequest, type ReplaySummaryRecord, type ReplaySummaryRequest, type ReplaySummarySource } from "./replay-summary.ts";

export interface JournalEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
  content?: unknown;
}

export interface ReplayOptions {
  mode: "recorded" | "simulated";
  policy: ReplayPolicy;
  summarySource: ReplaySummarySource;
  summaryCache?: ReadonlyMap<string, ReplaySummaryRecord>;
  summaryMisses?: Map<string, ReplaySummaryRequest>;
  config: OrigamiConfig;
  windowTokens: number;
  hints: boolean;
  probeDistanceRefs: number;
  checkpointEvery: number;
}

export interface ReplayResult {
  policy: ReplayPolicy;
  price: { cacheRead: number; output: number; cacheWrite: number; source: string };
  requests: number;
  malformedLines: number;
  hostCompactions: number;
  folds: { 1: number; 2: number; 3: number };
  meanContextTokens: number;
  peakContextTokens: number;
  simulatedHitPct: number;
  billedUnits: number;
  baselineBilledUnits: number;
  hintsEmitted: number;
  probes: { total: number; inContext: number; viaHint: number; lost: number; minInContextPct: number };
  recordedUsage: { input: number; cacheRead: number; cacheWrite: number };
}

export const countTokens = (text: string): number => Math.ceil(text.length / 4);

export function parseJournal(text: string): { entries: JournalEntry[]; malformedLines: number } {
  const entries: JournalEntry[] = [];
  let malformedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") entries.push(v as JournalEntry);
      else malformedLines++;
    } catch {
      malformedLines++;
    }
  }
  return { entries, malformedLines };
}

/** The active branch: leaf (last entry with an id) back to the root, in order. File order without a tree. */
export function linearBranch(entries: readonly JournalEntry[]): JournalEntry[] {
  if (!entries.some((e) => "parentId" in e)) return [...entries];
  const byId = new Map<string, JournalEntry>();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  let leaf: JournalEntry | undefined;
  for (let i = entries.length - 1; i >= 0 && !leaf; i--) if (entries[i]!.id) leaf = entries[i];
  const out: JournalEntry[] = [];
  const seen = new Set<string>();
  for (let e = leaf; e && e.id && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id);
    out.push(e);
  }
  return out.reverse();
}

const roleOf = (m: unknown): string | undefined => (m as { role?: string } | undefined)?.role;
const textOf = (m: unknown): string => {
  const c = (m as { content?: unknown }).content;
  return typeof c === "string" ? c : JSON.stringify(c ?? "");
};
const isJournalEvent = (e: JournalEntry) => e.type === "custom" && e.customType === JOURNAL_ENTRY_TYPE;

interface Probe {
  fact: string;
  ref: string;
  refNo: number;
}

export function replaySession(entries: readonly JournalEntry[], o: ReplayOptions): ReplayResult {
  const branch = linearBranch(entries);
  const working: JournalEntry[] = [];
  let now = 0;
  let renderedTokens = 0;
  let appended = 0;
  const engine = new OrigamiEngine({
    host: {
      sessionId: () => "replay",
      appendEvent: (op) => {
        working.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, id: `replay-${++appended}`, data: op });
      },
      saveArtifact: async () => undefined,
      windowTokens: () => o.windowTokens,
      projectedTokens: () => renderedTokens,
    },
    entries: [],
    modelId: "replay",
    config: o.config,
    countFn: countTokens,
    now: () => now,
  });

  const policyState = createReplayPolicyState();
  const result: ReplayResult = {
    policy: o.policy,
    price: { cacheRead: o.config.cacheReadPrice ?? 0.1, output: o.config.outputPrice ?? 4, cacheWrite: o.config.cacheWritePrice ?? 1, source: "fallback" },
    requests: 0,
    malformedLines: 0,
    hostCompactions: 0,
    folds: { 1: 0, 2: 0, 3: 0 },
    meanContextTokens: 0,
    peakContextTokens: 0,
    simulatedHitPct: 0,
    billedUnits: 0,
    baselineBilledUnits: 0,
    hintsEmitted: 0,
    probes: { total: 0, inContext: 0, viaHint: 0, lost: 0, minInContextPct: 100 },
    recordedUsage: { input: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const r = o.config.cacheReadPrice ?? 0.1;
  const q = o.config.outputPrice ?? 4;

  const foldAll = (specs: { range: string; topic: string; summary: string }[], tier: 1 | 2 | 3): number => {
    let pending = specs.filter((s) => s.summary.length > 0);
    while (pending.length > 0) {
      const res = engine.executeFold({ folds: pending, tier });
      if (res.ok) {
        result.folds[tier] += res.outcome.foldCount;
        return res.outcome.blocks.reduce((s, b) => s + b.tokensAfter, 0);
      }
      pending = pending.filter((_, i) => i !== res.foldIndex);
    }
    return 0;
  };
  const summarySpec = (tier: 1 | 2 | 3, range: string, ids: readonly string[], source: string, topic: string, extractive: string) => {
    if (o.summarySource === "extractive") return { range, tier, topic, summary: extractive };
    const request = replaySummaryRequest(tier, range, ids, source);
    const record = o.summaryCache?.get(request.key);
    if (!record) {
      o.summaryMisses?.set(request.key, request);
      return null;
    }
    return cachedFoldSpec(request, o.summaryCache!);
  };
  const simulateFold = (): number => {
    const decision = decideReplayPolicy(o.policy, engine, policyState);
    if (decision.kind === "promotion" && decision.promotion) {
      const fromTier = decision.promotion.fromTier;
      const blocks = engine.state.tree.live().filter((b) => b.tier === fromTier);
      if (blocks.length < 2) return 0;
      const range = blocks.map((b) => b.id).join(",");
      const spec = summarySpec((fromTier + 1) as 2 | 3, range, blocks.map((b) => b.id), blocks.map((b) => engine.renderBlock(b)).join("\n\n"), `replay merge ${blocks[0]!.id}..${blocks.at(-1)!.id}`, `- ${blocks.map((b) => b.topic).join("\n- ")}`);
      return spec ? foldAll([spec], (fromTier + 1) as 2 | 3) : 0;
    }
    if (decision.kind === "efficiency" || decision.kind === "emergency") {
      const specs = engine.recommendedRanges().map((x) => {
        const range = `${x.start}..${x.end}`;
        const selected = engine.bound.filter((m) => !m.ephemeral && parseRef(m.ref) >= parseRef(x.start) && parseRef(m.ref) <= parseRef(x.end));
        return summarySpec(1, range, selected.map((m) => m.ref), selected.map((m) => m.text).join("\n"), `replay ${range}`, engine.archiveDigest([{ start: x.start, end: x.end }]));
      }).filter((spec): spec is NonNullable<typeof spec> => spec !== null);
      return foldAll(specs, 1);
    }
    return 0;
  };

  const cachedPrefix = (prev: readonly string[], cur: readonly string[], warm: boolean) => {
    if (!warm) return 0;
    let i = 0;
    let read = 0;
    while (i < prev.length && i < cur.length && prev[i] === cur[i]) read += countTokens(cur[i++]!);
    return read;
  };

  const probes: Probe[] = [];
  const probedRefs = new Set<string>();
  let lastRendered = "";
  const evaluate = (final: boolean) => {
    let maxRef = 0;
    for (const m of engine.bound) if (!m.ephemeral && /^m\d{5,}$/.test(m.ref)) maxRef = Math.max(maxRef, parseRef(m.ref));
    const live = engine.state.tree.live();
    let inContext = 0;
    let viaHint = 0;
    let lost = 0;
    for (const p of probes) {
      if (p.refNo > maxRef - o.probeDistanceRefs) continue;
      if (lastRendered.includes(p.fact)) {
        inContext++;
        continue;
      }
      const hits = o.hints ? matchRecallHints({ blocks: live, probe: p.fact, exclude: new Set(), max: 3 }) : [];
      const covers = hits.some((h) => {
        const b = live.find((x) => x.id === h.blockId);
        return b?.ranges.some((rg) => parseRef(rg.start) <= p.refNo && p.refNo <= parseRef(rg.end)) ?? false;
      });
      if (covers) viaHint++;
      else lost++;
    }
    const total = inContext + viaHint + lost;
    if (total > 0) result.probes.minInContextPct = Math.min(result.probes.minInContextPct, (inContext / total) * 100);
    if (final) Object.assign(result.probes, { total, inContext, viaHint, lost });
  };

  let prevStrings: string[] = [];
  let prevBaseline: string[] = [];
  let prevNow: number | null = null;
  let totalContext = 0;
  let totalCached = 0;
  let lastMessageRole: string | undefined;

  for (const entry of branch) {
    if (entry.type === "compaction") result.hostCompactions++;
    if (o.mode === "simulated" && isJournalEvent(entry)) continue;
    const message = entry.type === "message" ? entry.message : undefined;
    if (roleOf(message) !== "assistant") {
      working.push(entry);
      if (entryMessage(entry as SessionEntryLike) !== undefined) lastMessageRole = roleOf(entryMessage(entry as SessionEntryLike));
      continue;
    }

    // One provider request: the branch prefix before this assistant message.
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    now = Number.isFinite(ts) ? ts : (prevNow ?? 0) + 1000;
    engine.refresh(working as SessionEntryLike[]);
    engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
    if (lastMessageRole === "user") engine.onTurnStart();
    let foldSigma = 0;
    if (o.mode === "simulated") {
      foldSigma = simulateFold();
      if (foldSigma > 0) {
        engine.refresh(working as SessionEntryLike[]);
        engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
      }
    }
    for (const m of engine.bound) {
      if (m.role !== "toolResult" || m.ephemeral || probedRefs.has(m.ref) || !/^m\d{5,}$/.test(m.ref)) continue;
      probedRefs.add(m.ref);
      const man = extractManifest([m]);
      for (const fact of [...man.errors.slice(0, 2).map((e) => e.slice(0, 60)), ...man.commits]) {
        probes.push({ fact, ref: m.ref, refNo: parseRef(m.ref) });
      }
    }

    const raw = working.map((e) => entryMessage(e as SessionEntryLike)).filter((m): m is NonNullable<typeof m> => m !== undefined);
    let rendered = engine.render(raw, (text) => ({ role: "custom", content: text }));
    let strings = rendered.map((m) => `${roleOf(m)}:${textOf(m)}`);
    // Simulated mode already decided (and acted on) the nudge before rendering.
    const nudge = o.mode === "simulated" ? engine.nudgeText : (engine.decideNudge().text ?? engine.nudgeText);
    if (nudge) strings.push(`developer:${nudge}`);
    if (o.hints) {
      const hint = engine.recallHintText();
      if (hint) {
        strings.push(`developer:${hint}`);
        result.hintsEmitted++;
      }
    }
    let total = strings.reduce((s, x) => s + countTokens(x), 0);
    if (o.policy === "current" && total >= o.windowTokens) {
      rendered = engine.render(raw, (text) => ({ role: "custom", content: text }), total);
      strings = rendered.map((m) => `${roleOf(m)}:${textOf(m)}`);
      if (nudge) strings.push(`developer:${nudge}`);
      total = strings.reduce((s, x) => s + countTokens(x), 0);
      if (total >= o.windowTokens) {
        // The current hook aborts this provider request; no oversized outbound context is sent.
        strings = [];
        total = 0;
      }
    }
    const warm = prevNow !== null && (o.config.cacheTtlMs === 0 || now - prevNow < o.config.cacheTtlMs);
    const cached = cachedPrefix(prevStrings, strings, warm);
    result.billedUnits += total - cached + cached * r + foldSigma * q;
    const baseline = raw.map((m) => `${roleOf(m)}:${textOf(m)}`);
    const baseTotal = baseline.reduce((s, x) => s + countTokens(x), 0);
    const baseCached = cachedPrefix(prevBaseline, baseline, warm);
    result.baselineBilledUnits += baseTotal - baseCached + baseCached * r;
    engine.recordRound({ ts: now, totalIn: total, cacheRead: cached, cacheWrite: 0, foldEventId: null, hostRewrite: false });

    renderedTokens = total;
    prevStrings = strings;
    prevBaseline = baseline;
    prevNow = now;
    totalContext += total;
    totalCached += cached;
    result.peakContextTokens = Math.max(result.peakContextTokens, total);
    result.requests++;
    lastRendered = strings.join("\n");
    const usage = (message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (usage) {
      result.recordedUsage.input += usage.input ?? 0;
      result.recordedUsage.cacheRead += usage.cacheRead ?? 0;
      result.recordedUsage.cacheWrite += usage.cacheWrite ?? 0;
    }
    if (o.checkpointEvery > 0 && result.requests % o.checkpointEvery === 0) evaluate(false);

    working.push(entry);
    lastMessageRole = "assistant";
  }
  evaluate(true);
  result.meanContextTokens = result.requests > 0 ? Math.round(totalContext / result.requests) : 0;
  result.simulatedHitPct = totalContext > 0 ? Math.round((totalCached / totalContext) * 1000) / 10 : 0;
  return result;
}
