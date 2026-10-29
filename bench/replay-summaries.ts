import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseReplaySummaryCache, type ReplaySummaryRecord, type ReplaySummaryRequest } from "./replay-summary.ts";
import { salvageFoldParams } from "../src/tools/salvage.ts";

export interface ReplaySummaryRunner {
  run(prompt: string, model: string, agentDir: string): string;
}

export function fillReplaySummaries(requests: readonly ReplaySummaryRequest[], existing: ReadonlyMap<string, ReplaySummaryRecord>, runner: ReplaySummaryRunner, model: string, agentDir: string, persist: (records: readonly ReplaySummaryRecord[]) => void): ReplaySummaryRecord[] {
  const records = [...existing.values()];
  const seen = new Set(records.map((record) => record.key));
  for (const request of requests) {
    if (seen.has(request.key)) continue;
    const prompt = `Summarize this fold source. Reply with one JSON object {"topic":"...","summary":"...","keep":[...]}.\nTier: ${request.tier}\nRange: ${request.range}\nSource:\n${request.source}`;
    const raw = runner.run(prompt, model, agentDir);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`${request.key}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const salvaged = salvageFoldParams({ ...(parsed as object), range: request.range, tier: request.tier });
    if (!salvaged.ok) throw new Error(`${request.key}: ${salvaged.error}`);
    const fold = salvaged.params.folds[0]!;
    const record: ReplaySummaryRecord = { key: request.key, tier: request.tier, range: request.range, topic: fold.topic, summary: fold.summary, ...(fold.keep ? { keep: fold.keep } : {}) };
    records.push(record);
    seen.add(record.key);
    persist(records);
  }
  return records;
}

function parseArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument near ${key ?? "end"}`);
    values.set(key, value);
  }
  for (const required of ["--requests", "--out", "--agent-dir"]) if (!values.has(required)) throw new Error(`${required} is required`);
  return { requests: values.get("--requests")!, out: values.get("--out")!, agentDir: values.get("--agent-dir")!, model: values.get("--model") ?? "westgpt/quartz/gpt-5.6-terra" };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const requests = readFileSync(args.requests, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as ReplaySummaryRequest; } catch (error) { throw new Error(`invalid request line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const existing = existsSync(args.out) ? parseReplaySummaryCache(readFileSync(args.out, "utf8")) : new Map<string, ReplaySummaryRecord>();
  const runner: ReplaySummaryRunner = {
    run(prompt, model, agentDir) {
      const result = spawnSync("omp", ["--no-extensions", "--model", model, "--print", prompt], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
      if (result.status !== 0) throw new Error(result.stderr || `omp exited ${result.status}`);
      return result.stdout.trim();
    },
  };
  const persist = (records: readonly ReplaySummaryRecord[]) => {
    const temp = join(dirname(args.out), `.${args.out.split("/").pop()}.tmp`);
    writeFileSync(temp, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    renameSync(temp, args.out);
  };
  fillReplaySummaries(requests, existing, runner, args.model, args.agentDir, persist);
}
