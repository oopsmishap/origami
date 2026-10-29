/**
 * Replay real omp session journals through Origami.
 *
 *   bun run replay -- --dir ~/.omp/agent/sessions/<project> [--mode simulated|recorded]
 *                     [--session f.jsonl]... [--preset balanced] [--window 200000] [--no-hints] [--json out.json]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFromPreset, type Preset } from "../src/config.ts";
import { parseJournal, replaySession, type ReplayResult } from "./replay-lib.ts";

interface Options {
  sessions: string[];
  mode: "recorded" | "simulated";
  preset: Preset;
  window: number;
  hints: boolean;
  json: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = { sessions: [], mode: "simulated", preset: "balanced", window: 200_000, hints: true, json: null };
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
    } else if (a === "--preset") {
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
  const results: { session: string; result: ReplayResult }[] = [];
  console.log(`origami replay · mode ${o.mode} · preset ${o.preset} · window ${o.window} · hints ${o.hints ? "on" : "off"}\n`);
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
    const result = replaySession(entries, { mode: o.mode, config, windowTokens: o.window, hints: o.hints, probeDistanceRefs: 300, checkpointEvery: 200 });
    result.malformedLines = malformedLines;
    results.push({ session: path, result });
    console.log(row(path.split("/").pop()!.slice(0, 32), result));
  }
  if (results.length > 0) {
    const sum = (f: (r: ReplayResult) => number) => results.reduce((s, x) => s + f(x.result), 0);
    const requests = sum((r) => r.requests);
    const total: ReplayResult = {
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
  if (o.json) writeFileSync(o.json, `${JSON.stringify({ options: o, results }, null, 2)}\n`);
}

main();
