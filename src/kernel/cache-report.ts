/**
 * Prompt-cache reconciliation and economics engine.
 *
 * Ground-truth decomposition: every request's cache miss is split into four
 * additive buckets so the totals reconcile exactly:
 *
 *   missed_i = input_i − cached_i
 *            = newContent_i   (legitimate fresh growth from user prompts & tool outputs)
 *            + compRepay_i    (re-payment forced by fold prefix divergence)
 *            + hostRepay_i    (re-payment after omp host compaction/shake rewrote the prefix)
 *            + ttlRepay_i     (unattributed: TTL expiry or provider eviction)
 *
 * Exact closure:
 *   Σ input = Σ cached + Σ newContent + Σ compRepay + Σ hostRepay + Σ ttlRepay
 */

export interface CacheSample {
  at: number;
  input: number;
  cached: number;
  write?: number;
  foldEventId?: string | null;
  /** The omp host rewrote the prompt prefix before this request. */
  hostRewrite?: boolean;
}

export interface FoldEvent {
  id: string;
  at: number;
  tier: 1 | 2 | 3;
  /** Tokens removed from the live context: raw source for tier 1, child summaries for tier 2/3. */
  replacedTokens: number;
  summaryTokens: number;
  topic?: string;
}

/** Price profile in units where 1 unit = 1 uncached input token. */
export interface PriceProfile {
  cacheRead: number;
  output: number;
}

export const DEFAULT_PRICE: PriceProfile = { cacheRead: 0.1, output: 4 };

export interface FoldBlockInfo {
  id: string;
  createdAt: number;
  tier: 1 | 2 | 3;
  tokensBefore: number;
  tokensAfter: number;
  children: readonly string[];
  topic?: string;
}

/** Derive fold events from blocks; tier-2/3 replace their children's summaries, not raw source. */
export function foldEventsFromBlocks(blocks: readonly FoldBlockInfo[]): FoldEvent[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return blocks.map((b) => ({
    id: b.id,
    at: b.createdAt,
    tier: b.tier,
    replacedTokens:
      b.tier === 1 ? b.tokensBefore : b.children.reduce((sum, c) => sum + (byId.get(c)?.tokensAfter ?? 0), 0),
    summaryTokens: b.tokensAfter,
    topic: b.topic,
  }));
}

/**
 * Fold break-even in price units. A fold re-pays the uncached suffix T once
 * (instead of reading it from cache), pays σ output tokens to write the summary,
 * and avoids reading S from cache once; afterwards every turn reads σ instead of S.
 */
export function foldBreakeven(
  S: number,
  sigma: number,
  T: number,
  price: PriceProfile,
): { oneTimeCostUnits: number; perTurnSavingUnits: number; breakevenTurns: number | null } {
  const r = price.cacheRead;
  const q = price.output;
  const oneTimeCostUnits = (1 - r) * T + q * sigma - r * S;
  const perTurnSavingUnits = r * (S - sigma);
  const breakevenTurns = perTurnSavingUnits > 0 ? Math.max(0, oneTimeCostUnits) / perTurnSavingUnits : null;
  return { oneTimeCostUnits, perTurnSavingUnits, breakevenTurns };
}

export interface SampleDecomposition {
  missed: number;
  newContent: number;
  compRepay: number;
  /** Re-payment after the omp host rewrote the prefix (compaction/shake outside Origami). */
  hostRepay: number;
  ttlRepay: number;
  foldId: string | null;
}

export interface FoldEconomics {
  id: string;
  at: number;
  tier: 1 | 2 | 3;
  S: number;
  sigma: number;
  T: number;
  requestsAfter: number;
  oneTimeCostUnits: number;
  perTurnSavingUnits: number;
  breakevenTurns: number | null;
  paidBack: boolean;
  cadenceOk: boolean | null;
  netUnits: number;
  topic?: string;
}

