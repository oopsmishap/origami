/**
 * Replay real omp session journals through Origami.
 *
 *   bun run replay -- --dir ~/.omp/agent/sessions/<project> [--mode simulated|recorded]
 *                     [--session f.jsonl]... [--preset balanced] [--window 200000] [--no-hints] [--json out.json]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFromPreset, type Preset } from "../src/config.ts";
import type { ReplayPolicy } from "./replay-policy.ts";
import { loadReplaySummaryCache, type ReplaySummarySource } from "./replay-summary.ts";
import { parseJournal, replaySession, type ReplayResult } from "./replay-lib.ts";

interface Options {
  sessions: string[];
  mode: "recorded" | "simulated";
  policy: ReplayPolicy | "both";
  summarySource: ReplaySummarySource;
  summaryCache: string | null;
  summaryMisses: string | null;
  preset: Preset;
  window: number;
  hints: boolean;
  json: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = { sessions: [], mode: "simulated", policy: "current", summarySource: "extractive", summaryCache: null, summaryMisses: null, preset: "balanced", window: 200_000, hints: true, json: null };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session") o.sessions.push(value(i++, a));
    else if (a === "--dir") {
      const dir = value(i++, a);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) o.sessions.push(join(dir, f));
    } else if (a === "--mode") {
      const m = value(i++, a);
      if (m !== "recorded" && m !== "simulated") throw new Error(`--mode must be recorded or simulated, got ${m}`);
      o.mode = m;
    } else if (a === "--policy") {
      const policy = value(i++, a);
      if (policy !== "current" && policy !== "legacy-0.2" && policy !== "both") throw new Error(`--policy must be current, legacy-0.2 or both, got ${policy}`);
      o.policy = policy;
    } else if (a === "--summary-source") {
      const source = value(i++, a);
      if (source !== "extractive" && source !== "cache") throw new Error(`--summary-source must be extractive or cache, got ${source}`);
      o.summarySource = source;
    } else if (a === "--summary-cache") o.summaryCache = value(i++, a);
    else if (a === "--summary-misses") o.summaryMisses = value(i++, a);
    else if (a === "--preset") {
      const p = value(i++, a);
      if (p !== "balanced" && p !== "lean" && p !== "relaxed") throw new Error(`--preset must be balanced, lean or relaxed, got ${p}`);
      o.preset = p;
    } else if (a === "--window") {
      const w = Number(value(i++, a));
      if (!Number.isInteger(w) || w <= 0) throw new Error(`--window must be a positive integer`);
      o.window = w;
    } else if (a === "--no-hints") o.hints = false;
    else if (a === "--json") o.json = value(i++, a);
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.sessions.length === 0) throw new Error("no input: pass --session <file.jsonl> or --dir <dir>");
  if (o.mode === "recorded" && o.policy === "both") throw new Error("--policy both is not valid with recorded mode");
  if (o.summarySource === "cache" && !o.summaryCache) throw new Error("--summary-source cache requires --summary-cache <file.jsonl>");
  return o;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));

function row(name: string, r: ReplayResult): string {
  const p = r.probes;
  return `| ${name} | ${r.requests} | ${r.folds[1]}/${r.folds[2]}/${r.folds[3]} | ${k(r.meanContextTokens)} | ${k(r.peakContextTokens)} | ${r.simulatedHitPct}% | ${k(r.billedUnits)} | ${k(r.baselineBilledUnits)} | ${r.hintsEmitted} | ${p.total} | ${p.inContext}/${p.viaHint}/${p.lost} | ${p.minInContextPct.toFixed(0)}% | ${r.hostCompactions} | ${r.malformedLines} |`;
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const config = configFromPreset(o.preset);
  const results: { session: string; policy: ReplayPolicy; result: ReplayResult }[] = [];
  const policies: ReplayPolicy[] = o.policy === "both" ? ["legacy-0.2", "current"] : [o.policy];
  const summaryCache = o.summaryCache ? loadReplaySummaryCache(o.summaryCache) : undefined;
  const misses = new Map();
  console.log(`origami replay · mode ${o.mode} · policy ${o.policy} · preset ${o.preset} · window ${o.window} · hints ${o.hints ? "on" : "off"} · summaries ${o.summarySource}${o.summaryCache ? ` (${o.summaryCache})` : ""}\n`);
  console.log("| session | requests | folds t1/t2/t3 | mean ctx | peak ctx | hit | billed | baseline | hints | probes | in/hint/lost | min in-ctx | host compactions | malformed |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const path of o.sessions) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      console.log(`skip ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const { entries, malformedLines } = parseJournal(text);
    for (const policy of policies) {
      const result = replaySession(entries, { mode: o.mode, policy, summarySource: o.summarySource, summaryCache, summaryMisses: misses, config, windowTokens: o.window, hints: o.hints, probeDistanceRefs: 300, checkpointEvery: 200 });
      result.malformedLines = malformedLines;
      results.push({ session: path, policy, result });
      console.log(row(`${path.split("/").pop()!.slice(0, 22)}:${policy}`, result));
    }
  }
  if (results.length > 0) {
    const sum = (f: (r: ReplayResult) => number) => results.reduce((s, x) => s + f(x.result), 0);
    const requests = sum((r) => r.requests);
    const total: ReplayResult = {
      policy: policies.length === 1 ? policies[0]! : "current",
      price: results[0]!.result.price,
      requests,
      malformedLines: sum((r) => r.malformedLines),
      hostCompactions: sum((r) => r.hostCompactions),
      folds: { 1: sum((r) => r.folds[1]), 2: sum((r) => r.folds[2]), 3: sum((r) => r.folds[3]) },
      meanContextTokens: requests > 0 ? Math.round(sum((r) => r.meanContextTokens * r.requests) / requests) : 0,
      peakContextTokens: Math.max(...results.map((x) => x.result.peakContextTokens)),
      simulatedHitPct: requests > 0 ? Math.round((sum((r) => r.simulatedHitPct * r.requests) / requests) * 10) / 10 : 0,
      billedUnits: sum((r) => r.billedUnits),
      baselineBilledUnits: sum((r) => r.baselineBilledUnits),
      hintsEmitted: sum((r) => r.hintsEmitted),
      probes: {
        total: sum((r) => r.probes.total),
        inContext: sum((r) => r.probes.inContext),
        viaHint: sum((r) => r.probes.viaHint),
        lost: sum((r) => r.probes.lost),
        minInContextPct: Math.min(...results.map((x) => x.result.probes.minInContextPct)),
      },
      recordedUsage: {
        input: sum((r) => r.recordedUsage.input),
        cacheRead: sum((r) => r.recordedUsage.cacheRead),
        cacheWrite: sum((r) => r.recordedUsage.cacheWrite),
      },
    };
    console.log(row("**total**", total));
  }
  if (o.summaryMisses && misses.size > 0) writeFileSync(o.summaryMisses, `${[...misses.values()].map((request) => JSON.stringify(request)).join("\n")}\n`);
  if (o.summarySource === "cache" && misses.size > 0) throw new Error(`${misses.size} replay summaries missing`);
  if (o.json) writeFileSync(o.json, `${JSON.stringify({ options: o, results }, null, 2)}\n`);
}

main();
