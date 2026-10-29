/**
 * Deterministic block manifests: the concrete handles (paths, symbols, errors, commits,
 * tools) a folded span touched, extracted from source text rather than trusted to the
 * summary. They drive recall hints, summary lint, and full-text search.
 */
import type { KernelMessage } from "./types.ts";

export interface BlockManifest {
  paths: string[];
  symbols: string[];
  errors: string[];
  commits: string[];
  tools: string[];
}

export const EMPTY_MANIFEST: BlockManifest = Object.freeze({
  paths: [],
  symbols: [],
  errors: [],
  commits: [],
  tools: [],
}) as BlockManifest;

const CAPS = { paths: 40, symbols: 30, errors: 10, commits: 10, tools: 20 } as const;

// Lookbehind rejects URL / scheme tails (`https://host/a.md`, `artifact://x/y.md`).
const PATH_RE = /(?<![\w/.-])((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+(?:-\d+)?)?/g;
const SYMBOL_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
const ERROR_LINE_RE = /\b(?:error|Error|ERROR|FAIL|FAILED|failed|Exception|exception|panic|Traceback)\b/;
const COMMIT_RES = [/\[[\w./-]+ ([0-9a-f]{7,40})\]/g, /\bcommit ([0-9a-f]{7,40})\b/g];

function sortedUnique(values: Iterable<string>, cap: number): string[] {
  return [...new Set(values)].sort().slice(0, cap);
}

function firstSeenUnique(values: Iterable<string>, cap: number): string[] {
  return [...new Set(values)].slice(0, cap);
}

function pathsIn(text: string): string[] {
  return [...text.matchAll(PATH_RE)].map((m) => m[1]!);
}

export function extractManifest(messages: readonly Pick<KernelMessage, "role" | "text" | "toolCalls">[]): BlockManifest {
  const paths: string[] = [];
  const symbols: string[] = [];
  const errors: string[] = [];
  const commits: string[] = [];
  const tools: string[] = [];
  for (const m of messages) {
    paths.push(...pathsIn(m.text));
    if (m.role === "user" || m.role === "assistant") {
      for (const s of m.text.matchAll(SYMBOL_RE)) symbols.push(s[1]!);
    }
    if (m.role === "toolResult") {
      for (const line of m.text.split("\n")) {
        if (ERROR_LINE_RE.test(line)) errors.push(line.replace(/\s+/g, " ").trim().slice(0, 200));
      }
    }
    for (const re of COMMIT_RES) for (const c of m.text.matchAll(re)) commits.push(c[1]!);
    for (const call of m.toolCalls ?? []) tools.push(call.name);
  }
  const pathSet = new Set(paths);
  return {
    paths: sortedUnique(paths, CAPS.paths),
    symbols: sortedUnique(
      symbols.filter((s) => s.length >= 3 && s.length <= 80 && !pathSet.has(s) && pathsIn(s).join("") !== s),
      CAPS.symbols,
    ),
    errors: firstSeenUnique(errors.filter(Boolean), CAPS.errors),
    commits: firstSeenUnique(commits, CAPS.commits),
    tools: sortedUnique(tools, CAPS.tools),
  };
}

export function mergeManifests(ms: readonly BlockManifest[]): BlockManifest {
  return {
    paths: sortedUnique(ms.flatMap((m) => m.paths), CAPS.paths * 2),
    symbols: sortedUnique(ms.flatMap((m) => m.symbols), CAPS.symbols * 2),
    errors: firstSeenUnique(ms.flatMap((m) => m.errors), CAPS.errors * 2),
    commits: firstSeenUnique(ms.flatMap((m) => m.commits), CAPS.commits * 2),
    tools: sortedUnique(ms.flatMap((m) => m.tools), CAPS.tools * 2),
  };
}

export function parseManifest(v: unknown): BlockManifest | undefined {
  if (typeof v === "string") {
    try {
      return parseManifest(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const list = (x: unknown): string[] | null =>
    x === undefined ? [] : Array.isArray(x) && x.every((s) => typeof s === "string") ? (x as string[]) : null;
  const paths = list(o.paths);
  const symbols = list(o.symbols);
  const errors = list(o.errors);
  const commits = list(o.commits);
  const tools = list(o.tools);
  if (!paths || !symbols || !errors || !commits || !tools) return undefined;
  return { paths, symbols, errors, commits, tools };
}

/** Searchable terms (tools excluded: they are too generic to identify a block). */
export function manifestTerms(m: BlockManifest): string[] {
  return [...m.paths, ...m.symbols, ...m.errors, ...m.commits];
}
