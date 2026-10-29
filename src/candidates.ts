/**
 * Speculative fold candidates (opt-in `speculativeFolds`).
 *
 * After a turn ends, a host side turn (`ctx.runEphemeralTurn`) drafts one tier-1 fold for
 * the best timely range. The side turn shares the session's model, system prompt and
 * history (so the prompt cache stays warm) and is never appended to history. The draft is
 * validated with `planFoldBatch` and surfaced to the main model, which accepts, edits or
 * rejects it via `fold_candidate`. Nothing is folded without the main model's approval.
 */
import type { FoldParams, FoldSpec, OrigamiEngine } from "./engine.ts";
import { contentHash } from "./kernel/hash.ts";
import { formatTokens, type NudgeRange } from "./kernel/nudge.ts";
import { salvageFoldParams } from "./tools/salvage.ts";

export const CANDIDATE_MARKER = "[origami:candidate-request]";
/** A surfaced candidate expires after this many turns without an answer. */
export const CANDIDATE_MAX_AGE_TURNS = 3;

export interface FoldCandidate {
  id: string;
  spec: FoldSpec;
  refs: string[];
  sourceDigest: string;
  createdTurn: number;
  tokensBefore: number;
  tokensAfter: number;
}

export class CandidateStore {
  pending: FoldCandidate | null = null;
  inFlight: AbortController | null = null;
  /** Growth at which the last candidate was rejected or expired; the next waits for half a growth step more. */
  rejectedAtGrowth: number | null = null;
  nextId = 1;
  /** Set when the host cannot run tool-less side turns; speculative folds stay off for the session. */
  disabled = false;
}

export function candidatePrompt(ranges: readonly NudgeRange[]): string {
  return (
    `${CANDIDATE_MARKER} Do not call tools. Write ONE fold for ranges ${ranges.map((r) => `${r.start}..${r.end}`).join(",")} ` +
    `following the folding doctrine (summary, keep). Reply with only JSON: {"range":"…","topic":"…","summary":"…","keep":[…]}`
  );
}

export function parseCandidateReply(reply: string): FoldParams | { error: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "candidate reply contains no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch (error) {
    return { error: `candidate reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const salvaged = salvageFoldParams(raw);
  if (!salvaged.ok) return { error: salvaged.error };
  if (salvaged.params.folds.length !== 1) return { error: `candidate reply must contain exactly one fold, got ${salvaged.params.folds.length}` };
  return { folds: salvaged.params.folds, tier: 1 };
}

export function sourceDigest(texts: readonly string[]): string {
  return contentHash(texts.join("\u0000"));
}

/** Digest of the current bound text of `refs` (missing refs digest as empty strings). */
export function digestRefs(engine: OrigamiEngine, refs: readonly string[]): string {
  const byRef = new Map(engine.state.bound.filter((m) => !m.ephemeral).map((m) => [m.ref, m.text]));
  return sourceDigest(refs.map((r) => byRef.get(r) ?? ""));
}

/** True when the candidate no longer matches the session: a ref was folded or its text changed. */
export function candidateStale(engine: OrigamiEngine, c: FoldCandidate): boolean {
  const folded = engine.state.foldedRefs();
  return c.refs.some((r) => folded.has(r)) || digestRefs(engine, c.refs) !== c.sourceDigest;
}

/** Validate a side-turn reply against the current state and build the pending candidate. */
export function buildCandidate(engine: OrigamiEngine, store: CandidateStore, reply: string): FoldCandidate | { error: string } {
  const params = parseCandidateReply(reply);
  if ("error" in params) return params;
  const plan = engine.planFoldBatch(params);
  if (!plan.ok) return { error: plan.error };
  const planned = plan.planned[0]!;
  return {
    id: `c${store.nextId++}`,
    spec: params.folds[0]!,
    refs: planned.refs,
    sourceDigest: digestRefs(engine, planned.refs),
    createdTurn: engine.turn,
    tokensBefore: planned.block.tokensBefore,
    tokensAfter: planned.block.tokensAfter,
  };
}

export function formatCandidate(c: FoldCandidate): string {
  return (
    `[origami] A fold was prepared in the background: ${c.id} covers ${c.spec.range} (~${formatTokens(c.tokensBefore)} → ~${formatTokens(c.tokensAfter)} tokens).\n` +
    `Topic: ${c.spec.topic}\n` +
    `${c.spec.summary}\n` +
    `Call fold_candidate {"id":"${c.id}","action":"accept"} if that work is finished, "edit" with your own topic/summary, or "reject".`
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

/** The outbound request is a candidate side turn: its last message is the marked user prompt. */
export function isCandidateRequest(messages: readonly unknown[]): boolean {
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown } | undefined;
  return last?.role === "user" && contentText(last.content).includes(CANDIDATE_MARKER);
}

/** The pending candidate if still valid; expired ones back off generation, stale ones are dropped. */
export function liveCandidate(engine: OrigamiEngine, store: CandidateStore): FoldCandidate | null {
  const c = store.pending;
  if (!c) return null;
  if (engine.turn - c.createdTurn > CANDIDATE_MAX_AGE_TURNS) {
    store.pending = null;
    store.rejectedAtGrowth = engine.growthSinceFold();
    return null;
  }
  if (candidateStale(engine, c)) {
    store.pending = null;
    return null;
  }
  return c;
}

/** Ranges worth drafting a candidate for now, or null when generation should not start. */
export function candidateRanges(engine: OrigamiEngine, store: CandidateStore): NudgeRange[] | null {
  if (store.disabled || store.inFlight || store.pending) return null;
  const ranges = engine.recommendedRanges(4);
  if (ranges.length === 0 || !engine.foldTiming(ranges).allowed) return null;
  if (store.rejectedAtGrowth !== null && engine.growthSinceFold() < store.rejectedAtGrowth + engine.config.growthStep / 2) return null;
  return ranges;
}

export type RunEphemeralTurn = (options: {
  promptText: string;
  minimizeEffort?: boolean;
  replyMaxBytes?: number;
  signal?: AbortSignal;
}) => Promise<{ replyText: string }>;

/**
 * Draft one candidate in a side turn. Tools are omitted (not `tools: false`) so the request
 * keeps the main prompt cache. Failures are reported, never thrown.
 */
export async function generateCandidate(
  engine: OrigamiEngine,
  store: CandidateStore,
  run: RunEphemeralTurn,
  ranges: readonly NudgeRange[],
  onFailure: (error: string) => void,
  beforeBuild: () => void = () => {},
): Promise<void> {
  const controller = new AbortController();
  store.inFlight = controller;
  try {
    const { replyText } = await run({ promptText: candidatePrompt(ranges), minimizeEffort: true, replyMaxBytes: 65536, signal: controller.signal });
    if (controller.signal.aborted) return;
    beforeBuild();
    const built = buildCandidate(engine, store, replyText);
    if ("error" in built) onFailure(built.error);
    else store.pending = built;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Transports with mandatory native tools reject tool-less side turns before inference.
    if (/tool/i.test(message)) store.disabled = true;
    onFailure(message);
  } finally {
    store.inFlight = null;
  }
}
