import type { Block, KernelMessage, RefRange } from "./kernel/types.ts";
import { formatRef, parseRangeSpec, parseRef } from "./kernel/types.ts";
import { messageFacts } from "./kernel/message-facts.ts";
import { SessionState } from "./kernel/state.ts";
import type { SessionEntryLike } from "./kernel/state.ts";
import { projectUnit, protectedZoneMap } from "./kernel/project-unit.ts";
import type { ProjectUnitOk, ProjectUnitResult } from "./kernel/project-unit.ts";
import { planRender, applyRender, expandRefRange, foldCoverageStats, renderBlockText } from "./kernel/render.ts";
import type { RenderOp } from "./kernel/render.ts";
import { decideNudge, formatTokens, recommendRanges } from "./kernel/nudge.ts";
import type { NudgeDecision, NudgeRange } from "./kernel/nudge.ts";
import { planElision, selectElideCandidates, elideLabel } from "./kernel/guard.ts";
import type { ElideCandidate } from "./kernel/guard.ts";
import type { JournalOp } from "./persist/journal.ts";
import { makeFoldOp, makeUnfoldOp, makeTierOp } from "./persist/journal.ts";
import type { OrigamiDb } from "./persist/db.ts";
import { blockBodyForIndex } from "./persist/db.ts";
import type { OrigamiConfig } from "./config.ts";
import { configFromPreset } from "./config.ts";

export interface HostPort {
  sessionId(): string;
  appendEvent(op: JournalOp): void;
  saveArtifact(content: string, toolType: string): Promise<string | undefined>;
  windowTokens(): number;
  projectedTokens(): number;
}

export interface FoldSpec {
  range: string;
  topic: string;
  summary: string;
}

export interface FoldParams {
  folds: FoldSpec[];
  tier?: 1 | 2 | 3;
}

export interface FoldCreatedBlock {
  id: string;
  tier: 1 | 2 | 3;
  refs: string[];
  tokensBefore: number;
  tokensAfter: number;
  topic: string;
}

export interface FoldOutcome {
  blocks: FoldCreatedBlock[];
  tokensReclaimed: number;
  foldCount: number;
}

export type FoldError = { ok: false; error: string; foldIndex: number };
export type FoldResult = { ok: true; outcome: FoldOutcome } | FoldError;

export interface StatusBlockRow {
  id: string;
  tier: number;
  coverage: string;
  tokens: number;
  tokensBefore: number;
  tokensAfter: number;
  reclaimed: number;
  topic: string;
  summary: string;
  children: string[];
  superseded: boolean;
  createdAt: number;
}

export interface StatusZoneRow {
  kind: string;
  start: string;
  end: string;
  tokens: number;
  messages: number;
}

export interface StatusReport {
  occupancyPct: number;
  windowTokens: number;
  usedTokens: number;
  projectedTokens: number;
  tokenSplit: {
    overhead: number;
    system: number;
    conversation: number;
    tools: number;
    summaries: number;
    live: number;
    foldedSavings: number;
  };
  growthSinceFold: number;
  growthStep: number;
  compressibleTokens: number;
  compressibleFloor: number;
  blocks: StatusBlockRow[];
  zones: StatusZoneRow[];
  folded: number;
  live: number;
  nudgeKind: string;
}

export interface CacheRound {
  ts: number;
  totalIn: number;
  cacheRead: number;
  cacheWrite: number;
  foldEventId: string | null;
}

export interface FoldSearchHit {
  blockId: string;
  sessionId: string;
  tier: number;
  topic: string;
  snippet: string;
  rank: number;
}

export function parseRangeList(spec: string): RefRange[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseRangeSpec(s));
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

interface MessageRow {
  ref: string;
  ephemeral: boolean;
  turn: number;
  tokens: number;
}

export class OrigamiEngine {
  readonly state: SessionState;
  config: OrigamiConfig;
  private host: HostPort;
  private db: OrigamiDb | null = null;
  private nudgedThisTurn = false;
  private activeTurn = 1;
  private pinnedHeadRef: string | null = null;
  private lastNudge: NudgeDecision = { kind: null, text: null };
  private activeNudge: string | null = null;
  private pendingFoldAttribution: string | null = null;
  get sessionId(): string {
    return this.host.sessionId();
  }

