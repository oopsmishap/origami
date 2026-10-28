import type { BoundMessage } from "./types.ts";

/** Tools commonly used by agents to declare or update plans/tasks. */
export const PLANNING_TOOL_PATTERNS: Record<string, true> = {
  TodoWrite: true,
  todowrite: true,
  todo_list: true,
  update_plan: true,
  TaskCreate: true,
  TaskUpdate: true,
  todo: true,
  task: true,
};

export const PLAN_STOPWORDS: Record<string, true> = {
  the: true,
  and: true,
  for: true,
  with: true,
  this: true,
  that: true,
  from: true,
  have: true,
  has: true,
  had: true,
  was: true,
  were: true,
  are: true,
  will: true,
  would: true,
  should: true,
  could: true,
  can: true,
  may: true,
  into: true,
  onto: true,
  over: true,
  under: true,
  about: true,
  after: true,
  before: true,
  between: true,
  each: true,
  all: true,
  any: true,
  some: true,
  not: true,
  but: true,
  then: true,
  than: true,
  when: true,
  while: true,
  where: true,
  which: true,
  who: true,
  what: true,
  how: true,
  why: true,
  because: true,
  done: true,
  todo: true,
  todos: true,
  task: true,
  tasks: true,
  status: true,
  pending: true,
  progress: true,
  step: true,
  steps: true,
  item: true,
  items: true,
  list: true,
  plan: true,
};

const PLAN_WINDOW_MESSAGES = 40;
const PLAN_TEXT_CHAR_CAP = 4000;

/** Tokenize text into lowercased plan signal terms. */
export function planTokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[a-z0-9_-]+|[\u4e00-\u9fff]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.toLowerCase())) !== null) {
    const t = m[0]!;
    const isCjk = /[\u4e00-\u9fff]/.test(t);
    if (!isCjk && t.length < 3) continue;
    if (!isCjk && Boolean(PLAN_STOPWORDS[t])) continue;
    out.push(t);
  }
  return out;
}

/**
 * Extracts weighted plan state terms from the recent message window.
 * Scans the last 40 messages for the latest task/todo planning tool calls (weight 2)
 * and the most recent user turn text (weight 1).
 */
export function extractPlanTerms(
  bound: readonly BoundMessage[],
  windowMessages = PLAN_WINDOW_MESSAGES,
): Map<string, number> | null {
  const start = Math.max(0, bound.length - windowMessages);
  const latestByTool = new Map<string, string>();
  const toolCallNamesById = new Map<string, string>();
  let lastUserText: string | undefined;

  for (let i = start; i < bound.length; i++) {
    const msg = bound[i]!;
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const call of msg.toolCalls) {
        if (Boolean(PLANNING_TOOL_PATTERNS[call.name])) {
          toolCallNamesById.set(call.id, call.name);
          if (msg.text) latestByTool.set(call.name, msg.text);
        }
      }
    } else if (msg.role === "toolResult" && msg.toolCallId && toolCallNamesById.has(msg.toolCallId)) {
      const toolName = toolCallNamesById.get(msg.toolCallId)!;
      if (msg.text) {
        const existing = latestByTool.get(toolName) ?? "";
        latestByTool.set(toolName, `${existing} ${msg.text}`.trim());
      }
    } else if (msg.role === "user" && !msg.ephemeral && msg.text) {
      lastUserText = msg.text;
    }
  }

  const sources: Array<{ text: string; weight: number }> = [];
  for (const text of latestByTool.values()) {
    if (text) sources.push({ text, weight: 2 });
  }
  if (lastUserText) {
    sources.push({ text: lastUserText, weight: 1 });
  }

  if (sources.length === 0) return null;

  const terms = new Map<string, number>();
  for (const { text, weight } of sources) {
    const capped = text.length > PLAN_TEXT_CHAR_CAP ? text.slice(0, PLAN_TEXT_CHAR_CAP) : text;
    for (const tok of planTokenize(capped)) {
      terms.set(tok, (terms.get(tok) ?? 0) + weight);
    }
  }

  return terms.size > 0 ? terms : null;
}

/**
 * Computes plan overlap score between a block's topic and summary/snippet
 * against weighted plan terms.
 */
export function scoreBlockPlanOverlap(
  topic: string | undefined,
  summaryOrSnippet: string,
  terms: Map<string, number>,
): number {
  const hay = `${topic ?? ""} ${summaryOrSnippet}`.toLowerCase();
  let score = 0;
  for (const [term, w] of terms) {
    if (!hay.includes(term)) continue;
    let count = 0;
    let idx = hay.indexOf(term);
    while (idx !== -1) {
      count++;
      idx = hay.indexOf(term, idx + term.length);
    }
    score += w * count;
  }
  return score;
}

/**
 * Re-ranks search candidate hits using plan-state term overlap (#5047).
 * Active blocks are retained at the top, and blocks matching active plan terms
 * receive boosted positioning.
 */
export function rerankHitsWithPlan<T extends { topic?: string; snippet?: string; status?: string; rank?: number }>(
  hits: readonly T[],
  terms: Map<string, number> | null,
): Array<T & { planScore?: number }> {
  if (!terms || terms.size === 0) {
    return hits.map((h) => ({ ...h, planScore: 0 }));
  }

  const scored = hits.map((h) => ({
    ...h,
    planScore: scoreBlockPlanOverlap(h.topic, h.snippet ?? "", terms),
  }));

  return scored.sort((a, b) => {
    // 1. Active status first
    const aActive = a.status === "active" ? 1 : 0;
    const bActive = b.status === "active" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    // 2. Positive plan score boost
    const aHasPlan = (a.planScore ?? 0) > 0 ? 1 : 0;
    const bHasPlan = (b.planScore ?? 0) > 0 ? 1 : 0;
    if (aHasPlan !== bHasPlan) return bHasPlan - aHasPlan;

    if (aHasPlan && bHasPlan && (a.planScore ?? 0) !== (b.planScore ?? 0)) {
      return (b.planScore ?? 0) - (a.planScore ?? 0);
    }

    // 3. Fall back to FTS5 BM25 rank (lower is better in SQLite FTS5)
    if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) {
      return a.rank - b.rank;
    }

    return 0;
  });
}
