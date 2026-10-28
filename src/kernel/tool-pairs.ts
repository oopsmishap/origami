import type { BoundMessage } from "./types.ts";

export interface ToolPairMessageLike {
  ref: string;
  role?: string;
  ephemeral?: boolean;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string;
}

export interface ToolPairGroup {
  callRef: string;
  resultRefs: string[];
  allRefs: Set<string>;
}

/**
 * Identify all assistant tool-call and tool-result message groups in the bound transcript.
 * Pairing is order-aware: a tool-result matches the most recent preceding assistant message
 * that declared its toolCallId.
 */
export function computeToolPairGroups(bound: readonly ToolPairMessageLike[]): ToolPairGroup[] {
  const groups: ToolPairGroup[] = [];
  const openGroupsByCallId = new Map<string, ToolPairGroup>();

  for (const m of bound) {
    if (m.ephemeral) continue;

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const allRefs = new Set<string>([m.ref]);
      const group: ToolPairGroup = {
        callRef: m.ref,
        resultRefs: [],
        allRefs,
      };
      groups.push(group);
      for (const call of m.toolCalls) {
        if (call.id) {
          openGroupsByCallId.set(call.id, group);
        }
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      const match = openGroupsByCallId.get(m.toolCallId);
      if (match) {
        match.resultRefs.push(m.ref);
        match.allRefs.add(m.ref);
      }
    }
  }

  return groups;
}

/**
 * Builds a map from every ref that participates in a tool pair to the full set
 * of sibling refs that must be folded or kept atomically together with it.
 */
export function buildToolPairPartnerMap(bound: readonly ToolPairMessageLike[]): Map<string, Set<string>> {
  const groups = computeToolPairGroups(bound);
  const map = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const ref of g.allRefs) {
      const existing = map.get(ref);
      if (existing) {
        for (const r of g.allRefs) existing.add(r);
      } else {
        map.set(ref, new Set(g.allRefs));
      }
    }
  }
  return map;
}

export interface SplitToolPair {
  callerRef: string;
  partnerRef: string;
  reason: string;
}

/**
 * Enforces tool pair atomicity on a candidate selection.
 * If a tool pair is partially selected:
 * - If missing partners are eligible for folding, they are added to `selected` (widening).
 * - If any missing partner is not eligible (e.g. sits in a protected zone), widening
 *   fails and the split is reported.
 */
export function widenSelectedToolPairs(params: {
  selected: Set<number>;
  bound: readonly BoundMessage[];
  isEligible: (idx: number) => boolean;
}): { widened: boolean; split?: SplitToolPair } {
  const { selected, bound, isEligible } = params;
  const groups = computeToolPairGroups(bound);
  const byRefIndex = new Map<string, number>();
  for (let i = 0; i < bound.length; i++) {
    if (bound[i]!.ref) byRefIndex.set(bound[i]!.ref, i);
  }

  let widened = false;
  let changed = true;

  while (changed) {
    changed = false;
    for (const group of groups) {
      const selectedInGroup: string[] = [];
      const missingInGroup: string[] = [];
      for (const ref of group.allRefs) {
        const idx = byRefIndex.get(ref);
        if (idx !== undefined && selected.has(idx)) {
          selectedInGroup.push(ref);
        } else {
          missingInGroup.push(ref);
        }
      }

      if (selectedInGroup.length > 0 && missingInGroup.length > 0) {
        for (const missingRef of missingInGroup) {
          const missingIdx = byRefIndex.get(missingRef);
          if (missingIdx === undefined || !isEligible(missingIdx)) {
            return {
              widened,
              split: {
                callerRef: group.callRef,
                partnerRef: missingRef,
                reason: missingIdx === undefined ? "missing from bound messages" : "partner sits in protected zone",
              },
            };
          }
          selected.add(missingIdx);
          widened = true;
          changed = true;
        }
      }
    }
  }

  return { widened };
}
