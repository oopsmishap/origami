/**
 * Sandboxed filesystem for agentic benchmark runs.
 *
 * Every tool-visible path resolves inside a per-run workspace directory.
 * Anything that escapes the workspace root is rejected before any I/O.
 * Benchmark tools never touch the network; the only egress in a run is the
 * LLM call guarded by `bench/agentic/llm.ts`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export class SandboxEscapeError extends Error {
  constructor(path: string) {
    super(`path escapes sandbox workspace: ${path}`);
    this.name = "SandboxEscapeError";
  }
}

export class SandboxIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxIoError";
  }
}

/** Hard ceiling on bytes any single tool result may return to the model. */
export const TOOL_RESULT_LIMIT = 24_000;

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

function clip(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated: ${text.length - limit} more characters]`;
}

export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  /** Resolve a tool-supplied path, rejecting anything outside the workspace. */
  resolvePath(p: string): string {
    const raw = (p ?? "").trim();
    if (raw.length === 0) throw new SandboxIoError("path must not be empty");
    if (raw.includes("\0")) throw new SandboxIoError("path contains NUL byte");

    const target = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
    const rel = relative(this.root, target);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return target;
    if (rel.length === 0) return target;
    throw new SandboxEscapeError(raw);
  }

  /** True when `p` resolves inside the workspace. */
  contains(p: string): boolean {
    try {
      this.resolvePath(p);
      return true;
    } catch {
      return false;
    }
  }
  /** True when `p` resolves inside the workspace AND exists on disk. */
  exists(p: string): boolean {
    try {
      const target = this.resolvePath(p);
      return existsSync(target);
    } catch {
      return false;
    }
  }


  read(p: string, offset = 0, limit?: number): string {
    const target = this.resolvePath(p);
    if (!existsSync(target)) throw new SandboxIoError(`no such file: ${p}`);
    const st = statSync(target);
    if (st.isDirectory()) throw new SandboxIoError(`is a directory: ${p}`);
    const lines = readFileSync(target, "utf8").split("\n");
    const start = Math.max(0, offset);
    const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`)
      .join("\n");
    return clip(`# ${p} (lines ${start + 1}-${end} of ${lines.length})\n${body}`);
  }

  write(p: string, content: string): { path: string; bytes: number; lines: number } {
    const target = this.resolvePath(p);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { path: p, bytes: Buffer.byteLength(content, "utf8"), lines: content.split("\n").length };
  }

  /** Replace the single occurrence of `oldText` with `newText`. Ambiguity is an error. */
  replace(p: string, oldText: string, newText: string): { path: string; occurrences: number } {
    const target = this.resolvePath(p);
    if (!existsSync(target)) throw new SandboxIoError(`no such file: ${p}`);
    const source = readFileSync(target, "utf8");
    const occurrences = source.split(oldText).length - 1;
    if (occurrences === 0) throw new SandboxIoError(`old text not found in ${p}`);
    if (occurrences > 1) throw new SandboxIoError(`old text is ambiguous in ${p} (${occurrences} matches); narrow the search text`);
    writeFileSync(target, source.replace(oldText, newText), "utf8");
    return { path: p, occurrences };
  }

  list(p = "."): string {
    const target = this.resolvePath(p);
    if (!existsSync(target)) throw new SandboxIoError(`no such directory: ${p}`);
    const rows: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || rows.length > 400) return;
      for (const name of readdirSync(dir).sort()) {
        const child = join(dir, name);
        const st = statSync(child);
        const rel = relative(this.root, child).split("\\").join("/");
        if (st.isDirectory()) {
          rows.push(`${rel}/`);
          walk(child, depth + 1);
        } else {
          rows.push(`${rel}  (${st.size} bytes)`);
        }
      }
    };
    if (statSync(target).isDirectory()) walk(target, 0);
    else rows.push(`${relative(this.root, target).split("\\").join("/")}  (${statSync(target).size} bytes)`);
    return clip(rows.length > 0 ? rows.join("\n") : "(empty)");
  }

  grep(pattern: string, p = "."): string {
    const regex = new RegExp(pattern, "i");
    const target = this.resolvePath(p);
    const matches: GrepMatch[] = [];

    const walk = (dir: string) => {
      if (matches.length >= 200) return;
      for (const name of readdirSync(dir).sort()) {
        if (matches.length >= 200) return;
        const child = join(dir, name);
        const st = statSync(child);
        if (st.isDirectory()) {
          walk(child);
          continue;
        }
        if (st.size > 2_000_000) continue;
        const rel = relative(this.root, child).split("\\").join("/");
        const lines = readFileSync(child, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
            if (matches.length >= 200) return;
          }
        }
      }
    };

    if (statSync(target).isDirectory()) walk(target);
    else {
      const rel = relative(this.root, target).split("\\").join("/");
      const lines = readFileSync(target, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
      }
    }

    if (matches.length === 0) return "(no matches)";
    return clip(
      matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") + (matches.length >= 200 ? "\n… [match cap reached]" : "")
    );
  }
}