  get windowTokens(): number {
    return this.host.windowTokens();
  }

  constructor(opts: { host: HostPort; entries: readonly SessionEntryLike[]; modelId: string; config?: OrigamiConfig; countFn?: (input: string, encoding?: string) => number }) {
    this.host = opts.host;
    this.config = opts.config ?? configFromPreset("balanced");
    this.state = new SessionState({
      sessionId: opts.host.sessionId(),
      modelId: opts.modelId,
      entries: opts.entries,
      countFn: opts.countFn ? (input, encoding) => opts.countFn!(input, encoding) : null,
    });
  }

  attachDb(db: OrigamiDb | null): void {
    this.db = db;
  }

  refresh(entries: readonly SessionEntryLike[]): void {
    this.state.refresh(entries);
  }

  ingest(messages: readonly KernelMessage[]): void {
    const bound = this.state.bind(messages);
    const turns = bound.map((m) => m.turn);
    this.activeTurn = turns.length > 0 ? Math.max(...turns) : 1;
    const head = bound.find((m) => !m.ephemeral);
    this.pinnedHeadRef = head ? head.ref : null;
  }

  get bound() {
    return this.state.bound;
  }

  onTurnStart(): void {
    this.nudgedThisTurn = false;
    this.lastNudge = { kind: null, text: null };
  }

  messageRows(): MessageRow[] {
    return this.state.bound.map((m) => ({
      ref: m.ref,
      ephemeral: m.ephemeral,
      turn: m.turn,
      tokens: this.state.ledger.countMessage(m),
    }));
  }

  recommendedRanges(maxRanges = 8): NudgeRange[] {
    return recommendRanges({
      bound: this.messageRows(),
      foldedRefs: this.state.foldedRefs(),
      activeTurn: this.activeTurn,
      pinnedHeadRef: this.pinnedHeadRef,
      maxRanges,
    });
  }

  decideNudge(): NudgeDecision {
    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    const decision = decideNudge(
      {
        growthSinceFoldTokens: this.state.growthSinceFold(this.activeTurn),
        compressibleTokens: this.state.compressibleTokens(this.activeTurn),
        windowFillPct: window > 0 ? projected / window : 0,
        nudgedThisTurn: this.nudgedThisTurn,
      },
      this.recommendedRanges(),
      this.config,
    );
    if (decision.text) {
      this.activeNudge = decision.text;
      this.nudgedThisTurn = true;
    } else if (!this.nudgedThisTurn) {
      this.activeNudge = null;
    }
    this.lastNudge = decision;
    return decision;
  }

  /** The nudge text still owed to the model, carried across a turn's continuations until folded. */
  get nudgeText(): string | null {
    return this.activeNudge;
  }

  get nudge(): NudgeDecision {
    return this.lastNudge;
  }

  project(spec: string, tier: 1 | 2 | 3): ProjectUnitResult {
    if (tier === 1) {
      return projectUnit({
        bound: this.state.bound,
        ranges: parseRangeList(spec),
        foldedRefs: this.state.foldedRefs(),
        pinnedHeadRef: this.pinnedHeadRef,
        activeTurn: this.activeTurn,
      });
    }
    return this.projectBlocks(parseBlockRangeList(spec));
  }

  private projectBlocks(ids: readonly string[]): ProjectUnitResult {
    const ranges: RefRange[] = [];
    for (const id of ids) {
      const block = this.state.tree.get(id);
      if (!block) return { ok: false, error: `unknown block: ${id}` };
      if (block.superseded) return { ok: false, error: `block not live: ${id}` };
      ranges.push(...block.ranges);
    }
    if (ranges.length === 0) return { ok: false, error: "empty range" };
    const merged = mergeRanges(ranges);
    const refs: string[] = [];
    for (const r of merged) refs.push(...expandRefRange(r.start, r.end));
    const refSet = new Set(refs);
    return {
      ok: true,
      projected: { indices: [], refs, ranges: merged, tokens: this.state.tokensFor(refs) },
      widened: false,
      turnCount: new Set(this.state.bound.filter((m) => refSet.has(m.ref)).map((m) => m.turn)).size,
    };
  }

