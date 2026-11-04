/**
 * Model-specific HuggingFace tokenizer accounting for agentic benchmark.
 *
 * Replaces chars/4 with HF tokenizers using cached pinned tokenizer assets
 * for gemma4 and lfm3, with explicit visible fallback for unsupported models
 * and mock/offline runs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import type { LlmMessage } from "./llm.ts";

export type ModelFamily = "gemma4" | "lfm3" | "fallback";

export interface TokenizerTelemetry {
  model: string;
  family: ModelFamily;
  isFallback: boolean;
  fallbackReason?: string;
  assetSource: "pinned-disk" | "downloaded" | "fallback";
  cacheHits: number;
  cacheMisses: number;
  totalMessagesCounted: number;
  totalTokensCounted: number;
}

export interface BenchmarkTokenizer {
  readonly model: string;
  readonly family: ModelFamily;
  readonly isFallback: boolean;
  readonly fallbackReason?: string;
  readonly assetSource: "pinned-disk" | "downloaded" | "fallback";

  countText(text: string): number;
  countMessage(message: LlmMessage, options?: { includeReasoning?: boolean }): number;
  countMessages(messages: readonly LlmMessage[], options?: { includeReasoning?: boolean }): number;
  telemetry(): TokenizerTelemetry;
  clearCache(): void;
}

export interface TokenizerInitOptions {
  mock?: boolean;
  offline?: boolean;
  assetDir?: string;
}

interface PinnedModelAsset {
  family: ModelFamily;
  hfRepo: string;
  revision: string;
  configUrl: string;
  tokenizerUrl: string;
  subDir: string;
}

const PINNED_ASSETS: Record<"gemma4" | "lfm3", PinnedModelAsset> = {
  gemma4: {
    family: "gemma4",
    hfRepo: "google/gemma-4-E4B-it",
    revision: "ee0ef6023621cff504d758262d4e04895a5af4a2",
    configUrl: "https://huggingface.co/google/gemma-4-E4B-it/raw/ee0ef6023621cff504d758262d4e04895a5af4a2/tokenizer_config.json",
    tokenizerUrl: "https://huggingface.co/google/gemma-4-E4B-it/resolve/ee0ef6023621cff504d758262d4e04895a5af4a2/tokenizer.json",
    subDir: "gemma4-ee0ef6023621cff504d758262d4e04895a5af4a2"
  },
  lfm3: {
    family: "lfm3",
    hfRepo: "LiquidAI/LFM3-1.7B",
    revision: "ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7",
    configUrl: "https://huggingface.co/LiquidAI/LFM3-1.7B/raw/ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7/tokenizer_config.json",
    tokenizerUrl: "https://huggingface.co/LiquidAI/LFM3-1.7B/resolve/ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7/tokenizer.json",
    subDir: "lfm3-ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7"
  }
};

/** Overhead tokens per message for role delimiters and turn markers. */
const PER_MESSAGE_FRAMING_TOKENS = 3;
/** Conversation sequence header tokens (BOS). */
const BOS_TOKENS = 1;
/** Overhead tokens per tool call (wrapper tags and separation). */
const PER_TOOL_CALL_FRAMING_TOKENS = 4;
/** Overhead tokens per tool result metadata (tool_call_id + name framing). */
const TOOL_RESULT_METADATA_FRAMING_TOKENS = 3;
/** Delimiter tokens around native reasoning block. */
const REASONING_FRAMING_TOKENS = 2;

/** Maximum cached message count per tokenizer instance to bound memory footprint. */
const MAX_MESSAGE_CACHE_SIZE = 5_000;