export interface EconomicsSummary {
  totalRequests: number;
  totalInput: number;
  totalCached: number;
  totalWrite: number;
  overallHitPct: number;
  newContent: number;
  compRepay: number;
  hostRepay: number;
  ttlRepay: number;
  grossSavedUnits: number;
  costUnits: number;
  netUnits: number;
  foldsCount: number;
  paidBackCount: number;
  cadenceOkCount: number;
}

export interface CacheReport {
  generatedAt: number;
  summary: EconomicsSummary;
  folds: FoldEconomics[];
  decompositions: SampleDecomposition[];
}

/** Threshold hit percentage considered a warm cache read that proves re-caching. */
export const WARM_CACHE_HIT_PCT = 85;
/** Maximum cold rounds claimed by a single fold event. */
export const MAX_COLD_CLAIM_ROUNDS = 4;

export function decomposeSample(
  prev: CacheSample | null,
  cur: CacheSample,
  activeFold: FoldEvent | null,
): SampleDecomposition {
  const missed = Math.max(0, cur.input - cur.cached);
  const growth = prev ? Math.max(0, cur.input - prev.input) : 0;
  const newContent = Math.min(missed, growth);
  const remainder = missed - newContent;

  let compRepay = 0;
  let hostRepay = 0;
  let foldId: string | null = null;

  if (remainder > 0 && activeFold !== null) {
    compRepay = remainder;
    foldId = activeFold.id;
  } else if (remainder > 0 && cur.hostRewrite) {
    hostRepay = remainder;
  }

  return {
    missed,
    newContent,
    compRepay,
    hostRepay,
    ttlRepay: remainder - compRepay - hostRepay,
    foldId,
  };
}

