/**
 * Base sandbox tool layer for agentic benchmark runs.
 *
 * These are real, working tools backed by the per-run Sandbox. Compaction tools
 * (fold / compact / handoff / shake) are layered on top by strategy runtimes.
 * Nothing here reaches the network.
 */

import { Sandbox, SandboxIoError, TOOL_RESULT_LIMIT } from "./sandbox.ts";
import type { LlmToolSpec } from "./llm.ts";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolContext {
  sandbox: Sandbox;
  /** Scenario-defined structural verifier; returns a progress checklist. */
  verify?: () => string;
  /** Mutable run facts the agent can read back (e.g. seeded data directory). */
  facts?: Map<string, string>;
}

export function clip(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated: ${text.length - limit} more characters]`;
}

export const BASE_TOOL_SPECS: LlmToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace. Returns numbered lines. Use offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          offset: { type: "integer", description: "0-based line offset (optional)" },
          limit: { type: "integer", description: "Max lines to return (optional)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact occurrence of old_text with new_text in a file. Fails if the text is missing or ambiguous.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in the workspace (or a subdirectory).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Defaults to workspace root" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Case-insensitive regex search across workspace files. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory to search (defaults to root)" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_work",
      description: "Run the task's structural verification and return a progress checklist. Does not reveal answers.",
      parameters: { type: "object", properties: {} }
    }
  }
];

export function executeBaseTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  try {
    switch (name) {
      case "read_file":
        return {
          ok: true,
          output: ctx.sandbox.read(String(args.path ?? ""), Number(args.offset ?? 0), args.limit !== undefined ? Number(args.limit) : undefined)
        };
      case "write_file": {
        const r = ctx.sandbox.write(String(args.path ?? ""), String(args.content ?? ""));
        return { ok: true, output: `wrote ${r.path} (${r.bytes} bytes, ${r.lines} lines)` };
      }
      case "edit_file": {
        const r = ctx.sandbox.replace(String(args.path ?? ""), String(args.old_text ?? ""), String(args.new_text ?? ""));
        return { ok: true, output: `edited ${r.path} (${r.occurrences} replacement)` };
      }
      case "list_files":
        return { ok: true, output: ctx.sandbox.list(args.path ? String(args.path) : ".") };
      case "grep":
        return { ok: true, output: ctx.sandbox.grep(String(args.pattern ?? ""), args.path ? String(args.path) : ".") };
      case "check_work":
        return { ok: true, output: ctx.verify ? ctx.verify() : "(no verification defined for this scenario)" };
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    if (err instanceof SandboxIoError) return { ok: false, output: `error: ${err.message}` };
    return { ok: false, output: `error: ${err?.message ?? String(err)}` };
  }
}