export function normalizeModelName(modelId: string): string {
  return modelId.trim().replace(/^ollama\//i, "").toLowerCase();
}

export function resolveModelFamily(modelId: string): ModelFamily {
  const normalized = normalizeModelName(modelId);
  if (/^gemma4(?::|$)/i.test(normalized)) return "gemma4";
  if (/^lfm3(?::|$)/i.test(normalized)) return "lfm3";
  return "fallback";
}

function getDefaultAssetDir(): string {
  if (process.env.ORIGAMI_TOKENIZER_CACHE_DIR) {
    return resolve(process.env.ORIGAMI_TOKENIZER_CACHE_DIR);
  }
  return resolve(homedir(), ".cache", "origami", "tokenizers");
}

function hashContent(text: string): string {
  if (!text) return "";
  if (text.length <= 64) return text;
  return `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function computeMessageFingerprint(message: LlmMessage, includeReasoning: boolean): string {
  const parts: string[] = [
    message.role,
    message.name ?? "",
    message.tool_call_id ?? "",
    includeReasoning && message.reasoning ? hashContent(message.reasoning) : ""
  ];
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      parts.push(call.id, call.function.name, hashContent(call.function.arguments));
    }
  }
  parts.push(hashContent(message.content));
  return parts.join("\x1f");
}

class HfBenchmarkTokenizer implements BenchmarkTokenizer {
  readonly model: string;
  readonly family: ModelFamily;
  readonly isFallback = false;
  readonly fallbackReason = undefined;
  readonly assetSource: "pinned-disk" | "downloaded";

  private readonly hfTokenizer: Tokenizer;
  private readonly messageCache = new Map<string, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalMessagesCounted = 0;
  private totalTokensCounted = 0;

  constructor(
    model: string,
    family: ModelFamily,
    hfTokenizer: Tokenizer,
    assetSource: "pinned-disk" | "downloaded"
  ) {
    this.model = model;
    this.family = family;
    this.hfTokenizer = hfTokenizer;
    this.assetSource = assetSource;
  }

  countText(text: string): number {
    if (!text) return 0;
    const encoded = this.hfTokenizer.encode(text);
    return encoded.ids.length;
  }

  countMessage(message: LlmMessage, options?: { includeReasoning?: boolean }): number {
    // Model-specific native thinking policy:
    // LFM3 includes native reasoning in context accounting.
    // Gemma4 excludes prior reasoning from context history by policy.
    const shouldIncludeReasoning = options?.includeReasoning ?? (this.family === "lfm3");
    const fingerprint = computeMessageFingerprint(message, shouldIncludeReasoning);

    const cached = this.messageCache.get(fingerprint);
    if (cached !== undefined) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;
    this.totalMessagesCounted++;

    let tokens = PER_MESSAGE_FRAMING_TOKENS;

    if (message.content) {
      tokens += this.countText(message.content);
    }

    if (shouldIncludeReasoning && message.reasoning) {
      tokens += this.countText(message.reasoning) + REASONING_FRAMING_TOKENS;
    }

    if (message.role === "tool") {
      const meta = [message.name, message.tool_call_id].filter(Boolean).join(" ");
      if (meta) {
        tokens += this.countText(meta) + TOOL_RESULT_METADATA_FRAMING_TOKENS;
      }
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        tokens += PER_TOOL_CALL_FRAMING_TOKENS;
        if (call.function.name) tokens += this.countText(call.function.name);
        if (call.function.arguments) tokens += this.countText(call.function.arguments);
      }
    }

    if (this.messageCache.size >= MAX_MESSAGE_CACHE_SIZE) {
      // Evict oldest entries to prevent unbounded memory growth
      const keys = Array.from(this.messageCache.keys()).slice(0, MAX_MESSAGE_CACHE_SIZE / 2);
      for (const k of keys) this.messageCache.delete(k);
    }

    this.messageCache.set(fingerprint, tokens);
    this.totalTokensCounted += tokens;
    return tokens;
  }

  countMessages(messages: readonly LlmMessage[], options?: { includeReasoning?: boolean }): number {
    if (messages.length === 0) return 0;
    let sum = BOS_TOKENS;
    for (const msg of messages) {
      sum += this.countMessage(msg, options);
    }
    return sum;
  }

  telemetry(): TokenizerTelemetry {
    return {
      model: this.model,
      family: this.family,
      isFallback: this.isFallback,
      fallbackReason: this.fallbackReason,
      assetSource: this.assetSource,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      totalMessagesCounted: this.totalMessagesCounted,
      totalTokensCounted: this.totalTokensCounted
    };
  }

  clearCache(): void {
    this.messageCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

class FallbackBenchmarkTokenizer implements BenchmarkTokenizer {
  readonly model: string;
  readonly family: ModelFamily;
  readonly isFallback = true;
  readonly fallbackReason: string;
  readonly assetSource = "fallback" as const;

  private readonly messageCache = new Map<string, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalMessagesCounted = 0;
  private totalTokensCounted = 0;

  constructor(model: string, reason = "Model not configured for HF tokenization") {
    this.model = model;
    this.family = "fallback";
    this.fallbackReason = reason;
  }

  countText(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  countMessage(message: LlmMessage, options?: { includeReasoning?: boolean }): number {
    const shouldIncludeReasoning = options?.includeReasoning ?? true;
    const fingerprint = computeMessageFingerprint(message, shouldIncludeReasoning);

    const cached = this.messageCache.get(fingerprint);
    if (cached !== undefined) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;
    this.totalMessagesCounted++;

    let tokens = PER_MESSAGE_FRAMING_TOKENS;

    if (message.content) {
      tokens += this.countText(message.content);
    }

    if (shouldIncludeReasoning && message.reasoning) {
      tokens += this.countText(message.reasoning) + REASONING_FRAMING_TOKENS;
    }

    if (message.role === "tool") {
      const meta = [message.name, message.tool_call_id].filter(Boolean).join(" ");
      if (meta) {
        tokens += this.countText(meta) + TOOL_RESULT_METADATA_FRAMING_TOKENS;
      }
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        tokens += PER_TOOL_CALL_FRAMING_TOKENS;
        if (call.function.name) tokens += this.countText(call.function.name);
        if (call.function.arguments) tokens += this.countText(call.function.arguments);
      }
    }

    if (this.messageCache.size >= MAX_MESSAGE_CACHE_SIZE) {
      const keys = Array.from(this.messageCache.keys()).slice(0, MAX_MESSAGE_CACHE_SIZE / 2);
      for (const k of keys) this.messageCache.delete(k);
    }

    this.messageCache.set(fingerprint, tokens);
    this.totalTokensCounted += tokens;
    return tokens;
  }

  countMessages(messages: readonly LlmMessage[], options?: { includeReasoning?: boolean }): number {
    if (messages.length === 0) return 0;
    let sum = BOS_TOKENS;
    for (const msg of messages) {
      sum += this.countMessage(msg, options);
    }
    return sum;
  }

  telemetry(): TokenizerTelemetry {
    return {
      model: this.model,
      family: this.family,
      isFallback: this.isFallback,
      fallbackReason: this.fallbackReason,
      assetSource: this.assetSource,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      totalMessagesCounted: this.totalMessagesCounted,
      totalTokensCounted: this.totalTokensCounted
    };
  }

  clearCache(): void {
    this.messageCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

/** Pre-parsed Tokenizer instances cached in memory across parallel runs. */
const loadedHfTokenizers = new Map<string, { tokenizer: Tokenizer; assetSource: "pinned-disk" | "downloaded" }>();

/** In-flight load promises to deduplicate concurrent loads/downloads. */
const inFlightLoads = new Map<string, Promise<{ tokenizer: Tokenizer; assetSource: "pinned-disk" | "downloaded" }>>();

async function ensureModelAssets(
  asset: PinnedModelAsset,
  baseDir: string,
  options?: TokenizerInitOptions
): Promise<{ configJson: Record<string, unknown>; tokenizerJson: Record<string, unknown>; source: "pinned-disk" | "downloaded" }> {
  const modelDir = join(baseDir, asset.subDir);
  const configPath = join(modelDir, "tokenizer_config.json");
  const tokenizerPath = join(modelDir, "tokenizer.json");

  const diskExists = existsSync(configPath) && existsSync(tokenizerPath);
  if (diskExists) {
    const configJson = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const tokenizerJson = JSON.parse(readFileSync(tokenizerPath, "utf-8")) as Record<string, unknown>;
    return { configJson, tokenizerJson, source: "pinned-disk" };
  }

  if (options?.offline) {
    throw new Error(`Offline mode: pinned tokenizer assets not found at ${modelDir}`);
  }

  if (options?.mock) {
    throw new Error(`Mock mode: pinned tokenizer assets not found at ${modelDir}`);
  }

  mkdirSync(modelDir, { recursive: true });

  const [cfgRes, tokRes] = await Promise.all([
    fetch(asset.configUrl),
    fetch(asset.tokenizerUrl)
  ]);

  if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status} downloading ${asset.configUrl}`);
  if (!tokRes.ok) throw new Error(`HTTP ${tokRes.status} downloading ${asset.tokenizerUrl}`);

  const configText = await cfgRes.text();
  const tokenizerText = await tokRes.text();

  writeFileSync(configPath, configText, "utf-8");
  writeFileSync(tokenizerPath, tokenizerText, "utf-8");

  return {
    configJson: JSON.parse(configText) as Record<string, unknown>,
    tokenizerJson: JSON.parse(tokenizerText) as Record<string, unknown>,
    source: "downloaded"
  };
}