export function buildCacheReport(
  samplesIn: readonly CacheSample[],
  foldsIn: readonly FoldEvent[],
  price: PriceProfile = DEFAULT_PRICE,
): CacheReport {
  const samples = [...samplesIn].sort((a, b) => a.at - b.at);
  const folds = [...foldsIn].sort((a, b) => a.at - b.at);

  const decompositions: SampleDecomposition[] = [];
  const foldRepayMap = new Map<string, number>();
  for (const f of folds) foldRepayMap.set(f.id, 0);

  // Per-fold claim state
  const foldClaims = new Map<string, number>();
  const foldRetired = new Set<string>();

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const prev = i > 0 ? samples[i - 1]! : null;
    const hitPct = s.input > 0 ? (s.cached / s.input) * 100 : 0;
    const warm = hitPct >= WARM_CACHE_HIT_PCT;

    // Direct fold tag on sample takes precedence
    let activeFold: FoldEvent | null = null;
    if (s.foldEventId) {
      const match = folds.find((f) => f.id === s.foldEventId);
      if (match) activeFold = match;
    }

    if (!activeFold) {
      // Find candidate active fold whose window is still claiming cold rounds
      for (const f of folds) {
        if (f.at > s.at) break;
        if (foldRetired.has(f.id)) continue;
        const claims = foldClaims.get(f.id) ?? 0;
        if (claims < MAX_COLD_CLAIM_ROUNDS && !warm) {
          activeFold = f;
          break;
        }
      }
    }

    const d = decomposeSample(prev, s, activeFold);
    decompositions.push(d);

    if (d.foldId && d.compRepay > 0) {
      foldRepayMap.set(d.foldId, (foldRepayMap.get(d.foldId) ?? 0) + d.compRepay);
      const curClaims = foldClaims.get(d.foldId) ?? 0;
      foldClaims.set(d.foldId, curClaims + 1);
      if (curClaims + 1 >= MAX_COLD_CLAIM_ROUNDS) {
        foldRetired.add(d.foldId);
      }
    }

    // A warm line proves re-cache, retiring all preceding open windows
    if (warm) {
      for (const f of folds) {
        if (f.at <= s.at) foldRetired.add(f.id);
      }
    }
  }

  // Calculate per-fold economics
  const foldEconomics: FoldEconomics[] = [];
  for (let j = 0; j < folds.length; j++) {
    const f = folds[j]!;
    const nextF = j + 1 < folds.length ? folds[j + 1]! : null;

    let sampleIdx = -1;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i]!.foldEventId === f.id || samples[i]!.at >= f.at) {
        sampleIdx = i;
        break;
      }
    }

    const requestsAfter = sampleIdx !== -1 ? Math.max(0, samples.length - 1 - sampleIdx) : 0;

    let turnsToNextFold: number | null = null;
    if (nextF) {
      // Search for the next fold that occurred in a subsequent sample round
      // (folds executed in the same turn/batch share the same prefix invalidation)
      for (let k = j + 1; k < folds.length; k++) {
        const candidateNext = folds[k]!;
        let candIdx = -1;
        for (let i = 0; i < samples.length; i++) {
          if (samples[i]!.foldEventId === candidateNext.id || samples[i]!.at >= candidateNext.at) {
            candIdx = i;
            break;
          }
        }
        if (candIdx > sampleIdx) {
          turnsToNextFold = candIdx - sampleIdx;
          break;
        }
      }
    }

    const S = f.replacedTokens;
    const sigma = f.summaryTokens;
    const T = foldRepayMap.get(f.id) ?? 0;
    const { oneTimeCostUnits, perTurnSavingUnits, breakevenTurns } = foldBreakeven(S, sigma, T, price);
    const paidBack = breakevenTurns !== null && requestsAfter >= breakevenTurns;
    const cadenceOk = turnsToNextFold !== null && breakevenTurns !== null ? turnsToNextFold >= breakevenTurns : null;
    const netUnits = perTurnSavingUnits * requestsAfter - Math.max(0, oneTimeCostUnits);

    foldEconomics.push({
      id: f.id,
      at: f.at,
      tier: f.tier,
      S,
      sigma,
      T,
      requestsAfter,
      oneTimeCostUnits,
      perTurnSavingUnits,
      breakevenTurns,
      paidBack,
      cadenceOk,
      netUnits,
      topic: f.topic,
    });
  }

  // Aggregate totals
  let totalInput = 0;
  let totalCached = 0;
  let totalWrite = 0;
  let totalNewContent = 0;
  let totalCompRepay = 0;
  let totalHostRepay = 0;
  let totalTtlRepay = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const d = decompositions[i]!;
    totalInput += s.input;
    totalCached += s.cached;
    totalWrite += s.write ?? 0;
    totalNewContent += d.newContent;
    totalCompRepay += d.compRepay;
    totalHostRepay += d.hostRepay;
    totalTtlRepay += d.ttlRepay;
  }

  const grossSavedUnits = foldEconomics.reduce((sum, f) => sum + f.perTurnSavingUnits * f.requestsAfter, 0);
  const costUnits = foldEconomics.reduce((sum, f) => sum + Math.max(0, f.oneTimeCostUnits), 0);
  const netUnits = grossSavedUnits - costUnits;

  let paidBackCount = 0;
  let cadenceOkCount = 0;
  for (const f of foldEconomics) {
    if (f.paidBack) paidBackCount++;
    if (f.cadenceOk === true) cadenceOkCount++;
  }

  const overallHitPct = totalInput > 0 ? Math.round((totalCached / totalInput) * 1000) / 10 : 0;

  return {
    generatedAt: Date.now(),
    summary: {
      totalRequests: samples.length,
      totalInput,
      totalCached,
      totalWrite,
      overallHitPct,
      newContent: totalNewContent,
      compRepay: totalCompRepay,
      hostRepay: totalHostRepay,
      ttlRepay: totalTtlRepay,
      grossSavedUnits,
      costUnits,
      netUnits,
      foldsCount: foldEconomics.length,
      paidBackCount,
      cadenceOkCount,
    },
    folds: foldEconomics,
    decompositions,
  };
}
