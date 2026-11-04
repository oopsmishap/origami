/**
 * Modeled billing for local benchmark runs.
 *
 * Ollama reports token usage but does not report provider cache reads, cache
 * writes, or monetary cost. These rates model the same workload as GPT-5.6 Sol
 * Standard so benchmark cost/cache comparisons remain concrete without
 * pretending that Ollama issued a bill.
 */

export interface BenchmarkPricingProfile {
  id: string;
  source: "modeled";
  shortContextLimit: number;
  short: BenchmarkPriceRates;
  long: BenchmarkPriceRates;
}

export interface BenchmarkPriceRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface LlmCostBreakdown {
  pricingModel: string;
  pricingSource: "modeled";
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  totalCost: number;
}

export const GPT_5_6_SOL_PRICING: BenchmarkPricingProfile = {
  id: "gpt-5.6-sol",
  source: "modeled",
  shortContextLimit: 272_000,
  short: {
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.4,
    cacheWritePerMillion: 5
  },
  long: {
    inputPerMillion: 8,
    outputPerMillion: 30,
    cacheReadPerMillion: 0.8,
    cacheWritePerMillion: 10
  }
};

export const MIN_CACHEABLE_INPUT_TOKENS = 1_024;

export function estimateLlmCost(
  profile: BenchmarkPricingProfile,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number
): LlmCostBreakdown {
  const rates = inputTokens > profile.shortContextLimit ? profile.long : profile.short;
  const safeInput = Math.max(0, inputTokens);
  const safeRead = Math.min(safeInput, Math.max(0, cacheReadTokens));
  const safeWrite = Math.min(safeInput - safeRead, Math.max(0, cacheWriteTokens));
  const uncachedInput = safeInput - safeRead - safeWrite;
  const safeOutput = Math.max(0, outputTokens);
  const inputCost = (uncachedInput * rates.inputPerMillion) / 1_000_000;
  const cacheReadCost = (safeRead * rates.cacheReadPerMillion) / 1_000_000;
  const cacheWriteCost = (safeWrite * rates.cacheWritePerMillion) / 1_000_000;
  const outputCost = (safeOutput * rates.outputPerMillion) / 1_000_000;
  return {
    pricingModel: profile.id,
    pricingSource: profile.source,
    inputTokens: safeInput,
    uncachedInputTokens: uncachedInput,
    cacheReadTokens: safeRead,
    cacheWriteTokens: safeWrite,
    outputTokens: safeOutput,
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    totalCost: inputCost + cacheReadCost + cacheWriteCost + outputCost
  };
}
