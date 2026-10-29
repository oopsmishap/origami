import type { FoldKeep, FoldSpec } from "../engine.ts";

export interface SalvagedFoldParams {
  folds: FoldSpec[];
  tier?: 1 | 2 | 3;
}

export type SalvageResult =
  | { ok: true; params: SalvagedFoldParams }
  | { ok: false; error: string };

function cleanStr(val: unknown): string {
  if (val === undefined || val === null) return "";
  let s = String(val).trim();
  // Strip outer quotes or code backticks if the model quoted the string verbatim
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("`") && s.endsWith("`"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const KEEP_KINDS = new Set(["constraint", "decision", "objective"]);

/** Parse a value that may arrive as a JSON string. */
function maybeJson(val: unknown): unknown {
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val.trim());
  } catch {
    return val;
  }
}

function salvageLedgerFields(
  obj: Record<string, unknown>,
): { ok: true; fields: Pick<FoldSpec, "keep" | "retire"> } | { ok: false; error: string } {
  const fields: Pick<FoldSpec, "keep" | "retire"> = {};
  if (obj.keep !== undefined && obj.keep !== null) {
    const keep = maybeJson(obj.keep);
    const valid =
      Array.isArray(keep) &&
      keep.every(
        (k) =>
          k !== null &&
          typeof k === "object" &&
          KEEP_KINDS.has((k as { kind?: unknown }).kind as string) &&
          typeof (k as { text?: unknown }).text === "string" &&
          ((k as { ref?: unknown }).ref === undefined || typeof (k as { ref?: unknown }).ref === "string"),
      );
    if (!valid) return { ok: false, error: "keep must be an array of {kind,text,ref?}" };
    fields.keep = (keep as FoldKeep[]).map((k) => ({ kind: k.kind, text: k.text, ...(k.ref !== undefined ? { ref: cleanStr(k.ref) } : {}) }));
  }
  if (obj.retire !== undefined && obj.retire !== null) {
    const retire = maybeJson(obj.retire);
    if (!Array.isArray(retire) || !retire.every((r) => typeof r === "string")) {
      return { ok: false, error: "retire must be an array of ledger ids" };
    }
    fields.retire = retire.map((r) => cleanStr(r));
  }
  return { ok: true, fields };
}

/**
 * Salvage and canonicalize fold parameters from LLM tool calls (Billion-Context #2580, #1502).
 * Handles:
 * 1. Shorthand top-level { range, topic, summary } instead of { folds: [...] }
 * 2. Stringified JSON folds array
 * 3. Coercing string tiers ("1" -> 1)
 * 4. Stripping stray outer quotes/backticks from range specs
 * 5. Inferring tier 2 distillation when range targets blocks ("b1..b3") without explicit tier
 */
export function salvageFoldParams(raw: unknown): SalvageResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "fold parameters must be an object" };
  }

  const obj = { ...(raw as Record<string, unknown>) };

  // Parse stringified folds if model passed JSON string
  if (typeof obj.folds === "string") {
    try {
      const parsed = JSON.parse(obj.folds.trim());
      if (Array.isArray(parsed)) obj.folds = parsed;
    } catch {
      /* keep as-is */
    }
  }

  // Coerce tier: accepts 1, 2, 3 or "1", "2", "3"
  let tier: 1 | 2 | 3 | undefined;
  if (obj.tier !== undefined && obj.tier !== null && obj.tier !== "") {
    const rawTier = typeof obj.tier === "string" ? parseInt(obj.tier.trim(), 10) : Number(obj.tier);
    if (rawTier === 1 || rawTier === 2 || rawTier === 3) {
      tier = rawTier as 1 | 2 | 3;
    } else {
      return { ok: false, error: `invalid tier: ${String(obj.tier)} (expected 1, 2, or 3)` };
    }
  }

  const folds: FoldSpec[] = [];

  // Case 1: Standard { folds: [...] }
  if (Array.isArray(obj.folds)) {
    for (let i = 0; i < obj.folds.length; i++) {
      const item = obj.folds[i];
      if (!item || typeof item !== "object") {
        return { ok: false, error: `fold spec at index ${i} must be an object` };
      }
      const itemObj = item as Record<string, unknown>;
      const range = cleanStr(itemObj.range);
      const topic = cleanStr(itemObj.topic);
      const summary = cleanStr(itemObj.summary);
      if (!range) return { ok: false, error: `fold spec at index ${i} is missing 'range'` };
      if (!summary) return { ok: false, error: `fold spec at index ${i} is missing 'summary'` };

      const rawItemTier = itemObj.tier;
      let itemTier: 1 | 2 | 3 | undefined;
      if (rawItemTier !== undefined && rawItemTier !== null && rawItemTier !== "") {
        const num = typeof rawItemTier === "string" ? parseInt(rawItemTier.trim(), 10) : Number(rawItemTier);
        if (num === 1 || num === 2 || num === 3) itemTier = num as 1 | 2 | 3;
      } else if (tier === undefined) {
        if (/^\s*b\d+/i.test(range)) itemTier = 2;
        else if (/^\s*m\d+/i.test(range)) itemTier = 1;
      }
      const ledger = salvageLedgerFields(itemObj);
      if (!ledger.ok) return ledger;
      folds.push({ range, topic: topic || "Summary", summary, ...(itemTier !== undefined ? { tier: itemTier } : {}), ...ledger.fields });
    }
  } else if (typeof obj.range === "string" || typeof obj.summary === "string") {
    // Case 2: Shorthand top-level { range, topic, summary }
    const range = cleanStr(obj.range);
    const topic = cleanStr(obj.topic);
    const summary = cleanStr(obj.summary);
    if (!range) return { ok: false, error: "fold parameters missing 'range'" };
    if (!summary) return { ok: false, error: "fold parameters missing 'summary'" };
    const ledger = salvageLedgerFields(obj);
    if (!ledger.ok) return ledger;
    folds.push({ range, topic: topic || "Summary", summary, ...ledger.fields });
  }

  if (folds.length === 0) {
    return { ok: false, error: "fold requires either 'folds' array or 'range' and 'summary' fields" };
  }

  // Infer tier 2 if all ranges target blocks (e.g. "b1,b2" or "b1..b5") and tier was not set
  if (tier === undefined && folds.every((f) => /^\s*b\d+/i.test(f.range))) {
    tier = 2;
  }

  return { ok: true, params: { folds, ...(tier !== undefined ? { tier } : {}) } };
}
