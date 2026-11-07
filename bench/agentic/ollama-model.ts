import type {
  JSONObject,
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage
} from "@ai-sdk/provider";
import { createOllama } from "ollama-ai-provider-v2";

export interface NativeOllamaModelOptions {
  host: string;
  think: boolean;
  windowTokens?: number;
  /** Per-request HTTP timeout in ms before falling back or surfacing timeout (default: 240_000). */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: number | string; message?: string; cause?: unknown };
  if (e.name === "TimeoutError" || e.code === 23 || (e.code === "ABORT_ERR" && /\btimed?\s*out\b/i.test(e.message ?? ""))) {
    return true;
  }
  if (typeof e.message === "string" && /\b(?:operation timed out|request timed out|step timed out|timed out)\b/i.test(e.message)) {
    return true;
  }
  return e.cause ? isTimeoutError(e.cause) : false;
}

export function isTruncatedToolCallError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; responseBody?: string; cause?: unknown; errors?: unknown[] };
  const text = `${e.message ?? ""} ${e.responseBody ?? ""}`;
  if (/invalid tool call arguments|unexpected end of JSON input/i.test(text)) {
    return true;
  }
  if (Array.isArray(e.errors) && e.errors.some((sub) => isTruncatedToolCallError(sub))) {
    return true;
  }
  return e.cause ? isTruncatedToolCallError(e.cause) : false;
}

export function createBunSafeFetch(): typeof fetch {
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, { ...(init ?? {}), timeout: false } as RequestInit)) as typeof fetch;
  return Object.assign(wrapped, globalThis.fetch);
}

function withCallTimeout(outerSignal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return outerSignal;
  const timer = AbortSignal.timeout(timeoutMs);
  return outerSignal ? AbortSignal.any([outerSignal, timer]) : timer;
}

export function hasUnparsedToolMarkup(thinking: string, content: string, toolCallCount: number): boolean {
  if (toolCallCount > 0 || content.trim().length > 0) return false;
  return /<\/?(?:tool_call|function|parameter)\b[^>]*>/i.test(thinking);
}

const CHANNEL_TOKEN_RE = /<\|?thought\|?>|<\|?channel\|?>|<turn\|>/gi;

/**
 * Strips leaked Gemma 4 / Ollama special channel markers (`<|thought|>`, `<channel|>`, `<turn|>`)
 * from assistant text parts so malformed control tokens never pollute conversation history
 * or trigger in-context imitation loops on subsequent turns.
 */
export function sanitizeModelContent(content: LanguageModelV4Content[]): LanguageModelV4Content[] {
  const hasToolCalls = content.some((part) => part.type === "tool-call");
  const sanitized: LanguageModelV4Content[] = [];

  for (const part of content) {
    if (part.type !== "text") {
      sanitized.push(part);
      continue;
    }
    const raw = part.text;
    if (!raw || !/<\|?(?:thought|channel)|<turn\|>/i.test(raw)) {
      sanitized.push(part);
      continue;
    }

    // Case 1: Explicit `<|thought|>...<channel|>answer` leaked into text
    const thoughtMatch = raw.match(/^\s*<\|?thought\|?>([\s\S]*?)<\|?channel\|?>([\s\S]*)$/i);
    if (thoughtMatch) {
      const thoughtText = thoughtMatch[1]!.replace(CHANNEL_TOKEN_RE, "").trim();
      const answerText = thoughtMatch[2]!.replace(CHANNEL_TOKEN_RE, "").trim();
      if (thoughtText) sanitized.push({ type: "reasoning", text: thoughtText });
      if (answerText) sanitized.push({ ...part, text: answerText });
      continue;
    }

    // Case 2: Bare `<channel|>` inside text (Gemma 4 closing thought marker or trailing artifact)
    const channelIdx = raw.search(/<\|?channel\|?>/i);
    if (channelIdx >= 0) {
      const before = raw.slice(0, channelIdx).replace(CHANNEL_TOKEN_RE, "").trim();
      const after = raw.slice(channelIdx).replace(/^\s*<\|?channel\|?>\s*/i, "").replace(CHANNEL_TOKEN_RE, "").trim();
      if (hasToolCalls && !after && before) {
        sanitized.push({ type: "reasoning", text: before });
        continue;
      }
      const cleaned = before && after
        ? before
        : (before || after);
      if (cleaned) sanitized.push({ ...part, text: cleaned });
      continue;
    }

    const stripped = raw.replace(CHANNEL_TOKEN_RE, "").trim();
    if (stripped) sanitized.push({ ...part, text: stripped });
  }

  return sanitized;
}

function normalizeBaseUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function inspectContent(content: LanguageModelV4Content[]): {
  thinking: string;
  text: string;
  toolCallCount: number;
} {
  let thinking = "";
  let text = "";
  let toolCallCount = 0;
  for (const part of content) {
    if (part.type === "reasoning") {
      thinking += part.text;
    } else if (part.type === "text") {
      text += part.text;
    } else if (part.type === "tool-call") {
      toolCallCount++;
    }
  }
  return { thinking, text, toolCallCount };
}

function sumDefined(a: unknown, b: unknown): number | undefined {
  const numA = typeof a === "number" ? a : undefined;
  const numB = typeof b === "number" ? b : undefined;
  if (numA == null && numB == null) return undefined;
  return (numA ?? 0) + (numB ?? 0);
}

function enrichUsage(usage: LanguageModelV4Usage, rawBody: unknown): LanguageModelV4Usage {
  const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : undefined;
  const raw = (usage.raw as Record<string, unknown> | undefined) ?? body ?? {};
  const promptEval = (body?.prompt_eval_count as number | undefined) ?? usage.inputTokens.total;
  const evalCount = (body?.eval_count as number | undefined) ?? usage.outputTokens.total;

  return {
    ...usage,
    inputTokens: {
      ...usage.inputTokens,
      total: usage.inputTokens.total ?? promptEval,
      noCache: usage.inputTokens.noCache ?? promptEval,
    },
    outputTokens: {
      ...usage.outputTokens,
      total: usage.outputTokens.total ?? evalCount,
    },
    raw: {
      ...raw,
      prompt_eval_count: promptEval ?? null,
      eval_count: evalCount ?? null,
      max_prompt_eval_count: promptEval ?? null,
      prompt_eval_counts: promptEval != null ? [promptEval] : [],
      eval_counts: evalCount != null ? [evalCount] : [],
      attempts: 1,
      total_duration: (body?.total_duration as number | undefined) ?? (raw.total_duration as number | undefined) ?? null,
      load_duration: (body?.load_duration as number | undefined) ?? (raw.load_duration as number | undefined) ?? null,
      prompt_eval_duration: (body?.prompt_eval_duration as number | undefined) ?? (raw.prompt_eval_duration as number | undefined) ?? null,
      eval_duration: (body?.eval_duration as number | undefined) ?? (raw.eval_duration as number | undefined) ?? null,
    },
  };
}

export function combineUsage(u1: LanguageModelV4Usage, u2: LanguageModelV4Usage): LanguageModelV4Usage {
  const raw1 = (u1?.raw as Record<string, unknown> | undefined) ?? {};
  const raw2 = (u2?.raw as Record<string, unknown> | undefined) ?? {};

  const totalInput = sumDefined(u1?.inputTokens?.total, u2?.inputTokens?.total);
  const totalOutput = sumDefined(u1?.outputTokens?.total, u2?.outputTokens?.total);

  const p1 = (raw1.prompt_eval_count as number | undefined) ?? u1?.inputTokens?.total;
  const p2 = (raw2.prompt_eval_count as number | undefined) ?? u2?.inputTokens?.total;
  const promptEvalCounts: number[] = [];
  if (p1 != null) promptEvalCounts.push(p1);
  if (p2 != null) promptEvalCounts.push(p2);

  const e1 = (raw1.eval_count as number | undefined) ?? u1?.outputTokens?.total;
  const e2 = (raw2.eval_count as number | undefined) ?? u2?.outputTokens?.total;
  const evalCounts: number[] = [];
  if (e1 != null) evalCounts.push(e1);
  if (e2 != null) evalCounts.push(e2);

  const maxPrompt = promptEvalCounts.length > 0 ? Math.max(...promptEvalCounts) : totalInput;

  return {
    inputTokens: {
      total: totalInput,
      noCache: sumDefined(u1?.inputTokens?.noCache, u2?.inputTokens?.noCache) ?? totalInput,
      cacheRead: sumDefined(u1?.inputTokens?.cacheRead, u2?.inputTokens?.cacheRead),
      cacheWrite: sumDefined(u1?.inputTokens?.cacheWrite, u2?.inputTokens?.cacheWrite),
    },
    outputTokens: {
      total: totalOutput,
      text: sumDefined(u1?.outputTokens?.text, u2?.outputTokens?.text),
      reasoning: sumDefined(u1?.outputTokens?.reasoning, u2?.outputTokens?.reasoning),
    },
    raw: {
      ...raw2,
      prompt_eval_count: sumDefined(raw1.prompt_eval_count, raw2.prompt_eval_count) ?? totalInput ?? null,
      eval_count: sumDefined(raw1.eval_count, raw2.eval_count) ?? totalOutput ?? null,
      max_prompt_eval_count: maxPrompt ?? null,
      prompt_eval_counts: promptEvalCounts,
      eval_counts: evalCounts,
      attempts: 2,
      total_duration: sumDefined(raw1.total_duration, raw2.total_duration) ?? null,
      load_duration: sumDefined(raw1.load_duration, raw2.load_duration) ?? null,
      prompt_eval_duration: sumDefined(raw1.prompt_eval_duration, raw2.prompt_eval_duration) ?? null,
      eval_duration: sumDefined(raw1.eval_duration, raw2.eval_duration) ?? null,
    },
  };
}

