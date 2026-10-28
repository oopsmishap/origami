import type { ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DbBlockHit, DbMessageHit } from "../persist/db.ts";
import type { OrigamiRuntime } from "../runtime.ts";

/**
 * Extracts query string if the tool call was directed at cross-session memory
 * (either directly via `recall` / `xd://recall` or via writing to `xd://recall`).
 */
export function extractRecallQuery(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (toolName === "recall" || toolName === "xd://recall") {
    if (typeof input.query === "string" && input.query.trim()) return input.query.trim();
    if (typeof input.text === "string" && input.text.trim()) return input.text.trim();
  }
  if (toolName === "write" && typeof input.path === "string" && input.path.trim() === "xd://recall") {
    const raw = typeof input.content === "string" ? input.content : "";
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.query === "string" && parsed.query.trim()) return parsed.query.trim();
      if (typeof parsed?.text === "string" && parsed.text.trim()) return parsed.text.trim();
    } catch {
      if (raw.trim()) return raw.trim();
    }
  }
  return null;
}

/** Formats an in-session folded history notice to append to recall results. */
export function formatRecallFederationNotice(
  sessionId: string,
  blockHits: readonly DbBlockHit[],
  messageHits: readonly DbMessageHit[],
): string {
  const lines: string[] = [
    "---",
    `[Origami In-Session History · ${sessionId}]`,
    "Found folded history in THIS conversation matching your query:",
  ];

  if (blockHits.length > 0) {
    for (const b of blockHits) {
      const statusLabel = b.status !== "active" ? ` · ${b.status}` : "";
      const snippet = b.snippet ? ` — "${b.snippet.replace(/\n+/g, " ").trim()}"` : "";
      lines.push(`- Fold Block ${b.block_id} (tier ${b.tier}${statusLabel}): ${b.topic}${snippet}`);
    }
  }

  if (messageHits.length > 0) {
    const refs = messageHits.map((m) => m.ref).join(",");
    lines.push(`- Matching original message refs: ${refs}`);
    for (const m of messageHits.slice(0, 2)) {
      const snippet = m.snippet ? ` — "${m.snippet.replace(/\n+/g, " ").trim()}"` : "";
      lines.push(`  * ${m.ref} (${m.role}, turn ${m.turn})${snippet}`);
    }
  }

  lines.push("Use `fold_search` for full ranking, or `fold_recall(refs=\"...\")` to read exact verbatim text.");
  return lines.join("\n");
}

/**
 * Intercepts tool execution results for recall/memory queries and augments
 * them with in-session folded history if matching blocks or messages exist.
 */
export function handleRecallToolResult(
  event: ToolResultEvent,
  sessionId: string,
  rt: OrigamiRuntime,
): ToolResultEventResult | void {
  const query = extractRecallQuery(event.toolName, event.input as Record<string, unknown>);
  if (!query || !rt.db) return;

  // Search exclusively within this active session
  const cleanTerms = query.replace(/[^\w\s-]/g, " ").trim();
  if (!cleanTerms) return;

  const searchQuery = `session:${sessionId} ${cleanTerms}`;
  const blockHits = rt.db.searchBlocks(searchQuery, 3);
  const messageHits = rt.db.searchMessages(searchQuery, 3);

  if (blockHits.length === 0 && messageHits.length === 0) return;

  const notice = formatRecallFederationNotice(sessionId, blockHits, messageHits);
  const existing = event.content ?? [];
  const textBlocks = existing.filter((c): c is { type: "text"; text: string } => c.type === "text");
  const otherBlocks = existing.filter((c) => c.type !== "text");

  const originalText = textBlocks.map((b) => b.text).join("\n\n");
  if (originalText.includes("[Origami In-Session History")) return;
  const augmentedText = originalText ? `${originalText}\n\n${notice}` : notice;
  const details = "details" in event ? event.details : undefined;
  return {
    content: [{ type: "text", text: augmentedText }, ...otherBlocks],
    details,
    isError: event.isError,
  };
}
