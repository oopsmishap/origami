import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import { BASE_TOOL_SPECS, executeBaseTool, type ToolContext } from "./tools.ts";
import type { LlmMessage } from "./llm.ts";
import type { CompactionRuntime } from "./strategy-runtime.ts";

export interface AgentToolCallbacks {
  onToolCall?: (call: { name: string; args: Record<string, unknown>; output: string }) => void;
  /** Per-turn memo suppressing identical read-only calls (models loop on fold_recall). */
  memo?: ToolCallMemo;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Tools whose output is a pure function of their arguments: safe to cache within a turn. */
const READ_ONLY_TOOLS: Record<string, true> = {
  read_file: true,
  list_files: true,
  grep: true,
  fold_search: true,
  fold_recall: true,
  fold_status: true
};

function memoKey(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return `${name}\u0000${JSON.stringify(keys.map((k) => [k, args[k]]))}`;
}

export interface ToolCallMemo {
  take(name: string, args: Record<string, unknown>): string | null;
  store(name: string, args: Record<string, unknown>, output: string): void;
  reset(): void;
}

/**
 * Per-turn cache of read-only tool outputs. When a model repeats an identical
 * `fold_recall`/`fold_search`/`read_file` call within one turn, the cached output is
 * returned with a hard prompt to synthesize instead of burning further tool steps.
 */
export function createToolCallMemo(): ToolCallMemo {
  const cache = new Map<string, string>();
  return {
    take(name, args) {
      if (!READ_ONLY_TOOLS[name]) return null;
      return cache.get(memoKey(name, args)) ?? null;
    },
    store(name, args, output) {
      if (!READ_ONLY_TOOLS[name]) return;
      cache.set(memoKey(name, args), output);
    },
    reset() {
      cache.clear();
    }
  };
}

function duplicateNotice(name: string, cached: string): string {
  return `Duplicate call — you already received this exact \`${name}\` result earlier in this turn. Do not call it again; synthesize your final response now.\n\n${cached}`;
}

function withCallback(
  name: string,
  args: Record<string, unknown>,
  produce: () => string,
  callbacks: AgentToolCallbacks
): string {
  const memo = callbacks.memo;
  const cached = memo?.take(name, args) ?? null;
  if (cached !== null) {
    callbacks.onToolCall?.({ name, args, output: cached });
    return duplicateNotice(name, cached);
  }
  const output = produce();
  memo?.store(name, args, output);
  callbacks.onToolCall?.({ name, args, output });
  return output;
}

export function createAgentTools(
  toolContext: ToolContext,
  runtime: CompactionRuntime,
  getMessages: () => LlmMessage[],
  callbacks: AgentToolCallbacks = {}
): ToolSet {
  const base: ToolSet = {
    read_file: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "read_file")!.function.description,
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative file path"),
        offset: z.number().int().optional().describe("0-based line offset"),
        limit: z.number().int().positive().optional().describe("Maximum lines to return")
      }),
      execute: async ({ path, offset, limit }) => withCallback(
        "read_file",
        { path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) },
        () => executeBaseTool("read_file", { path, offset, limit }, toolContext).output,
        callbacks
      )
    }),
    write_file: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "write_file")!.function.description,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => withCallback(
        "write_file",
        { path, content },
        () => executeBaseTool("write_file", { path, content }, toolContext).output,
        callbacks
      )
    }),
    edit_file: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "edit_file")!.function.description,
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: async ({ path, old_text, new_text }) => withCallback(
        "edit_file",
        { path, old_text, new_text },
        () => executeBaseTool("edit_file", { path, old_text, new_text }, toolContext).output,
        callbacks
      )
    }),
    list_files: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "list_files")!.function.description,
      inputSchema: z.object({ path: z.string().optional() }),
      execute: async ({ path }) => withCallback(
        "list_files",
        path === undefined ? {} : { path },
        () => executeBaseTool("list_files", { path }, toolContext).output,
        callbacks
      )
    }),
    grep: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "grep")!.function.description,
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
      execute: async ({ pattern, path }) => withCallback(
        "grep",
        { pattern, ...(path === undefined ? {} : { path }) },
        () => executeBaseTool("grep", { pattern, path }, toolContext).output,
        callbacks
      )
    }),
    check_work: tool({
      description: BASE_TOOL_SPECS.find((spec) => spec.function.name === "check_work")!.function.description,
      inputSchema: z.object({}),
      execute: async () => withCallback(
        "check_work",
        {},
        () => executeBaseTool("check_work", {}, toolContext).output,
        callbacks
      )
    })
  };

  const strategyTools: ToolSet = {};
  for (const spec of runtime.toolSpecs()) {
    const name = spec.function.name;
    strategyTools[name] = tool({
      description: spec.function.description,
      inputSchema: jsonSchema(spec.function.parameters),
      execute: async (args) => {
        const record = asRecord(args);
        return withCallback(name, record, () => runtime.handleTool(name, record, getMessages()), callbacks);
      }
    });
  }

  return { ...base, ...strategyTools };
}
