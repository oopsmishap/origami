const KEEP_DROP_RULES = `## KEEP VERBATIM
- Full file paths with line numbers on every mention (\`lib/hooks.ts:347\`), never bare filenames.
- Function/class/type signatures exactly as written, plus the critical code lines that encode logic.
- Error messages and stack traces verbatim — you need the literal string to grep later.
- Key report/analysis details: keep the numbers and the mechanism, not just the conclusion.
- Decisions AND their rationale ("chose X over Y because Z" — the "because" is load-bearing).
- Constraints discovered ("must support Node 22", "no new dependencies").
- Exact values: versions, config keys, thresholds, magic numbers.
- User intent: quote short user messages verbatim ONLY with their message ref (\`[#m00132]\`). Without a verifiable ref, paraphrase.
- Open objectives — if any source message names work still open, the summary MUST keep a one-line \`Open objectives:\` entry naming each with its ref. These are the last thing to drop and the first to restore.

## DROP
- Verbose logs/build output once the error line or result is captured.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration — search hits and successful tool outputs — once the facts are extracted.
- Dead-end exploration, but PRESERVE the lesson in one line: "tried X, failed because Y".
- Back-and-forth once the final position is captured.
- Repeated status checks once state is known.`;

const TIER1_RULES = `## Tier 1 — Range fold (\`fold\` with message ranges)
Fold a contiguous span of older messages into one summary block. The summary replaces those messages in the rendered context; the originals stay recoverable.
- Range syntax: \`"m00012..m00048"\`. One fold call may carry several folds; folds in one call must not overlap.
- Write a \`topic\` (a few words) and a \`summary\` that lets a later reader continue WITHOUT the originals. A summary that is not smaller than what it replaces is rejected.
- Group under short thematic headers when a range spans distinct concerns.
- Preserve the goal, its evolution, every open objective, every decision and its rationale.
- The pinned first user message, the current in-flight turn, and the protected recent tail cannot be folded.`;

const TIER2_RULES = `## Tier 2 — Distillation (fold block ranges \`"b1..b5"\` or \`"b1,b4,b7"\`)
Merge at least 2 active tier-1 blocks into one denser summary; the merged blocks are consumed (they leave context and return only if the tier-2 block is unfolded). Re-carry open objectives verbatim. Keep decisions and their rationale. This is the summary-of-summaries path: what survives here is what a reader needs after months.`;

const TIER3_RULES = `## Tier 3 — Ultra-condense (fold block ranges)
Merge at least 2 active lower-tier blocks. Keep ONLY: the goal, open objectives, and the load-bearing constraints. Everything else is expendable.`;

const RECOVERY_RULES = `## Getting detail back
- \`fold_recall\` with refs (\`"m00042..m00045"\`) returns the exact original text without changing context. Use it whenever a summary is too thin for the task at hand — exact strings, numbers, code.
- \`fold_search\` finds blocks and archived original messages by content when you don't know the refs; message hits list refs to pass to \`fold_recall\`.
- \`unfold\` (\`mode: "file"\`) writes a block's originals to an artifact; \`mode: "inline"\` puts the block's contents back in context (one level; \`deep: true\` for raw messages). A consumed block is unfolded through its parent.`;

const NUDE_RESPONSE = `## Responding to nudges
Messages beginning with \`[origami]\` are folding reminders.
- Emergency (context nearly full): fold before doing anything else. Not optional.
- Efficiency: lists candidate ranges, largest first, with size and tool share. Fold the finished ones — all or a subset, using the advertised boundaries. Defer any range whose work is still in active use; the reminder returns after more growth.
- Promotion: suggests merging tier-1 (or tier-2) blocks into the next tier. Merge related blocks; defer if they are unrelated threads you still need apart.
Do not restate the nudge; fold, then continue your work.`;

export function doctrinePrompt(): string {
  return [
    "# Context folding (origami)",
    "This conversation is managed by an incremental hierarchical folding system. Fold history into summary blocks to keep the working context small while preserving everything needed to continue.",
    "",
    KEEP_DROP_RULES,
    "",
    TIER1_RULES,
    "",
    TIER2_RULES,
    "",
    TIER3_RULES,
    "",
    RECOVERY_RULES,
    "",
    NUDE_RESPONSE,
  ].join("\n");
}

export function summaryShapeInstruction(): string {
  return [
    "Write dense, scannable bullets — not narrative prose.",
    "Every line must earn its place.",
    "Group bullets under short thematic headers when a range spans distinct concerns.",
    "KEEP VERBATIM: file paths with line numbers, signatures, exact error strings, exact values, decisions with their rationale.",
  ].join("\n");
}