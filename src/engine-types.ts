import type { OrigamiConfig } from "./config.ts";
import type { Block, BlockStatus } from "./kernel/types.ts";
import type { FoldTiming } from "./kernel/fold-timing.ts";
import type { InvariantViolation } from "./kernel/invariants.ts";
import type { SessionState } from "./kernel/state.ts";
import type { OrigamiDb } from "./persist/db.ts";
import type { JournalOp } from "./persist/journal.ts";

export interface HostPort {
  sessionId(): string;
  appendEvent(op: JournalOp): void;
  saveArtifact(content: string, toolType: string): Promise<string | undefined>;
  windowTokens(): number;
  projectedTokens(): number;
  modelCost?(): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
}

export interface EngineContext {
  state: SessionState;
  config: OrigamiConfig;
  host: HostPort;
  db: OrigamiDb | null;
  now(): number;
  activeTurn: number;
  protectedFromTurn: number;
  bookkeepingRefs: ReadonlySet<string>;
  pinnedHeadRef: string | null;
}

export interface FoldSpec {
  range: string;
  topic: string;
  summary: string;
  tier?: 1 | 2 | 3;
  /** Records pinned verbatim on the block and carried through every merge. */
  keep?: FoldKeep[];
  /** Ledger ids (objectives/intents) to drop when merging blocks. */
  retire?: string[];
}
export interface FoldKeep { kind: "constraint" | "decision" | "objective"; text: string; ref?: string }
export interface FoldParams { folds: FoldSpec[]; tier?: 1 | 2 | 3 }
export interface FoldCreatedBlock { id: string; tier: 1 | 2 | 3; refs: string[]; tokensBefore: number; tokensAfter: number; topic: string; missing: string[] }
export interface FoldOutcome { blocks: FoldCreatedBlock[]; tokensReclaimed: number; foldCount: number }
export type FoldError = { ok: false; error: string; foldIndex: number };
export type FoldResult = { ok: true; outcome: FoldOutcome } | FoldError;
export interface PlannedFold { block: Block; refs: string[] }

export interface StatusBlockRow { id: string; tier: number; coverage: string; tokens: number; tokensBefore: number; tokensAfter: number; reclaimed: number; topic: string; summary: string; children: string[]; status: BlockStatus; consumedBy: string | null; survivedFolds: number; generation: "young" | "old"; createdAt: number }
export interface StatusZoneRow { kind: string; start: string; end: string; tokens: number; messages: number; cachedTokens: number; cacheCoverage: "none" | "partial" | "full" }
export interface StatusVaultReport { archivedTokens: number; summaryTokens: number; reclaimedTokens: number; compressionRatio: number; savingsPct: number; archivedMessages: number; activeBlocks: number; totalBlocks: number; breakEvenTurns: number | null; paidBack: boolean; cumulativeSavedTokens: number; paybackStatus: string }
export interface StatusReport {
  occupancyPct: number; windowTokens: number; usedTokens: number; projectedTokens: number;
  tokenSplit: { overhead: number; system: number; conversation: number; tools: number; summaries: number; live: number; foldedSavings: number };
  growthSinceFold: number; growthStep: number; compressibleTokens: number; compressibleFloor: number;
  blocks: StatusBlockRow[]; zones: StatusZoneRow[]; folded: number; live: number; nudgeKind: string; protectedFromTurn: number;
  invariantViolations: InvariantViolation[]; vault: StatusVaultReport;
  cacheCollapse?: { collapsed: boolean; reason: string | null }; uncoveredRuns?: import("./kernel/project-unit.ts").UncoveredRun[];
  foldGate: FoldTiming & { paybackHorizonTurns: number };
}
export interface CacheRound { ts: number; totalIn: number; cacheRead: number; cacheWrite: number; foldEventId: string | null; hostRewrite: boolean; price?: import("./kernel/cache-report.ts").PriceProfile; priceSource?: import("./kernel/cache-report.ts").PriceSource }
export interface FoldSearchHit { blockId: string; sessionId: string; tier: number; topic: string; status: string; snippet: string; rank: number; planScore?: number }
export interface FoldMessageHit { sessionId: string; ref: string; role: string; turn: number; snippet: string; rank: number; ownSession: boolean }
export interface MessageRow { ref: string; role?: string; ephemeral: boolean; turn: number; tokens: number; tool: boolean; toolCalls?: { id: string; name: string }[]; toolCallId?: string }
