import type { LedgerRecord } from "./types.ts";

export interface LedgerBudget { maxRecords: number; maxChars: number }
export const TIER_LEDGER_BUDGET: Record<2 | 3, LedgerBudget> = {
  2: { maxRecords: 12, maxChars: 4000 },
  3: { maxRecords: 8, maxChars: 2500 },
};

export function normalizedLedgerText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function ledgerSemanticKey(record: Pick<LedgerRecord, "kind" | "ref" | "text">): string {
  return `${record.kind}\0${record.ref ?? ""}\0${normalizedLedgerText(record.text)}`;
}

export function normalizeInheritedLedger(records: readonly LedgerRecord[], tier: 2 | 3): LedgerRecord[] {
  const unique: LedgerRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = ledgerSemanticKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }

  const priority: LedgerRecord["kind"][] = ["constraint", "decision", "objective", "intent"];
  const budget = TIER_LEDGER_BUDGET[tier];
  const selected: LedgerRecord[] = [];
  let chars = 0;
  for (const kind of priority) {
    for (const record of unique) {
      if (record.kind !== kind || selected.length >= budget.maxRecords) continue;
      const length = record.text.length;
      if (chars + length > budget.maxChars) continue;
      selected.push(record);
      chars += length;
    }
  }
  return selected;
}