async function loadHfEngine(
  family: "gemma4" | "lfm3",
  baseDir: string,
  options?: TokenizerInitOptions
): Promise<{ tokenizer: Tokenizer; assetSource: "pinned-disk" | "downloaded" }> {
  const asset = PINNED_ASSETS[family];
  const cacheKey = `${family}:${asset.subDir}:${baseDir}`;

  const existing = loadedHfTokenizers.get(cacheKey);
  if (existing) return existing;

  const inFlight = inFlightLoads.get(cacheKey);
  if (inFlight) return inFlight;

  const loadPromise = (async () => {
    try {
      const { configJson, tokenizerJson, source } = await ensureModelAssets(asset, baseDir, options);
      const hfInstance = new Tokenizer(tokenizerJson, configJson);
      const entry = { tokenizer: hfInstance, assetSource: source };
      loadedHfTokenizers.set(cacheKey, entry);
      return entry;
    } finally {
      inFlightLoads.delete(cacheKey);
    }
  })();

  inFlightLoads.set(cacheKey, loadPromise);
  return loadPromise;
}

/**
 * Creates or retrieves a model-specific tokenizer for the benchmark.
 * Returns an isolated instance with its own message cache and telemetry counters,
 * safe for concurrent parallel runs.
 */
export async function getBenchmarkTokenizer(
  model: string,
  options?: TokenizerInitOptions
): Promise<BenchmarkTokenizer> {
  const family = resolveModelFamily(model);
  if (family === "fallback") {
    return new FallbackBenchmarkTokenizer(
      model,
      `Model '${model}' not supported for HF tokenization (using chars/4 fallback)`
    );
  }

  const baseDir = options?.assetDir ?? getDefaultAssetDir();

  try {
    const engine = await loadHfEngine(family, baseDir, options);
    return new HfBenchmarkTokenizer(model, family, engine.tokenizer, engine.assetSource);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options?.mock) {
      return new FallbackBenchmarkTokenizer(model, `Mock mode fallback: ${message}`);
    }
    // Live supported model failures must fail clearly without silently falling back
    throw new Error(`Failed to load pinned HuggingFace tokenizer for ${family} (${model}): ${message}`);
  }
}

/** Synchronous fallback factory when async init is not available or model is unsupported. */
export function createFallbackTokenizer(model: string, reason?: string): BenchmarkTokenizer {
  return new FallbackBenchmarkTokenizer(model, reason);
}

/** Creates a synthetic tokenizer for unit testing without downloading 50MB files. */
export function createSyntheticTokenizer(
  model: string,
  family: ModelFamily,
  tokenizerJson: Record<string, unknown>,
  configJson: Record<string, unknown> = {}
): BenchmarkTokenizer {
  const hf = new Tokenizer(tokenizerJson, configJson);
  return new HfBenchmarkTokenizer(model, family, hf, "pinned-disk");
}

/** Default singleton fallback instance for legacy sync call sites. */
const DEFAULT_FALLBACK_TOKENIZER = new FallbackBenchmarkTokenizer("default-fallback");

export function getDefaultTokenizer(): BenchmarkTokenizer {
  return DEFAULT_FALLBACK_TOKENIZER;
}
