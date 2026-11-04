import { describe, expect, test } from "bun:test";
import { createNativeOllamaModel, hasUnparsedToolMarkup, combineUsage, sanitizeModelContent, isTimeoutError } from "../bench/agentic/ollama-model.ts";
import { buildTurnTimeout } from "../bench/agentic/agent.ts";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";

function mockOllamaResponse(data: {
  model?: string;
  message: {
    role?: string;
    content: string;
    thinking?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
      id?: string;
    }>;
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}) {
  return new Response(
    JSON.stringify({
      model: data.model ?? "lfm3:256k",
      created_at: new Date().toISOString(),
      done: true,
      done_reason: data.done_reason ?? (data.message.tool_calls?.length ? "tool_calls" : "stop"),
      message: {
        role: data.message.role ?? "assistant",
        content: data.message.content,
        ...(data.message.thinking ? { thinking: data.message.thinking } : {}),
        ...(data.message.tool_calls ? { tool_calls: data.message.tool_calls } : {}),
      },
      prompt_eval_count: data.prompt_eval_count ?? 10,
      eval_count: data.eval_count ?? 5,
      total_duration: data.total_duration ?? 500,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

describe("Native Ollama LFM3 tool recovery", () => {
  test("detects unparsed tool markup only when no native action exists", () => {
    expect(hasUnparsedToolMarkup("thinking <tool_call></tool_call>", "", 0)).toBe(true);
    expect(hasUnparsedToolMarkup("thinking <tool_call></tool_call>", "text", 0)).toBe(false);
    expect(hasUnparsedToolMarkup("thinking <tool_call></tool_call>", "", 1)).toBe(false);
    expect(hasUnparsedToolMarkup("ordinary reasoning", "", 0)).toBe(false);
  });

  test("combines usage accurately across fallback attempts", () => {
    const u1: LanguageModelV4Usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 10, cacheWrite: 5 },
      outputTokens: { total: 50, text: 40, reasoning: 10 },
      raw: {
        prompt_eval_count: 100,
        eval_count: 50,
        total_duration: 1000,
        load_duration: 200,
      },
    };
    const u2: LanguageModelV4Usage = {
      inputTokens: { total: 120, noCache: 120, cacheRead: 20, cacheWrite: 10 },
      outputTokens: { total: 30, text: 30, reasoning: 0 },
      raw: {
        prompt_eval_count: 120,
        eval_count: 30,
        total_duration: 800,
        load_duration: 100,
      },
    };

    const combined = combineUsage(u1, u2);
    expect(combined.inputTokens.total).toBe(220);
    expect(combined.inputTokens.noCache).toBe(220);
    expect(combined.inputTokens.cacheRead).toBe(30);
    expect(combined.inputTokens.cacheWrite).toBe(15);
    expect(combined.outputTokens.total).toBe(80);
    expect(combined.outputTokens.text).toBe(70);
    expect(combined.outputTokens.reasoning).toBe(10);
    expect((combined.raw as Record<string, unknown>).prompt_eval_count).toBe(220);
    expect((combined.raw as Record<string, unknown>).eval_count).toBe(80);
    expect((combined.raw as Record<string, unknown>).max_prompt_eval_count).toBe(120);
    expect((combined.raw as Record<string, unknown>).prompt_eval_counts).toEqual([100, 120]);
    expect((combined.raw as Record<string, unknown>).eval_counts).toEqual([50, 30]);
    expect((combined.raw as Record<string, unknown>).attempts).toBe(2);
    expect((combined.raw as Record<string, unknown>).total_duration).toBe(1800);
    expect((combined.raw as Record<string, unknown>).load_duration).toBe(300);
  });

  test("maps standard maxOutputTokens, topK, windowTokens, and think to Ollama request options", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; body: Record<string, unknown> }[] = [];

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });
      return mockOllamaResponse({
        message: { content: "options received" },
      });
    }) as typeof fetch;

    try {
      const model = createNativeOllamaModel("lfm3:256k", "http://127.0.0.1:11434", true, 65536);
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        maxOutputTokens: 2048,
        topK: 50,
        temperature: 0.8,
        topP: 0.9,
        stopSequences: ["###"],
      } as never);

      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      expect(req.url).toContain("/api/chat");
      expect(req.body.model).toBe("lfm3:256k");
      expect(req.body.think).toBe(true);

      const options = req.body.options as Record<string, unknown> | undefined;
      expect(options).toBeDefined();
      expect(options?.num_predict).toBe(2048);
      expect(options?.top_k).toBe(50);
      expect(options?.num_ctx).toBe(65536);
      expect(options?.temperature).toBe(0.8);
      expect(options?.top_p).toBe(0.9);
      expect(options?.stop).toEqual(["###"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves native LFM3 reasoning in generated content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return mockOllamaResponse({
        message: {
          content: "The final answer is 42.",
          thinking: "Thinking step by step through mathematics.",
        },
        prompt_eval_count: 15,
        eval_count: 20,
      });
    }) as unknown as typeof fetch;

    try {
      const model = createNativeOllamaModel("lfm3:256k", "http://127.0.0.1:11434", true);
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "What is 6 * 7?" }] }],
      } as never);

      expect(result.content).toContainEqual({
        type: "reasoning",
        text: "Thinking step by step through mathematics.",
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: "The final answer is 42.",
      });
      expect(result.usage.inputTokens.total).toBe(15);
      expect(result.usage.outputTokens.total).toBe(20);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries malformed LFM3 thinking with native thinking disabled and preserves cumulative usage", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);

      if (requests.length === 1) {
        return mockOllamaResponse({
          message: {
            content: "",
            thinking: "I should act now. <tool_call><function=write_file><parameter=path>game.js</parameter></function></tool_call>",
            tool_calls: [],
          },
          done_reason: "stop",
          prompt_eval_count: 100,
          eval_count: 40,
          total_duration: 1200,
        });
      }

      return mockOllamaResponse({
        message: {
          content: "",
          tool_calls: [{ function: { name: "write_file", arguments: { path: "game.js", content: "ok" } }, id: "call_1" }],
        },
        done_reason: "tool_calls",
        prompt_eval_count: 110,
        eval_count: 20,
        total_duration: 900,
      });
    }) as typeof fetch;

    try {
      const model = createNativeOllamaModel("lfm3:256k", "http://127.0.0.1:11434", true);
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Call write_file." }] }],
        tools: [{ type: "function", name: "write_file", description: "Write a file", inputSchema: { type: "object" } }],
        reasoning: "auto",
      } as never);

      expect(requests).toHaveLength(2);
      expect(requests[0]!.think).toBe(true);
      expect(requests[1]!.think).toBe(false);

      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "tool-call", toolName: "write_file" })
      );

      // Verify cumulative usage preserves all tokens from both attempts
      expect(result.usage.inputTokens.total).toBe(210); // 100 + 110
      expect(result.usage.outputTokens.total).toBe(60);  // 40 + 20
      expect((result.usage.raw as Record<string, unknown>).prompt_eval_count).toBe(210);
      expect((result.usage.raw as Record<string, unknown>).eval_count).toBe(60);
      expect((result.usage.raw as Record<string, unknown>).max_prompt_eval_count).toBe(110);
      expect((result.usage.raw as Record<string, unknown>).prompt_eval_counts).toEqual([100, 110]);
      expect((result.usage.raw as Record<string, unknown>).eval_counts).toEqual([40, 20]);
      expect((result.usage.raw as Record<string, unknown>).attempts).toBe(2);
      expect((result.usage.raw as Record<string, unknown>).total_duration).toBe(2100); // 1200 + 900

      // Verify providerMetadata exposes maxPromptEvalCount for context & cache accounting
      const ollamaMeta = (result.providerMetadata as Record<string, unknown> | undefined)?.ollama as Record<string, unknown> | undefined;
      expect(ollamaMeta).toBeDefined();
      expect(ollamaMeta?.maxPromptEvalCount).toBe(110);
      expect(ollamaMeta?.promptEvalCounts).toEqual([100, 110]);
      expect(ollamaMeta?.evalCounts).toEqual([40, 20]);
      expect(ollamaMeta?.attempts).toBe(2);
      expect(ollamaMeta?.totalPromptEvalCount).toBe(210);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not trigger fallback for non-LFM3 models even with XML markup in thinking", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      return mockOllamaResponse({
        model: "gemma4:latest",
        message: {
          content: "",
          thinking: "Markup like <tool_call></tool_call> in non-LFM3 model.",
        },
      });
    }) as typeof fetch;

    try {
      const model = createNativeOllamaModel("gemma4:latest", "http://127.0.0.1:11434", true);
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
      } as never);

      // Should only call once, no fallback retry
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("correctly parses native tool calls and finish reason", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return mockOllamaResponse({
        message: {
          content: "",
          tool_calls: [
            {
              function: { name: "search", arguments: { query: "origami context folding" } },
              id: "call_search_1",
            },
          ],
        },
        done_reason: "tool_calls",
      });
    }) as unknown as typeof fetch;

    try {
      const model = createNativeOllamaModel("lfm3:256k", "http://127.0.0.1:11434", true);
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Search origami" }] }],
        tools: [{ type: "function", name: "search", description: "Search docs", inputSchema: { type: "object" } }],
      } as never);

      expect(result.finishReason.unified).toBe("tool-calls");
      const toolCall = result.content.find((p) => p.type === "tool-call");
      expect(toolCall).toBeDefined();
      if (toolCall && toolCall.type === "tool-call") {
        expect(toolCall.toolName).toBe("search");
        expect(JSON.parse(toolCall.input)).toEqual({ query: "origami context folding" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects abort signal and aborts immediately without retrying", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return mockOllamaResponse({ message: { content: "ok" } });
    }) as unknown as typeof fetch;

    try {
      const model = createNativeOllamaModel("lfm3:256k", "http://127.0.0.1:11434", true);
      const controller = new AbortController();
      controller.abort();

      let caught = false;
      try {
        await model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
          abortSignal: controller.signal,
        } as never);
      } catch (err: unknown) {
        caught = true;
        if (err instanceof Error) {
          expect(err.name === "AbortError" || /abort/i.test(err.message)).toBe(true);
        } else {
          expect(String(err)).toMatch(/abort/i);
        }
      }
      expect(caught).toBe(true);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sanitizeModelContent strips leaked Gemma 4 <channel|> and <|thought|> delimiters cleanly", () => {
    const leakedTrailing = sanitizeModelContent([
      {
        type: "text",
        text: "Implemented src/matrix.ts.<channel|>All directives have been addressed."
      }
    ]);
    expect(leakedTrailing).toEqual([
      {
        type: "text",
        text: "Implemented src/matrix.ts."
      }
    ]);

    const leakedThought = sanitizeModelContent([
      {
        type: "text",
        text: "<|thought|>Plan: inspect README first.<channel|>Updated configuration schema."
      }
    ]);
    expect(leakedThought).toEqual([
      { type: "reasoning", text: "Plan: inspect README first." },
      { type: "text", text: "Updated configuration schema." }
    ]);

    const leakedBeforeToolCall = sanitizeModelContent([
      { type: "text", text: "I should grep for the header first.<channel|>" },
      { type: "tool-call", toolCallId: "c1", toolName: "grep", input: "{}" }
    ]);
    expect(leakedBeforeToolCall).toEqual([
      { type: "reasoning", text: "I should grep for the header first." },
      { type: "tool-call", toolCallId: "c1", toolName: "grep", input: "{}" }
    ]);
  });

  test("recovers from Bun DOMException TimeoutError on thinking step by retrying with think: false", async () => {
    const domTimeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(isTimeoutError(domTimeout)).toBe(true);
    expect(buildTurnTimeout()).toEqual({ stepMs: 600_000, totalMs: 3_600_000 });

    const requestBodies: Array<Record<string, unknown>> = [];
    let callIdx = 0;
    const mockFetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      callIdx++;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (callIdx === 1) {
        throw domTimeout;
      }
      return mockOllamaResponse({
        model: "gemma4:latest",
        message: { content: "Recovered cleanly with think: false" },
        prompt_eval_count: 1024,
        eval_count: 24
      });
    }) as unknown as typeof fetch;

    const model = createNativeOllamaModel("gemma4:latest", "http://127.0.0.1:11434", true, 131_072, mockFetch, 5_000);
    const res = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Implement module" }] }]
    } as never);

    expect(callIdx).toBe(2);
    expect(requestBodies[0]?.think).toBe(true);
    expect(requestBodies[1]?.think).toBe(false);
    expect(res.content).toEqual([{ type: "text", text: "Recovered cleanly with think: false" }]);
  });
});
