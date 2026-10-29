/**
 * Egress-guarded LLM client for the agentic benchmark.
 *
 * Sandbox tools never touch the network. The *only* outbound request a benchmark
 * run can make is a chat completion, and even that is pinned to an allowlist of
 * hosts (OpenRouter by default, or the operator's configured LLM endpoint).
 * Any other origin throws before the request is built.
 */

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

export interface LlmCompletion {
  content: string;
  toolCalls: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  latencyMs: number;
  resolvedModel: string;
  stopReason: "stop" | "tool_calls" | "length" | "error";
  error?: string;
}

export const DEFAULT_LLM_HOSTS = ["openrouter.ai"];

/** Resolve the permitted hosts: defaults plus the configured endpoint's host. */
export function allowedLlmHosts(): Set<string> {
  const hosts = new Set(DEFAULT_LLM_HOSTS);
  for (const key of ["OPENROUTER_BASE_URL", "LLM_BASE_URL", "LLM_ENDPOINT"]) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      /* ignore malformed env */
    }
  }
  if (process.env.BENCH_ALLOW_LLM_HOSTS) {
    for (const h of process.env.BENCH_ALLOW_LLM_HOSTS.split(",")) {
      const t = h.trim();
      if (t) hosts.add(t);
    }
  }
  return hosts;
}

export class EgressBlockedError extends Error {
  constructor(host: string) {
    super(`benchmark egress blocked: ${host} is not an allowed LLM endpoint`);
    this.name = "EgressBlockedError";
  }
}

function baseUrl(): string {
  return (
    process.env.OPENROUTER_BASE_URL ||
    process.env.LLM_BASE_URL ||
    process.env.LLM_ENDPOINT ||
    "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "");
}

export function resolveApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database("C:/Users/mishap/.omp/agent/agent.db", { readonly: true });
    const row = db.query("SELECT data FROM auth_credentials WHERE provider = 'openrouter' AND disabled_cause IS NULL").get() as any;
    if (row?.data) return JSON.parse(row.data).key;
  } catch {
    /* fall through */
  }
  throw new Error("LLM API key not found in OPENROUTER_API_KEY / LLM_API_KEY or agent.db");
}

export interface CallLlmOptions {
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  tools?: LlmToolSpec[];
}

export async function callLlm(
  model: string,
  messages: LlmMessage[],
  opts: CallLlmOptions = {}
): Promise<LlmCompletion> {
  const url = `${baseUrl()}/chat/completions`;
  const host = new URL(url).hostname;
  const allowed = allowedLlmHosts();
  if (!allowed.has(host)) throw new EgressBlockedError(host);

  const apiKey = opts.apiKey ?? resolveApiKey();
  const t0 = performance.now();

  const body: Record<string, unknown> = {
    model: model.replace(/^openrouter\//, ""),
    messages,
    max_tokens: opts.maxTokens ?? 1024
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  let json: any;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/oopsmishap/origami",
        "X-Title": "Origami Agentic Context Benchmark"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000)
    });
    json = await resp.json();
    if (!resp.ok) {
      return {
        content: "",
        toolCalls: [],
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
        latencyMs: Math.round(performance.now() - t0),
        resolvedModel: model,
        stopReason: "error",
        error: `LLM API error (${resp.status}): ${JSON.stringify(json?.error ?? json).slice(0, 300)}`
      };
    }
  } catch (err: any) {
    return {
      content: "",
      toolCalls: [],
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
      latencyMs: Math.round(performance.now() - t0),
      resolvedModel: model,
      stopReason: "error",
      error: err?.message ?? String(err)
    };
  }

  const latencyMs = Math.round(performance.now() - t0);
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const usage = json.usage ?? {};

  const toolCalls: LlmToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: "function" as const,
        function: {
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {})
        }
      }))
    : [];

  const content: string = msg.content ?? "";
  const finish = choice?.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");

  return {
    content,
    toolCalls,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cost: usage.cost ?? 0,
    latencyMs,
    resolvedModel: json.model ?? model,
    stopReason: finish === "tool_calls" ? "tool_calls" : finish === "length" ? "length" : "stop"
  };
}