  executeFold(params: FoldParams): FoldResult {
    const tier = params.tier ?? 1;
    const planned: { spec: FoldSpec; projection: ProjectUnitOk; block: Block; children: string[] }[] = [];

    for (let i = 0; i < params.folds.length; i++) {
      const spec = params.folds[i]!;
      let children: string[] = [];
      let projection: ProjectUnitResult;
      try {
        if (tier === 1) {
          projection = this.project(spec.range, 1);
        } else {
          children = parseBlockRangeList(spec.range);
          projection = this.project(spec.range, tier);
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), foldIndex: i };
      }
      if (!projection.ok) return { ok: false, error: projection.error, foldIndex: i };

      const tokensBefore = projection.projected.tokens || this.state.tokensFor(projection.projected.refs);
      const id = `b${this.state.tree.all().length + 1 + planned.length}`;
      planned.push({
        spec,
        projection,
        children,
        block: {
          id,
          tier,
          ranges: projection.projected.ranges,
          topic: spec.topic,
          summary: spec.summary,
          children,
          superseded: false,
          tokensBefore,
          tokensAfter: this.state.ledger.countText(`${spec.topic}\n${spec.summary}`),
          createdAt: Date.now(),
        },
      });
    }

    const created: FoldCreatedBlock[] = [];
    let reclaimed = 0;
    for (const p of planned) {
      this.host.appendEvent(makeFoldOp(p.block));
      this.state.tree.apply({ op: "fold", block: p.block });
      if (this.db) {
        this.db.insertBlock({
          session_id: this.host.sessionId(),
          block_id: p.block.id,
          tier: p.block.tier,
          topic: p.block.topic,
          summary: p.block.summary,
          body: blockBodyForIndex(p.block),
          tokens_before: p.block.tokensBefore,
          tokens_after: p.block.tokensAfter,
          created_at: p.block.createdAt,
        });
      }
      created.push({
        id: p.block.id,
        tier: p.block.tier,
        refs: p.projection.projected.refs,
        tokensBefore: p.block.tokensBefore,
        tokensAfter: p.block.tokensAfter,
        topic: p.block.topic,
      });
      reclaimed += Math.max(0, p.block.tokensBefore - p.block.tokensAfter);
    }

