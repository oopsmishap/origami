import type { Block, LedgerKind, LedgerRecord } from "../kernel/types.ts";
import { parseManifest } from "../kernel/manifest.ts";
import { isRecord, numOr, strOr } from "../kernel/guards.ts";

export interface JournalFoldOp {
  v: 1;
  op: "fold";
  block: Block;
  at: number;
}

export interface JournalUnfoldOp {
  v: 1;
  op: "unfold";
  id: string;
  at: number;
}

export interface JournalTierOp {
  v: 1;
  op: "tier";
  id: string;
  tier: 1 | 2 | 3;
  topic: string;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  at: number;
}

export type JournalOp = JournalFoldOp | JournalUnfoldOp | JournalTierOp;

export const JOURNAL_ENTRY_TYPE = "origami:event";

const LEDGER_KINDS: ReadonlySet<string> = new Set<LedgerKind>(["intent", "constraint", "decision", "objective"]);

function parseLedger(value: unknown): LedgerRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: LedgerRecord[] = [];
  for (const r of value) {
    if (!isRecord(r) || typeof r.id !== "string" || typeof r.kind !== "string" || !LEDGER_KINDS.has(r.kind)) continue;
    if (typeof r.text !== "string" || r.text.trim() === "") continue;
    const ref = r.ref === null || r.ref === undefined ? null : typeof r.ref === "string" && /^m\d{5,}$/.test(r.ref) ? r.ref : undefined;
    if (ref === undefined) continue;
    out.push({ id: r.id, kind: r.kind as LedgerKind, text: r.text, ref });
  }
  return out;
}

function parseBlock(value: unknown): Block | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !Array.isArray(value.ranges)) return null;
  const block: Block = {
    id: value.id,
    tier: value.tier === 2 || value.tier === 3 ? value.tier : 1,
    ranges: value.ranges as Block["ranges"],
    topic: strOr(value.topic, ""),
    summary: strOr(value.summary, ""),
    children: Array.isArray(value.children) ? (value.children as string[]) : [],
    // Lifecycle is derived by replaying ops; a logged block always starts active.
    status: "active",
    consumedBy: null,
    tokensBefore: numOr(value.tokensBefore, 0),
    tokensAfter: numOr(value.tokensAfter, 0),
    createdAt: numOr(value.createdAt, Date.now()),
    anchorRef: typeof value.anchorRef === "string" && /^m\d{5,}$/.test(value.anchorRef) ? value.anchorRef : null,
  };
  const manifest = parseManifest(value.manifest);
  if (manifest) block.manifest = manifest;
  if (Array.isArray(value.missing)) {
    const missing = value.missing.filter((s): s is string => typeof s === "string");
    if (missing.length > 0) block.missing = missing;
  }
  const ledger = parseLedger(value.ledger);
  if (ledger) block.ledger = ledger;
  return block;
}

export function parseJournalOp(data: unknown): JournalOp | null {
  if (!isRecord(data) || data.v !== 1) return null;
  const at = numOr(data.at, Date.now());

  if (data.op === "fold") {
    const block = parseBlock(data.block);
    return block ? { v: 1, op: "fold", block, at } : null;
  }

  if (data.op === "unfold") {
    return typeof data.id === "string" ? { v: 1, op: "unfold", id: data.id, at } : null;
  }

  if (data.op === "tier") {
    if (typeof data.id !== "string") return null;
    return {
      v: 1,
      op: "tier",
      id: data.id,
      tier: data.tier === 2 || data.tier === 3 ? data.tier : 1,
      topic: strOr(data.topic, ""),
      summary: strOr(data.summary, ""),
      tokensBefore: numOr(data.tokensBefore, 0),
      tokensAfter: numOr(data.tokensAfter, 0),
      at,
    };
  }
  return null;
}

export function makeFoldOp(block: Block, at = Date.now()): JournalFoldOp {
  return { v: 1, op: "fold", block, at };
}

export function makeUnfoldOp(id: string, at = Date.now()): JournalUnfoldOp {
  return { v: 1, op: "unfold", id, at };
}

export function makeTierOp(
  id: string,
  tier: 1 | 2 | 3,
  topic: string,
  summary: string,
  tokensBefore: number,
  tokensAfter: number,
  at = Date.now(),
): JournalTierOp {
  return { v: 1, op: "tier", id, tier, topic, summary, tokensBefore, tokensAfter, at };
}

export function extractOps(entries: readonly { type: string; customType?: string; data?: unknown }[]): JournalOp[] {
  const ops: JournalOp[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== JOURNAL_ENTRY_TYPE) continue;
    const op = parseJournalOp(e.data);
    if (op) ops.push(op);
  }
  return ops;
}