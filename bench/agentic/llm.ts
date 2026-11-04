/**
 * Benchmark message utilities.
 *
 * Model calls and tool execution are owned by the Vercel AI SDK. This module
 * only keeps the benchmark's strategy-facing message shape, converts native
 * reasoning/tool parts, and models cache-prefix accounting for reports.
 */

import type { ModelMessage } from "ai";
import { countTokens } from "../replay-lib.ts";
import { MIN_CACHEABLE_INPUT_TOKENS } from "./pricing.ts";
import type { BenchmarkTokenizer } from "./tokenizer.ts";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCacheState {
  previousMessages: string[] | null;
}

export function createLlmCacheState(): LlmCacheState {
  return { previousMessages: null };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const value = output as Record<string, unknown>;
    if (value.type === "text" || value.type === "error-text") return String(value.value ?? "");
    if (value.type === "json" || value.type === "error-json") return JSON.stringify(value.value ?? null);
  }
  return JSON.stringify(output ?? "");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("");
}

/** Convert benchmark messages to AI SDK messages, preserving native reasoning. */
export function toModelMessages(messages: readonly LlmMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "user") return { role: "user", content: message.content };

    if (message.role === "tool") {
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.tool_call_id ?? "unknown-tool-call",
          toolName: message.name ?? "unknown",
          output: { type: "text", value: message.content }
        }]
      } as ModelMessage;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (message.reasoning) parts.push({ type: "reasoning", text: message.reasoning });
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      parts.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.function.name,
        input: parseArguments(call.function.arguments)
      });
    }
    return { role: "assistant", content: parts } as ModelMessage;
  });
}

/** Convert AI SDK response/model messages to the strategy-facing shape. */
export function fromModelMessages(messages: readonly ModelMessage[]): LlmMessage[] {
  return messages.flatMap((message): LlmMessage[] => {
    if (message.role === "system") return [{ role: "system", content: message.content }];
    if (message.role === "user") return [{ role: "user", content: textFromContent(message.content) }];

    if (message.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content : [];
      return parts
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          role: "tool",
          content: stringifyOutput(part.output),
          name: String(part.toolName ?? "unknown"),
          tool_call_id: String(part.toolCallId ?? "")
        }));
    }

    const parts = Array.isArray(message.content) ? message.content : [];
    let content = "";
    let reasoning = "";
    const toolCalls: LlmToolCall[] = [];
    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.type === "text") content += String(part.text ?? "");
      else if (part.type === "reasoning") reasoning += String(part.text ?? "");
      else if (part.type === "tool-call") {
        toolCalls.push({
          id: String(part.toolCallId ?? ""),
          type: "function",
          function: {
            name: String(part.toolName ?? ""),
            arguments: JSON.stringify(part.input ?? {})
          }
        });
      }
    }
    return [{
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    }];
  });
}

export function countLlmMessageTokens(message: LlmMessage, tokenizer?: BenchmarkTokenizer): number {
  if (tokenizer) {
    return tokenizer.countMessage(message);
  }
  const reasoning = message.role === "assistant" ? message.reasoning ?? "" : "";
  const toolCalls = message.role === "assistant" && message.tool_calls?.length
    ? message.tool_calls.map((call) => `${call.function.name}\n${call.function.arguments}`).join("\n")
    : "";
  const metadata = message.role === "tool"
    ? `${message.name ?? ""}\n${message.tool_call_id ?? ""}`
    : "";
  return countTokens([message.content, reasoning, toolCalls, metadata].filter(Boolean).join("\n"));
}

export function cacheAccounting(
  messages: readonly LlmMessage[],
  promptTokens: number,
  state: LlmCacheState,
  tokenizer?: BenchmarkTokenizer
): { cachedTokens: number; cacheWriteTokens: number } {
  const fingerprints = messages.map((message) => JSON.stringify(message));
  let commonCount = 0;
  let commonTokens = 0;
  if (state.previousMessages) {
    for (let i = 0; i < Math.min(state.previousMessages.length, fingerprints.length); i++) {
      if (state.previousMessages[i] !== fingerprints[i]) break;
      commonTokens += countLlmMessageTokens(messages[i]!, tokenizer);
      commonCount++;
    }
  }
  let freshTokens = 0;
  for (let i = commonCount; i < messages.length; i++) {
    freshTokens += countLlmMessageTokens(messages[i]!, tokenizer);
  }
  const totalLocal = commonTokens + freshTokens;
  let effectiveCommon = commonTokens;
  if (totalLocal > promptTokens && totalLocal > 0) {
    effectiveCommon = Math.floor(promptTokens * (commonTokens / totalLocal));
    if (freshTokens > 0 && effectiveCommon >= promptTokens) {
      effectiveCommon = Math.max(0, promptTokens - 1);
    }
  }
  const eligible = promptTokens >= MIN_CACHEABLE_INPUT_TOKENS;
  const cachedTokens = eligible && effectiveCommon >= MIN_CACHEABLE_INPUT_TOKENS
    ? Math.min(promptTokens, effectiveCommon)
    : 0;
  const cacheWriteTokens = eligible ? Math.max(0, promptTokens - cachedTokens) : 0;
  state.previousMessages = fingerprints;
  return { cachedTokens, cacheWriteTokens };
}