    if (created.length > 0) {
      this.pendingFoldAttribution = created[created.length - 1]!.id;
      this.activeNudge = null;
    }
    return {
      ok: true,
      outcome: { blocks: created, tokensReclaimed: reclaimed, foldCount: created.length },
    };
  }
  archiveText(ranges: readonly RefRange[]): string {
    const bound = this.state.bound;
    const parts: string[] = [];
    for (const m of bound) {
      if (m.ephemeral) continue;
      const n = parseRef(m.ref);
      const covered = ranges.some((r) => n >= parseRef(r.start) && n <= parseRef(r.end));
      if (covered) parts.push(`[#${m.ref}] ${m.text}`);
    }
    return parts.join("\n\n");
  }

  executeUnfold(id: string): { ok: true; block: Block; refs: string[] } | { ok: false; error: string } {
    const block = this.state.tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    if (block.superseded) return { ok: false, error: `block already unfolded: ${id}` };
    const refs: string[] = [];
    for (const r of block.ranges) refs.push(...expandRefRange(r.start, r.end));
    this.host.appendEvent(makeUnfoldOp(id));
    this.state.tree.apply({ op: "unfold", id });
    return { ok: true, block, refs };
  }

  executeTier(id: string, tier: 1 | 2 | 3, topic: string, summary: string): { ok: true; block: Block } | { ok: false; error: string } {
    const block = this.state.tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    const op = makeTierOp(id, tier, topic, summary, block.tokensBefore, block.tokensAfter);
    this.host.appendEvent(op);
    this.state.tree.apply(op);
    return { ok: true, block: this.state.tree.get(id)! };
  }

  status(): StatusReport {
    const bound = this.state.bound;
    const foldedRefs = this.state.foldedRefs();
    const coverage = foldCoverageStats(bound, foldedRefs);

    let systemTokens = 0;
    let conversationTokens = 0;
    let toolTokens = 0;
    for (const m of bound) {
      const tokens = this.state.ledger.countMessage(m);
      if (m.ephemeral) {
        systemTokens += tokens;
      } else if (!foldedRefs.has(m.ref)) {
        if (m.role === "toolResult") toolTokens += tokens;
        else conversationTokens += tokens;
      }
    }

    const liveBlocks = this.state.tree.live();
    const summaryTokens = liveBlocks.reduce((s, b) => s + b.tokensAfter, 0);
    const foldedSavings = liveBlocks.reduce((s, b) => s + Math.max(0, b.tokensBefore - b.tokensAfter), 0);
    const liveTokens = conversationTokens + toolTokens;
    const renderedBoundTokens = systemTokens + liveTokens + summaryTokens;

    const windowTokens = Math.max(0, this.host.windowTokens());
    const projectedTokens = Math.max(0, this.host.projectedTokens());
    const usedTokens = projectedTokens > 0 ? projectedTokens : renderedBoundTokens;
    const overheadTokens = Math.max(0, usedTokens - renderedBoundTokens);
    const occupancyPct =
      windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;

    const rawZones = protectedZoneMap(bound, this.activeTurn, foldedRefs, this.pinnedHeadRef);
    const zones: StatusZoneRow[] = rawZones.map((z) => {
      const validStart = /^m\d{5,}$/.test(z.start);
      const validEnd = /^m\d{5,}$/.test(z.end);
      if (!validStart && !validEnd) {
        const ephCount = bound.filter((m) => m.ephemeral).length;
        return {
          kind: z.kind,
          start: "sys",
          end: "sys",
          tokens: systemTokens,
          messages: ephCount,
        };
      }
      const startRef = validStart ? z.start : z.end;
      const endRef = validEnd ? z.end : z.start;
      const startNum = parseRef(startRef);
      const endNum = parseRef(endRef);
      let msgTokens = 0;
      let messages = 0;
      for (const m of bound) {
        if (m.ephemeral || !/^m\d{5,}$/.test(m.ref)) continue;
        const n = parseRef(m.ref);
        if (n >= startNum && n <= endNum) {
          messages++;
          msgTokens += this.state.ledger.countMessage(m);
        }
      }
      let tokens = msgTokens;
      if (z.kind === "folded") {
        const summaryInZone = liveBlocks
          .filter((b) =>
            b.ranges.some((r) => parseRef(r.start) <= endNum && parseRef(r.end) >= startNum),
          )
          .reduce((s, b) => s + b.tokensAfter, 0);
        tokens = summaryInZone > 0 ? summaryInZone : msgTokens;
      }
      return {
        kind: z.kind,
        start: startRef,
        end: endRef,
        tokens,
        messages,
      };
    });

    return {
      occupancyPct,
      windowTokens,
      usedTokens,
      projectedTokens,
      tokenSplit: {
        overhead: overheadTokens,
        system: systemTokens,
        conversation: conversationTokens,
        tools: toolTokens,
        summaries: summaryTokens,
        live: liveTokens,
        foldedSavings,
      },
      growthSinceFold: this.state.growthSinceFold(this.activeTurn),
      growthStep: this.config.growthStep,
      compressibleTokens: this.state.compressibleTokens(this.activeTurn),
      compressibleFloor: this.config.compressibleFloor,
      blocks: this.state.tree.all().map((b) => ({
        id: b.id,
        tier: b.tier,
        coverage: formatCoverage(b.ranges),
        tokens: b.tokensBefore,
        tokensBefore: b.tokensBefore,
        tokensAfter: b.tokensAfter,
        reclaimed: Math.max(0, b.tokensBefore - b.tokensAfter),
        topic: b.topic,
        summary: b.summary,
        children: [...b.children],
        superseded: b.superseded,
        createdAt: b.createdAt,
      })),
      zones,
      folded: coverage.folded,
      live: coverage.live,
      nudgeKind: this.lastNudge.kind ?? "none",
    };
  }

  cacheRounds(): CacheRound[] {
    if (!this.db) return [];
    return this.db.roundsForSession(this.host.sessionId()).map((r) => ({
      ts: r.ts,
      totalIn: r.total_in,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      foldEventId: r.fold_event_id,
    }));
  }

  recordRound(round: CacheRound): void {
    if (!this.db) return;
    const foldEventId = round.foldEventId ?? this.pendingFoldAttribution;
    this.pendingFoldAttribution = null;
    this.db.insertRound({
      session_id: this.host.sessionId(),
      ts: round.ts,
      total_in: round.totalIn,
      cache_read: round.cacheRead,
      cache_write: round.cacheWrite,
      fold_event_id: foldEventId,
    });
  }

  search(query: string, limit = 10): FoldSearchHit[] {
    if (!this.db) return [];
    return this.db.searchBlocks(query, limit).map((r) => ({
      blockId: r.block_id,
      sessionId: r.session_id,
      tier: r.tier,
      topic: r.topic,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  async unfoldArtifact(id: string): Promise<{ ok: true; path: string; refs: string[]; toc: string } | { ok: false; error: string }> {
    const block = this.state.tree.get(id);
    if (!block) return { ok: false, error: `unknown block: ${id}` };
    const refs: string[] = [];
    for (const r of block.ranges) refs.push(...expandRefRange(r.start, r.end));
    const lines: string[] = [`# ${block.id} — ${block.topic}`, ""];
    for (const ref of refs) {
      const m = this.state.bound.find((x) => x.ref === ref);
      lines.push(`## ${ref}${m ? ` (${m.role})` : ""}`, m ? m.text : "<not in current branch view>", "");
    }
    const path = await this.host.saveArtifact(lines.join("\n"), `origami-unfold-${id}`);
    return {
      ok: true,
      path: path ?? "",
      refs,
      toc: refs.map((r) => `- ${r}`).join("\n"),
    };
  }

  render(messages: readonly unknown[], makeFoldMessage: (text: string, blockId: string, refTag?: string) => unknown): unknown[] {
    // Bind the array we are actually rewriting: the outbound request may carry
    // ephemeral developer reminders the journal never recorded, and
    // `bound[i].index === messages[i]` must hold for removals/elision to land.
    const facts: KernelMessage[] = [];
    for (const m of messages) {
      const f = messageFacts(m);
      if (!f) break;
      facts.push(f);
    }
    const aligned = facts.length === messages.length;
    const bound = aligned ? this.state.bindOutbound(facts) : this.state.bound;
    const headIndex = bound.findIndex((m) => !m.ephemeral);
    const pinnedHeadIndex = headIndex < 0 ? 0 : headIndex;

    // Elision runs BEFORE render removals: bound[i].index === i, so bound indices
    // map 1:1 onto the input array here and would drift after any removal.
    const window = this.host.windowTokens();
    const projected = this.host.projectedTokens();
    let source: readonly unknown[] = messages;
    if (window > 0 && projected >= window * this.config.elideFillPct && aligned) {
      const candidates: ElideCandidate[] = selectElideCandidates(
        bound.map((m) => ({
          ref: m.ref,
          index: m.index,
          role: m.role,
          tokens: this.state.ledger.countMessage(m),
          ephemeral: m.ephemeral,
        })),
      );
      const plan = planElision({
        projectedTokens: projected,
        windowTokens: window,
        candidates,
        thresholds: { elideFillPct: this.config.elideFillPct, targetFillPct: 0.7 },
      });
      if (plan.elided.length > 0) {
        const elideAt = new Map(plan.elided.map((e) => [e.index, e]));
        source = messages.map((m, i) => {
          const hit = elideAt.get(i);
          if (!hit) return m;
          const raw = m as { content?: unknown };
          const label = elideLabel(hit.ref, hit.tokens);
          const content = typeof raw.content === "string" ? label : [{ type: "text", text: label }];
          return { ...(m as object), content };
        });
      }
    }

    const ops: RenderOp[] = planRender({
      bound,
      blocks: this.state.tree.live(),
      pinnedHeadIndex,
    });
    return applyRender(source, ops, makeFoldMessage);
  }

  renderBlock(block: Block): string {
    return renderBlockText(block);
  }
}

function formatCoverage(ranges: readonly RefRange[]): string {
  return ranges.map((r) => `${r.start}..${r.end}`).join(", ");
}

function mergeRanges(ranges: readonly RefRange[]): RefRange[] {
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

export { formatTokens, formatRef };