export type CacheCoverage = "none" | "partial" | "full";

export interface CacheZoneInput {
  tokens: number;
}

export interface CachedZone {
  cachedTokens: number;
  cacheCoverage: CacheCoverage;
}

/**
 * Project the provider's cached-prefix token count onto context-order zones.
 * `prefixTokens` includes prompt overhead before the conversation (system prompt,
 * tool schemas); `overheadTokens` removes that prefix before walking the zones.
 */
export function annotateCachedPrefix<T extends CacheZoneInput>(
  zones: readonly T[],
  prefixTokens: number,
  overheadTokens: number,
): Array<T & CachedZone> {
  let remaining = Math.max(0, prefixTokens - Math.max(0, overheadTokens));
  return zones.map((zone) => {
    const tokens = Math.max(0, zone.tokens);
    const cachedTokens = Math.min(tokens, remaining);
    remaining = Math.max(0, remaining - tokens);
    const cacheCoverage: CacheCoverage =
      cachedTokens <= 0 ? "none" : cachedTokens >= tokens ? "full" : "partial";
    return { ...zone, cachedTokens, cacheCoverage };
  });
}