export class NativeOllamaLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "ollama-native";
  private readonly underlyingModel: LanguageModelV4;

  constructor(
    readonly modelId: string,
    private readonly options: NativeOllamaModelOptions
  ) {
    const baseURL = normalizeBaseUrl(options.host);
    const ollama = createOllama({
      baseURL,
      fetch: options.fetch ?? createBunSafeFetch(),
    });
    this.underlyingModel = ollama.chat(modelId);
  }

  get supportedUrls(): Record<string, RegExp[]> {
    return (this.underlyingModel.supportedUrls as Record<string, RegExp[]>) ?? {};
  }

  private buildAdaptedOptions(
    options: LanguageModelV4CallOptions,
    thinkOverride?: boolean
  ): LanguageModelV4CallOptions {
    const existingOllama = (options.providerOptions?.ollama as Record<string, unknown> | undefined) ?? {};
    const existingOllamaOptions = (existingOllama.options as Record<string, unknown> | undefined) ?? {};

    const ollamaOptions: Record<string, unknown> = {
      ...existingOllamaOptions,
    };

    if (this.options.windowTokens != null && ollamaOptions.num_ctx === undefined) {
      ollamaOptions.num_ctx = this.options.windowTokens;
    }
    if (options.maxOutputTokens != null && ollamaOptions.num_predict === undefined) {
      ollamaOptions.num_predict = options.maxOutputTokens;
    }
    if (options.topK != null && ollamaOptions.top_k === undefined) {
      ollamaOptions.top_k = options.topK;
    }
    if (options.temperature != null && ollamaOptions.temperature === undefined) {
      ollamaOptions.temperature = options.temperature;
    }
    if (options.topP != null && ollamaOptions.top_p === undefined) {
      ollamaOptions.top_p = options.topP;
    }
    if (options.stopSequences?.length && ollamaOptions.stop === undefined) {
      ollamaOptions.stop = options.stopSequences;
    }

    let think: boolean;
    if (thinkOverride !== undefined) {
      think = thinkOverride;
    } else if (options.reasoning === "none") {
      think = false;
    } else if (typeof existingOllama.think === "boolean") {
      think = existingOllama.think;
    } else {
      think = this.options.think;
    }

    return {
      ...options,
      topK: undefined,
      providerOptions: {
        ...options.providerOptions,
        ollama: {
          ...(existingOllama as JSONObject),
          think,
          options: ollamaOptions as JSONObject,
        },
      },
    };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    if (options.abortSignal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }

    const perCallMs = this.options.requestTimeoutMs ?? 240_000;
    const adaptedOptions = this.buildAdaptedOptions({
      ...options,
      abortSignal: withCallTimeout(options.abortSignal, perCallMs)
    });
    const thinkEnabled = adaptedOptions.providerOptions?.ollama?.think !== false;

    let result1: LanguageModelV4GenerateResult;
    try {
      result1 = await this.underlyingModel.doGenerate(adaptedOptions);
    } catch (err) {
      // If a thinking call hung OR truncated mid-tool-JSON (`unexpected end of JSON input` after long thinking),
      // retry immediately with `think: false` and boosted `maxOutputTokens` using the warm prompt KV cache.
      const truncatedTool = isTruncatedToolCallError(err);
      if (thinkEnabled && (isTimeoutError(err) || truncatedTool) && !options.abortSignal?.aborted) {
        const nonThinkingRetry = this.buildAdaptedOptions(
          {
            ...options,
            maxOutputTokens: Math.max(options.maxOutputTokens ?? 4_096, 8_192),
            abortSignal: withCallTimeout(options.abortSignal, perCallMs)
          },
          false
        );
        result1 = await this.underlyingModel.doGenerate(nonThinkingRetry);
      } else {
        throw err;
      }
    }

    const enriched1: LanguageModelV4GenerateResult = {
      ...result1,
      content: sanitizeModelContent(result1.content),
      usage: enrichUsage(result1.usage, result1.response?.body),
    };
    const singleRaw = enriched1.usage.raw as Record<string, unknown> | undefined;
    const promptCount = (singleRaw?.prompt_eval_count as number | undefined) ?? enriched1.usage.inputTokens.total ?? 0;
    const evalCount = (singleRaw?.eval_count as number | undefined) ?? enriched1.usage.outputTokens.total ?? 0;

    const baseResult: LanguageModelV4GenerateResult = {
      ...enriched1,
      providerMetadata: {
        ...enriched1.providerMetadata,
        ollama: {
          ...((enriched1.providerMetadata?.ollama as JSONObject | undefined) ?? {}),
          maxPromptEvalCount: promptCount,
          promptEvalCounts: [promptCount],
          evalCounts: [evalCount],
          attempts: 1,
          totalPromptEvalCount: promptCount,
          totalEvalCount: evalCount,
        },
      },
    };

    const isLfm3 = /^lfm3(?::|$)/i.test(this.modelId);
    // (`thinkEnabled` computed above before initial call)

    if (isLfm3 && thinkEnabled) {
      const { thinking, text, toolCallCount } = inspectContent(enriched1.content);
      if (hasUnparsedToolMarkup(thinking, text, toolCallCount)) {
        if (options.abortSignal?.aborted) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }

        const fallbackOptions = this.buildAdaptedOptions(
          {
            ...options,
            abortSignal: withCallTimeout(options.abortSignal, perCallMs)
          },
          false
        );
        const result2 = await this.underlyingModel.doGenerate(fallbackOptions);
        const enriched2: LanguageModelV4GenerateResult = {
          ...result2,
          content: sanitizeModelContent(result2.content),
          usage: enrichUsage(result2.usage, result2.response?.body),
        };

        const combinedUsage = combineUsage(enriched1.usage, enriched2.usage);
        const combinedRaw = combinedUsage.raw as Record<string, unknown>;

        return {
          ...enriched2,
          usage: combinedUsage,
          providerMetadata: {
            ...enriched2.providerMetadata,
            ollama: {
              ...((enriched2.providerMetadata?.ollama as JSONObject | undefined) ?? {}),
              maxPromptEvalCount: (combinedRaw.max_prompt_eval_count as JSONValue) ?? null,
              promptEvalCounts: (combinedRaw.prompt_eval_counts as JSONValue) ?? [],
              evalCounts: (combinedRaw.eval_counts as JSONValue) ?? [],
              attempts: 2,
              totalPromptEvalCount: (combinedRaw.prompt_eval_count as JSONValue) ?? null,
              totalEvalCount: (combinedRaw.eval_count as JSONValue) ?? null,
            },
          },
          warnings: [...(enriched1.warnings ?? []), ...(enriched2.warnings ?? [])],
        };
      }
    }

    return baseResult;
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    if (options.abortSignal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }

    const adaptedOptions = this.buildAdaptedOptions(options);
    return this.underlyingModel.doStream(adaptedOptions);
  }
}

export function createNativeOllamaModel(
  modelId: string,
  host: string,
  think = true,
  windowTokens?: number,
  fetch?: typeof globalThis.fetch,
  requestTimeoutMs?: number
): NativeOllamaLanguageModel {
  return new NativeOllamaLanguageModel(modelId, { host, think, windowTokens, requestTimeoutMs, fetch });
}
