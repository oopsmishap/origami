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

/** Parent-relative handles (`../engine.ts`) are import specifiers inside file contents, not paths the work touched. */
function pathsIn(text: string): string[] {
  return [...text.matchAll(PATH_RE)].map((m) => m[1]!).filter((p) => !p.startsWith("../"));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function extractManifest(messages: readonly Pick<KernelMessage, "role" | "text" | "prose" | "toolCalls" | "isError">[]): BlockManifest {
  const paths: string[] = [];
  const symbols: string[] = [];
  const errors: string[] = [];
  const commits: string[] = [];
  const tools: string[] = [];
  for (const m of messages) {
    const conversational = m.role === "user" || m.role === "assistant";
    if (conversational) {
      paths.push(...pathsIn(m.prose));
      for (const s of m.prose.matchAll(SYMBOL_RE)) symbols.push(s[1]!);
      for (const re of COMMIT_RES) for (const c of m.prose.matchAll(re)) commits.push(c[1]!);
    }
    for (const call of m.toolCalls ?? []) {
      tools.push(call.name);
      if (m.role === "assistant") paths.push(...pathsIn(stableJson(call.arguments)));
    }
    if (m.role === "toolResult" && m.isError) {
      const lines = m.text.split("\n");
      let marked = false;
      for (const line of lines) {
        if (!ERROR_LINE_RE.test(line)) continue;
        marked = true;
        errors.push(line.replace(/\s+/g, " ").trim().slice(0, 200));
      }
      if (!marked) {
        const first = lines.map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean);
        if (first) errors.push(first.slice(0, 200));
      }
      for (const re of COMMIT_RES) for (const c of m.text.matchAll(re)) commits.push(c[1]!);
    }
  }
  const pathSet = new Set(paths);
  return {
    paths: sortedUnique(paths, CAPS.paths),
    symbols: sortedUnique(symbols.filter((s) => s.length <= 80 && isDistinctiveSymbol(s) && !pathSet.has(s) && pathsIn(s).join("") !== s), CAPS.symbols),
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a backticked identifier is specific enough to match on: it must carry structure
 * (camelCase, a digit, `_`, `$` or `.`). Plain lowercase words such as `false`, `balanced`
 * or `constraint` occur everywhere and only produce false matches.
 */
export function isDistinctiveSymbol(s: string): boolean {
  return s.length >= 3 && /[A-Z0-9_$.]/.test(s);
}

/** Argument keys that name files a tool call works on (read/edit/write/grep targets). */
const PATH_ARG_KEY = /^(?:path|paths|file|files|file_?path|filename|target_?file|source|destination)$/i;

/**
 * File-path values of a tool call's arguments, searched recursively. Only path-typed keys
 * count: free-form arguments such as shell commands or script bodies mention paths they do
 * not work on (imports, heredocs), so they never feed recall matching.
 */
export function pathArguments(args: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, pathKey: boolean): void => {
    if (typeof v === "string") {
      if (pathKey) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, pathKey);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, PATH_ARG_KEY.test(k));
    }
  };
  visit(args, false);
  return out;
}

/**
 * Whether `probe` mentions the manifest path `path` (whole path, or its last two segments).
 * Parent-relative handles never count: `../src/config.ts` in a file's imports is not work on
 * `src/config.ts`, and such handles are noise when they appear in old manifests.
 */
export function pathMentioned(probe: string, path: string): boolean {
  if (path.startsWith("../")) return false;
  const norm = path.replace(/^(\.\/)+/, "");
  const segments = norm.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const needles = [norm];
  if (segments.length > 2) needles.push(segments.slice(-2).join("/"));
  return needles.some((needle) => new RegExp(`(?<![\\w.-])(?<!\\.\\.\\/)${escapeRegExp(needle)}(?![\\w-])`).test(probe));
}
