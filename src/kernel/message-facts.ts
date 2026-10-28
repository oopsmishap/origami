import { contentHash } from "./hash.ts";
import type { KernelMessage, KernelRole } from "./types.ts";
import { isRecord, strOr } from "./guards.ts";

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult", "developer", "system", "custom"]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function blockText(block: unknown): string {
  if (!isRecord(block)) return "";
  const type = strOr(block.type, "");
  switch (type) {
    case "text":
      return `text:${strOr(block.text, "")}`;
    case "thinking":
      return `thinking:${strOr(block.thinking, "")}`;
    case "redacted_thinking":
      return `redacted:${stableJson(block.data ?? null)}`;
    case "toolCall":
      return `toolCall:${strOr(block.id, "")}:${strOr(block.name, "")}:${stableJson(block.arguments ?? null)}`;
    case "image":
      return `image:${strOr(block.mimeType, "")}:${strOr(block.data, "").length}`;
    case "toolResult":
      return `toolResult:${strOr(block.toolCallId, "")}`;
    default:
      return `${type}:${stableJson(block)}`;
  }
}

function canonicalText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).join("\n");
  return content === undefined || content === null ? "" : stableJson(content);
}

export function messageFacts(message: unknown): KernelMessage | null {
  if (!isRecord(message)) return null;
  const role = strOr(message.role, "");
  if (!ROLES.has(role)) return null;

  const text = canonicalText(message.content);
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const signedThinking =
    Array.isArray(message.content) &&
    message.content.some(
      (b) => isRecord(b) && (b.type === "thinking" || b.type === "redacted_thinking") && typeof b.thinkingSignature === "string",
    );

  return {
    role: role as KernelRole,
    contentHash: contentHash(text),
    text,
    bytes: new TextEncoder().encode(text).length,
    signedThinking,
    toolCallId,
  };
}