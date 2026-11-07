import { describe, expect, it } from "bun:test";
import {
  getBenchmarkTokenizer,
  createFallbackTokenizer,
  createSyntheticTokenizer,
  resolveModelFamily,
  normalizeModelName,
  getDefaultTokenizer,
  type BenchmarkTokenizer
} from "../bench/agentic/tokenizer.ts";
import { countLlmMessageTokens, cacheAccounting, createLlmCacheState, type LlmMessage } from "../bench/agentic/llm.ts";
import { createCompactionRuntime } from "../bench/agentic/strategy-runtime.ts";

/** Minimal WordPiece tokenizer schema for deterministic offline testing. */
const SYNTHETIC_TOKENIZER_SPEC = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [],
  normalizer: { type: "Sequence", normalizers: [] },
  pre_tokenizer: { type: "Whitespace" },
  post_processor: null,
  decoder: null,
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: {
      "[UNK]": 0,
      "hello": 1,
      "world": 2,
      "function": 3,
      "test": 4,
      "software": 5,
      "engineer": 6,
      "build": 7,
      "frontend": 8,
      "backend": 9,
      "ponder": 10,
      "deeply": 11,
      "edit_file": 12,
      "read_file": 13,
      "path": 14
    }
  }
};

describe("Agentic Benchmark Tokenizer", () => {
  describe("Model Resolution and Ollama Alias Normalization", () => {
    it("resolves and normalizes gemma4 model identifiers and ollama/ aliases", () => {
      expect(resolveModelFamily("gemma4")).toBe("gemma4");
      expect(resolveModelFamily("gemma4:latest")).toBe("gemma4");
      expect(resolveModelFamily("gemma4:12b")).toBe("gemma4");
      expect(resolveModelFamily("gemma4:26b-a4b-it-qat")).toBe("gemma4");
      expect(resolveModelFamily("ollama/gemma4:latest")).toBe("gemma4");
      expect(resolveModelFamily("ollama/gemma4:12b")).toBe("gemma4");
      expect(normalizeModelName("ollama/gemma4:latest")).toBe("gemma4:latest");
    });

    it("resolves and normalizes lfm3 model identifiers and ollama/ aliases", () => {
      expect(resolveModelFamily("lfm3")).toBe("lfm3");
      expect(resolveModelFamily("lfm3:latest")).toBe("lfm3");
      expect(resolveModelFamily("lfm3:256k")).toBe("lfm3");
      expect(resolveModelFamily("lfm3:nothink")).toBe("lfm3");
      expect(resolveModelFamily("ollama/lfm3:latest")).toBe("lfm3");
      expect(resolveModelFamily("ollama/lfm3:256k")).toBe("lfm3");
      expect(normalizeModelName("ollama/lfm3:256k")).toBe("lfm3:256k");
    });

    it("resolves and normalizes deepseek model identifiers and deepinfra/ aliases", () => {
      expect(resolveModelFamily("deepseek")).toBe("deepseek");
      expect(resolveModelFamily("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("deepseek");
      expect(resolveModelFamily("deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("deepseek");
      expect(resolveModelFamily("deepinfra:DeepSeek-V4.1-Flash-1017")).toBe("deepseek");
      expect(normalizeModelName("deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("deepseek-ai/deepseek-v4.1-flash-1017");
      expect(normalizeModelName("deepinfra:DeepSeek-V4.1-Flash-1017")).toBe("deepseek-v4.1-flash-1017");
    });

    it("resolves unsupported models to fallback", () => {
      expect(resolveModelFamily("gpt-4o")).toBe("fallback");
      expect(resolveModelFamily("claude-3-5-sonnet")).toBe("fallback");
      expect(resolveModelFamily("qwen2.5:7b")).toBe("fallback");
      expect(resolveModelFamily("ollama/qwen2.5:7b")).toBe("fallback");
    });
  });

  describe("Failure and Fallback Semantics", () => {
    it("fails clearly when a live supported model has missing assets in offline mode (no silent downgrade)", async () => {
      const offlineNonExistentDir = "/nonexistent-tokenizer-cache-path-" + Date.now();
      expect(
        getBenchmarkTokenizer("gemma4:latest", { offline: true, assetDir: offlineNonExistentDir })
      ).rejects.toThrow("Failed to load pinned HuggingFace tokenizer for gemma4");

      expect(
        getBenchmarkTokenizer("lfm3:latest", { offline: true, assetDir: offlineNonExistentDir })
      ).rejects.toThrow("Failed to load pinned HuggingFace tokenizer for lfm3");

      expect(
        getBenchmarkTokenizer("deepinfra:DeepSeek-V4.1-Flash-1017", { offline: true, assetDir: offlineNonExistentDir })
      ).rejects.toThrow("Failed to load pinned HuggingFace tokenizer for deepseek");
    });

    it("falls back gracefully in mock mode when assets are not available", async () => {
      const offlineNonExistentDir = "/nonexistent-tokenizer-cache-path-" + Date.now();
      const tokenizer = await getBenchmarkTokenizer("gemma4:latest", { mock: true, assetDir: offlineNonExistentDir });
      expect(tokenizer.family).toBe("fallback");
      expect(tokenizer.isFallback).toBe(true);
      expect(tokenizer.fallbackReason).toContain("Mock mode fallback");
      expect(typeof tokenizer.countText("hello world")).toBe("number");
    });

    it("returns explicit fallback tokenizer for unsupported models with clear reason", async () => {
      const tokenizer = await getBenchmarkTokenizer("custom-local-model");
      expect(tokenizer.family).toBe("fallback");
      expect(tokenizer.isFallback).toBe(true);
      expect(tokenizer.fallbackReason).toContain("custom-local-model");
      expect(tokenizer.assetSource).toBe("fallback");
    });
  });

  describe("Deterministic Token Counting & Model Policy", () => {
    it("accurately encodes vocabulary tokens using genuine HF Tokenizer", () => {
      const tokenizer = createSyntheticTokenizer("test-model", "fallback", SYNTHETIC_TOKENIZER_SPEC);
      expect(tokenizer.countText("hello")).toBe(1);
      expect(tokenizer.countText("hello world")).toBe(2);
      expect(tokenizer.countText("")).toBe(0);
    });

    it("enforces native thinking policy: LFM3 includes reasoning, Gemma4 excludes prior reasoning", () => {
      const lfm = createSyntheticTokenizer("lfm3:latest", "lfm3", SYNTHETIC_TOKENIZER_SPEC);
      const gemma = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);

      const messageWithReasoning: LlmMessage = {
        role: "assistant",
        content: "hello world",
        reasoning: "ponder deeply"
      };

      const lfmCount = lfm.countMessage(messageWithReasoning);
      const gemmaCount = gemma.countMessage(messageWithReasoning);

      const messageWithoutReasoning: LlmMessage = {
        role: "assistant",
        content: "hello world"
      };

      const lfmCountNoReasoning = lfm.countMessage(messageWithoutReasoning);
      const gemmaCountNoReasoning = gemma.countMessage(messageWithoutReasoning);

      // LFM3 includes reasoning tokens + reasoning delimiter overhead
      expect(lfmCount).toBeGreaterThan(lfmCountNoReasoning);
      // Gemma4 excludes prior reasoning by policy
      expect(gemmaCount).toBe(gemmaCountNoReasoning);

      // If explicitly forced, Gemma includes it
      const gemmaForced = gemma.countMessage(messageWithReasoning, { includeReasoning: true });
      expect(gemmaForced).toBeGreaterThan(gemmaCountNoReasoning);
    });

    it("models assistant tool calls and framing overhead", () => {
      const tokenizer = createSyntheticTokenizer("lfm3:latest", "lfm3", SYNTHETIC_TOKENIZER_SPEC);

      const plainAssistant: LlmMessage = {
        role: "assistant",
        content: "hello world"
      };

      const assistantWithTool: LlmMessage = {
        role: "assistant",
        content: "hello world",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "edit_file",
            arguments: JSON.stringify({ path: "test" })
          }
        }]
      };

      const plainTokens = tokenizer.countMessage(plainAssistant);
      const toolTokens = tokenizer.countMessage(assistantWithTool);
      expect(toolTokens).toBeGreaterThan(plainTokens + 4);
    });

    it("models tool result metadata framing overhead", () => {
      const tokenizer = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);

      const toolMsg: LlmMessage = {
        role: "tool",
        name: "read_file",
        tool_call_id: "call-99",
        content: "test"
      };

      const count = tokenizer.countMessage(toolMsg);
      expect(count).toBeGreaterThan(tokenizer.countText(toolMsg.content));
    });

    it("includes sequence header (BOS) token in messages collection", () => {
      const tokenizer = createSyntheticTokenizer("lfm3:latest", "lfm3", SYNTHETIC_TOKENIZER_SPEC);
      const messages: LlmMessage[] = [
        { role: "system", content: "software engineer" },
        { role: "user", content: "hello world" }
      ];

      const sumIndividual = tokenizer.countMessage(messages[0]!) + tokenizer.countMessage(messages[1]!);
      const total = tokenizer.countMessages(messages);
      // Total includes 1 BOS token
      expect(total).toBe(sumIndividual + 1);
    });
  });

  describe("Message Caching & Memory Footprint", () => {
    it("caches unchanged message token counts and records cache hit in telemetry", () => {
      const tokenizer = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);
      const msg: LlmMessage = { role: "user", content: "hello world" };

      const count1 = tokenizer.countMessage(msg);
      expect(tokenizer.telemetry().cacheHits).toBe(0);
      expect(tokenizer.telemetry().cacheMisses).toBe(1);

      const count2 = tokenizer.countMessage(msg);
      expect(count2).toBe(count1);
      expect(tokenizer.telemetry().cacheHits).toBe(1);
      expect(tokenizer.telemetry().cacheMisses).toBe(1);
    });

    it("hashes large message content to avoid storing duplicate large strings as map keys", () => {
      const tokenizer = createSyntheticTokenizer("lfm3:latest", "lfm3", SYNTHETIC_TOKENIZER_SPEC);
      const largeContent = "hello world ".repeat(200); // > 64 chars

      const msg: LlmMessage = { role: "user", content: largeContent };
      const count1 = tokenizer.countMessage(msg);
      const count2 = tokenizer.countMessage(msg);

      expect(count1).toBe(count2);
      expect(tokenizer.telemetry().cacheHits).toBe(1);
    });
  });

  describe("Parallel Isolation (No Global State Mutation)", () => {
    it("ensures independent tokenizer instances maintain isolated caches and telemetry", () => {
      const tok1 = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);
      const tok2 = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);

      const msg: LlmMessage = { role: "user", content: "test" };

      tok1.countMessage(msg);
      tok1.countMessage(msg);

      expect(tok1.telemetry().cacheHits).toBe(1);
      expect(tok2.telemetry().cacheHits).toBe(0);
      expect(tok2.telemetry().cacheMisses).toBe(0);
    });
  });

  describe("Strategy Runtime & llm.ts Integration", () => {
    it("passes run-specific tokenizer into SoftCompactionRuntime", () => {
      const tokenizer = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);
      const runtime = createCompactionRuntime("soft", {
        windowTokens: 10_000,
        tokenizer
      });

      const messages: LlmMessage[] = [
        { role: "system", content: "software engineer" },
        { role: "user", content: "hello world" }
      ];

      const outbound = runtime.prepareOutbound(messages, 10_000);
      expect(outbound.length).toBe(2);
    });

    it("passes run-specific tokenizer into OrigamiRuntime countFn", () => {
      const tokenizer = createSyntheticTokenizer("lfm3:latest", "lfm3", SYNTHETIC_TOKENIZER_SPEC);
      const runtime = createCompactionRuntime("origami", {
        windowTokens: 50_000,
        tokenizer
      });

      expect(runtime.strategy).toBe("origami");
      const messages: LlmMessage[] = [
        { role: "system", content: "software engineer" },
        { role: "user", content: "build backend" }
      ];

      const outbound = runtime.prepareOutbound(messages, 50_000);
      expect(outbound.length).toBeGreaterThan(0);
    });

    it("cacheAccounting respects model-specific tokenizer for prefix caching", () => {
      const tokenizer = createSyntheticTokenizer("gemma4:latest", "gemma4", SYNTHETIC_TOKENIZER_SPEC);
      const cacheState = createLlmCacheState();

      const turn1Messages: LlmMessage[] = [
        { role: "system", content: "software engineer ".repeat(400) },
        { role: "user", content: "hello world ".repeat(400) }
      ];

      const promptTokens1 = 2000;
      const res1 = cacheAccounting(turn1Messages, promptTokens1, cacheState, tokenizer);
      expect(res1.cachedTokens).toBe(0);
      expect(res1.cacheWriteTokens).toBe(promptTokens1);

      const turn2Messages: LlmMessage[] = [
        ...turn1Messages,
        { role: "assistant", content: "test" },
        { role: "user", content: "build frontend" }
      ];

      const promptTokens2 = 3000;
      const res2 = cacheAccounting(turn2Messages, promptTokens2, cacheState, tokenizer);
      expect(res2.cachedTokens).toBeGreaterThan(0);
      expect(res2.cacheWriteTokens).toBe(promptTokens2 - res2.cachedTokens);
    });

    it("preserves backward compatibility when countLlmMessageTokens is called without tokenizer", () => {
      const msg: LlmMessage = { role: "user", content: "hello world" };
      const count = countLlmMessageTokens(msg);
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe("number");
    });
  });
});
