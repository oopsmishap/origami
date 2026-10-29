/**
 * Live Dynamic Web Dashboard for Origami Real-World Benchmark.
 *
 * Streams real-time progress, live context compression trajectory,
 * block tree pagoda hierarchy, JIT hydration ghost pointers,
 * and side-by-side probe evaluation results over Server-Sent Events.
 *
 * Usage:
 *   bun bench/web-server.ts [--port 4142] [--run]
 */

import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { configFromPreset, type Preset } from "../src/config.ts";
import { OrigamiEngine } from "../src/engine.ts";
import { JOURNAL_ENTRY_TYPE } from "../src/persist/journal.ts";
import { entryMessage } from "../src/kernel/registry.ts";
import { kernelMessagesFromEntries } from "../src/runtime.ts";
import type { SessionEntryLike } from "../src/kernel/state.ts";
import { parseJournal, linearBranch, countTokens, type JournalEntry } from "./replay-lib.ts";
import { decideReplayPolicy, createReplayPolicyState } from "./replay-policy.ts";

const PORT = parseInt(process.env.PORT || "4142", 10);

interface ProbeDef {
  id: string;
  name: string;
  question: string;
  rubric: {
    part1: { desc: string; keywords: string[] };
    part2: { desc: string; keywords: string[] };
  };
}

const PROBES: ProbeDef[] = [
  {
    id: "repo-and-tools",
    name: "Repo Target & Tools Exclusion",
    question: "What specific GitHub repository and organization was Origami instructed to be pushed to, and what was the strict rule specified regarding shipping the tools/ directory?",
    rubric: {
      part1: { desc: "Repository: oopsmishap/origami", keywords: ["oopsmishap", "origami"] },
      part2: { desc: "Tools constraint: do not ship tools/", keywords: ["tools", "not", "ship", "exclude"] }
    }
  },
  {
    id: "telemetry-bug",
    name: "Telemetry Percentage Bug Fix",
    question: "What issue was reported with the Web UI displaying 900% or 1100% context occupancy, and how was the occupancy percentage calculation corrected?",
    rubric: {
      part1: { desc: "Root cause: 100x over-scaling or percentage bug", keywords: ["100", "percent", "scale", "over-scaling", "900", "1100", "multiplied"] },
      part2: { desc: "Fix: aligned live vs projected tokens", keywords: ["align", "projected", "live", "calculation", "formula", "fix", "ratio"] }
    }
  },
  {
    id: "trajectory-port",
    name: "Trajectory Visualization Port",
    question: "What visualization was ported from billion-context into Origami's TUI and WebUI, and how were trajectory bars bounded and scaled?",
    rubric: {
      part1: { desc: "Feature: 1:1 bar trajectory chart from billion-context", keywords: ["billion-context", "trajectory", "bar", "chart"] },
      part2: { desc: "Bounds & scaling: 50 visible turns and visible peak scaling", keywords: ["50", "visible", "peak", "bound", "ceiling"] }
    }
  },
  {
    id: "agent-neutrality",
    name: "Agent Generality & Branding",
    question: "What explicit instructions did the user give regarding whether Origami branding, logos, and socials should mention omp or tern specifically?",
    rubric: {
      part1: { desc: "Constraint: do not mention omp or tern specifically", keywords: ["not mention", "tern", "omp", "avoid", "omit", "agnostic"] },
      part2: { desc: "Rationale: support other agents in the future", keywords: ["other agent", "future", "support", "generic", "general"] }
    }
  }
];

function scoreResponse(text: string, probe: ProbeDef): { score: number; p1: boolean; p2: boolean } {
  const lower = text.toLowerCase();
  const p1 = probe.rubric.part1.keywords.some((k) => lower.includes(k));
  const p2 = probe.rubric.part2.keywords.some((k) => lower.includes(k));
  const score = (p1 ? 0.5 : 0) + (p2 ? 0.5 : 0);
  return { score, p1, p2 };
}

function resolveApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const db = new Database("C:/Users/mishap/.omp/agent/agent.db");
    const row = db.query("SELECT data FROM auth_credentials WHERE provider = 'openrouter' AND disabled_cause IS NULL").get() as any;
    if (row?.data) return JSON.parse(row.data).key;
  } catch {}
  return "";
}

function defaultSessionPath(): string {
  const candidate = "C:/Users/mishap/.omp/agent/sessions/--H--projects-_mishap_-origami--/2026-10-28T18-40-20-551Z_01a183d0-2c47-752f-8671-8ee42d97abc3.jsonl";
  if (existsSync(candidate)) return candidate;
  return "tests/fixtures/replay-session.jsonl";
}

interface OpenRouterResponse {
  content: string;
  reasoning?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  latencyMs: number;
  resolvedModel: string;
}

async function queryOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 250
): Promise<OpenRouterResponse> {
  const targetModel = model.replace(/^openrouter\//, "");
  const t0 = performance.now();

  let json: any;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/oopsmishap/origami",
        "X-Title": "Origami Live Benchmark"
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(30000)
    });

    json = await resp.json();

    if (!resp.ok) {
      throw new Error(`OpenRouter API error (${resp.status}): ${JSON.stringify(json?.error || json)}`);
    }
  } catch (err: any) {
    throw new Error(err.message || String(err));
  }
  const t1 = performance.now();

  const choice = json.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? "";
  const reasoning = message?.reasoning ?? (message?.reasoning_details?.[0]?.text ?? "");

  const usage = json.usage ?? {};
  return {
    content: content || reasoning,
    reasoning,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cost: usage.cost ?? 0,
    latencyMs: Math.round(t1 - t0),
    resolvedModel: json.model ?? targetModel
  };
}

// Global active benchmark runner state
class BenchmarkCoordinator {
  public isRunning = false;
  public abortController: AbortController | null = null;
  public subscribers = new Set<(event: string, data: unknown) => void>();
  public latestSnapshot: any = {
    status: "idle",
    model: "nvidia/nemotron-3.5-super-vl:free",
    currentTurn: 0,
    totalTurns: 327,
    rawTokens: 0,
    baselineTokens: 0,
    origamiTokens: 0,
    compressionRatio: 1,
    activeBlocks: { t1: 0, t2: 0, t3: 0 },
    ghostPointers: [] as string[],
    milestones: [] as any[],
    trajectory: [] as any[],
    summary: null as any
  };

  subscribe(cb: (event: string, data: unknown) => void) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  broadcast(event: string, data: unknown) {
    for (const sub of this.subscribers) {
      try { sub(event, data); } catch {}
    }
  }

  stop() {
    if (this.isRunning && this.abortController) {
      this.abortController.abort();
      this.isRunning = false;
      this.latestSnapshot.status = "stopped";
      this.broadcast("status", this.latestSnapshot);
    }
  }

  async start(options: {
    model?: string;
    milestones?: number[];
    preset?: Preset;
    windowTokens?: number;
  } = {}) {
    if (this.isRunning) return;

    this.isRunning = true;
    this.abortController = new AbortController();
    const apiKey = resolveApiKey();
    const model = (options.model || "nvidia/nemotron-3.5-super-vl:free").replace(/^openrouter\//, "");
    const preset = options.preset || "balanced";
    const milestones = options.milestones || [40, 100, 200, 300];
    const windowTokens = options.windowTokens || 1000000;
    const sessionPath = defaultSessionPath();

    this.latestSnapshot = {
      status: "running",
      model,
      preset,
      windowTokens,
      currentTurn: 0,
      totalTurns: 327,
      rawTokens: 0,
      baselineTokens: 0,
      origamiTokens: 0,
      compressionRatio: 1,
      activeBlocks: { t1: 0, t2: 0, t3: 0 },
      ghostPointers: [],
      milestones: [],
      trajectory: [],
      summary: null
    };
    this.broadcast("start", this.latestSnapshot);

    try {
      const journalText = readFileSync(sessionPath, "utf8");
      const { entries } = parseJournal(journalText);
      const branch = linearBranch(entries);

      const working: JournalEntry[] = [];
      let appended = 0;
      let now = 0;
      let prevNow: number | null = null;
      let renderedTokens = 0;

      const config = configFromPreset(preset);
      const engine = new OrigamiEngine({
        host: {
          sessionId: () => "live-bench",
          appendEvent: (op) => {
            working.push({ type: "custom", customType: JOURNAL_ENTRY_TYPE, id: `bench-${++appended}`, data: op });
          },
          saveArtifact: async () => undefined,
          windowTokens: () => windowTokens,
          projectedTokens: () => renderedTokens
        },
        entries: [],
        modelId: model,
        config,
        countFn: countTokens,
        now: () => now
      });

      const policyState = createReplayPolicyState();

      const foldAll = (specs: { range: string; topic: string; summary: string }[], tier: 1 | 2 | 3): number => {
        let pending = specs.filter((s) => s.summary.length > 0);
        while (pending.length > 0) {
          const res = engine.executeFold({ folds: pending, tier });
          if (res.ok) {
            return res.outcome.blocks.reduce((s, b) => s + b.tokensAfter, 0);
          }
          pending = pending.filter((_, i) => i !== res.foldIndex);
        }
        return 0;
      };

      const simulateFold = (): number => {
        const decision = decideReplayPolicy("current", engine, policyState);
        if (decision.kind === "promotion" && decision.promotion) {
          const fromTier = decision.promotion.fromTier;
          const blocks = engine.state.tree.live().filter((b) => b.tier === fromTier);
          if (blocks.length < 2) return 0;
          const range = blocks.map((b) => b.id).join(",");
          const spec = {
            range,
            tier: (fromTier + 1) as 2 | 3,
            topic: `Consolidated ${blocks[0]!.id}..${blocks.at(-1)!.id}`,
            summary: `- ${blocks.map((b) => b.topic).join("\n- ")}`
          };
          return foldAll([spec], (fromTier + 1) as 2 | 3);
        }
        if (decision.kind === "efficiency" || decision.kind === "emergency") {
          const specs = engine.recommendedRanges().map((x) => ({
            range: `${x.start}..${x.end}`,
            topic: `Phase ${x.start}..${x.end}`,
            summary: engine.archiveDigest([{ start: x.start, end: x.end }])
          }));
          return foldAll(specs, 1);
        }
        return 0;
      };

      let assistantCount = 0;
      let rawCumulativeTokens = 0;
      let lastMessageRole: string | undefined;
      const milestonesSet = new Set(milestones);

      for (let entryIdx = 0; entryIdx < branch.length; entryIdx++) {
        if (this.abortController?.signal.aborted) break;

        const entry = branch[entryIdx]!;
        const msg = entry.type === "message" ? (entry.message || entry.content) : undefined;
        const role = (msg as any)?.role;
        const content = (msg as any)?.content;
        const textContent = typeof content === "string" ? content : JSON.stringify(content ?? "");
        rawCumulativeTokens += countTokens(textContent);

        if (role !== "assistant") {
          working.push(entry);
          if (entryMessage(entry as SessionEntryLike) !== undefined) {
            lastMessageRole = (entryMessage(entry as SessionEntryLike) as any)?.role;
          }
          continue;
        }

        assistantCount++;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
        now = Number.isFinite(ts) ? ts : (prevNow ?? 0) + 1000;
        prevNow = now;

        engine.refresh(working as SessionEntryLike[]);
        engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
        if (lastMessageRole === "user") engine.onTurnStart();

        const foldSigma = simulateFold();
        if (foldSigma > 0) {
          engine.refresh(working as SessionEntryLike[]);
          engine.ingest(kernelMessagesFromEntries(working as SessionEntryLike[]));
        }

        const liveBlocks = engine.state.tree.live();
        const activeBlocks = {
          t1: liveBlocks.filter((b) => b.tier === 1).length,
          t2: liveBlocks.filter((b) => b.tier === 2).length,
          t3: liveBlocks.filter((b) => b.tier === 3).length
        };

        const rawMessages = working.map((e) => entryMessage(e as SessionEntryLike)).filter(Boolean) as any[];

        // Build Origami Messages
        const makeFoldMessage = (text: string, blockId: string, refTag?: string) => ({
          role: "user",
          content: refTag ? `${refTag} ${text}` : text
        });
        const renderedRaw = engine.render(rawMessages, makeFoldMessage as any);
        const origamiMessages: Array<{ role: string; content: string }> = [
          { role: "system", content: "You are an expert software engineer reviewing a long-running coding session." }
        ];
        for (const m of renderedRaw) {
          const r = (m as any)?.role === "assistant" ? "assistant" : "user";
          const c = typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
          origamiMessages.push({ role: r, content: c });
        }
        const hydration = engine.hydrationText();
        if (hydration) {
          origamiMessages.push({ role: "user", content: hydration });
        }
        const origamiTokens = origamiMessages.reduce((s, m) => s + countTokens(m.content), 0);

        // Build Baseline Messages (sliding window)
        const baselineMessages: Array<{ role: string; content: string }> = [
          { role: "system", content: "You are an expert software engineer reviewing a long-running coding session transcript." }
        ];
        let currentBaseTokens = countTokens(baselineMessages[0]!.content);
        const reversedRaw: Array<{ role: string; content: string }> = [];
        const maxBaseTokens = Math.max(10000, windowTokens - 10000);
        for (let i = rawMessages.length - 1; i >= 0; i--) {
          const m = rawMessages[i];
          const r = m.role === "assistant" ? "assistant" : "user";
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          const tok = countTokens(c);
          if (currentBaseTokens + tok > maxBaseTokens) break;
          currentBaseTokens += tok;
          reversedRaw.push({ role: r, content: c });
        }
        reversedRaw.reverse();
        baselineMessages.push(...reversedRaw);
        const baselineTokens = baselineMessages.reduce((s, m) => s + countTokens(m.content), 0);

        const ghostPointers = liveBlocks.map((b) => `${b.id} (${b.topic})`);

        // Record Trajectory Point
        this.latestSnapshot.currentTurn = assistantCount;
        this.latestSnapshot.rawTokens = rawCumulativeTokens;
        this.latestSnapshot.baselineTokens = baselineTokens;
        this.latestSnapshot.origamiTokens = origamiTokens;
        this.latestSnapshot.compressionRatio = Math.round((baselineTokens / origamiTokens) * 10) / 10;
        this.latestSnapshot.activeBlocks = activeBlocks;
        this.latestSnapshot.ghostPointers = ghostPointers;

        if (assistantCount % 5 === 0 || milestonesSet.has(assistantCount)) {
          this.latestSnapshot.trajectory.push({
            turn: assistantCount,
            raw: rawCumulativeTokens,
            baseline: baselineTokens,
            origami: origamiTokens,
            folds: activeBlocks.t1 + activeBlocks.t2 + activeBlocks.t3
          });
          this.broadcast("tick", {
            turn: assistantCount,
            raw: rawCumulativeTokens,
            baseline: baselineTokens,
            origami: origamiTokens,
            ratio: this.latestSnapshot.compressionRatio,
            blocks: activeBlocks
          });
        }

        // Evaluate Milestone
        if (milestonesSet.has(assistantCount)) {
          this.latestSnapshot.status = "evaluating_probes";
          this.broadcast("milestone_start", {
            milestoneIndex: assistantCount,
            rawTokens: rawCumulativeTokens,
            baselineTokens,
            origamiTokens,
            ratio: this.latestSnapshot.compressionRatio
          });

          const probeTasks = PROBES.map(async (probe) => {
            if (this.abortController?.signal.aborted) return null;

            this.broadcast("probe_evaluating", {
              milestoneIndex: assistantCount,
              probeId: probe.id,
              probeName: probe.name
            });

            const baseQuery = [...baselineMessages, { role: "user", content: probe.question }];
            const origQuery = [...origamiMessages, { role: "user", content: probe.question }];

            const [baseRes, origRes] = await Promise.all([
              queryOpenRouter(apiKey, model, baseQuery, 250).catch((e: any) => ({
                content: `Error: ${e.message}`,
                promptTokens: baselineTokens,
                completionTokens: 0,
                cachedTokens: 0,
                cost: 0,
                latencyMs: 0,
                resolvedModel: model
              })),
              queryOpenRouter(apiKey, model, origQuery, 250).catch((e: any) => ({
                content: `Error: ${e.message}`,
                promptTokens: origamiTokens,
                completionTokens: 0,
                cachedTokens: 0,
                cost: 0,
                latencyMs: 0,
                resolvedModel: model
              }))
            ]);

            const baseScore = scoreResponse(baseRes.content, probe);
            const origScore = scoreResponse(origRes.content, probe);

            const probeOutcome = {
              probeId: probe.id,
              probeName: probe.name,
              baseline: {
                score: baseScore.score,
                tokens: baseRes.promptTokens,
                latencyMs: baseRes.latencyMs,
                responsePreview: baseRes.content.slice(0, 200).replace(/\n/g, " ")
              },
              origami: {
                score: origScore.score,
                tokens: origRes.promptTokens,
                cachedTokens: origRes.cachedTokens,
                latencyMs: origRes.latencyMs,
                responsePreview: origRes.content.slice(0, 200).replace(/\n/g, " ")
              }
            };

            this.broadcast("probe_done", { milestoneIndex: assistantCount, probe: probeOutcome });
            return probeOutcome;
          });

          const rawResults = await Promise.all(probeTasks);
          const probeResults = rawResults.filter((p): p is NonNullable<typeof p> => p !== null);

          const milestoneItem = {
            requestIndex: assistantCount,
            milestoneIndex: assistantCount,
            rawCumulativeTokens,
            rawTokens: rawCumulativeTokens,
            baselineTokens,
            baselineContextTokens: baselineTokens,
            origamiTokens,
            origamiContextTokens: origamiTokens,
            ratio: Math.round((baselineTokens / origamiTokens) * 10) / 10,
            compressionRatio: Math.round((baselineTokens / origamiTokens) * 10) / 10,
            activeFolds: activeBlocks,
            probes: probeResults
          };

          this.latestSnapshot.milestones.push(milestoneItem);
          this.broadcast("milestone_done", milestoneItem);
          this.latestSnapshot.status = "running";
        }

        working.push(entry);
        lastMessageRole = "assistant";
      }

      // Compute final summary
      let totalProbes = 0;
      let sumBaseAcc = 0;
      let sumOrigAcc = 0;
      let sumBaseTokens = 0;
      let sumOrigTokens = 0;
      let sumOrigCacheHit = 0;

      for (const m of this.latestSnapshot.milestones) {
        for (const p of m.probes) {
          totalProbes++;
          sumBaseAcc += p.baseline.score;
          sumOrigAcc += p.origami.score;
          sumBaseTokens += p.baseline.tokens;
          sumOrigTokens += p.origami.tokens;
          if (p.origami.tokens > 0) {
            sumOrigCacheHit += (p.origami.cachedTokens / p.origami.tokens);
          }
        }
      }

      this.latestSnapshot.summary = {
        model,
        totalMilestones: this.latestSnapshot.milestones.length,
        meanBaselineAcc: totalProbes > 0 ? Math.round((sumBaseAcc / totalProbes) * 1000) / 10 : 0,
        meanOrigamiAcc: totalProbes > 0 ? Math.round((sumOrigAcc / totalProbes) * 1000) / 10 : 0,
        meanBaselineTokens: Math.round(sumBaseTokens / Math.max(1, totalProbes)),
        meanOrigamiTokens: Math.round(sumOrigTokens / Math.max(1, totalProbes)),
        tokenReductionPct: sumBaseTokens > 0 ? Math.round(((sumBaseTokens - sumOrigTokens) / sumBaseTokens) * 1000) / 10 : 0,
        meanOrigamiCacheHitPct: totalProbes > 0 ? Math.round((sumOrigCacheHit / totalProbes) * 1000) / 10 : 0
      };

      this.latestSnapshot.status = "completed";
      this.broadcast("complete", this.latestSnapshot);
    } catch (err: any) {
      this.latestSnapshot.status = "error";
      this.latestSnapshot.error = err.message;
      this.broadcast("error", { message: err.message });
    } finally {
      this.isRunning = false;
    }
  }
}

const coordinator = new BenchmarkCoordinator();

// Serve the live web interface
export function startWebServer(port = PORT, autoRun = false) {
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(renderDashboardHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      if (url.pathname === "/api/benchmark/status") {
        return Response.json(coordinator.latestSnapshot);
      }

      if (url.pathname === "/api/benchmark/start" && req.method === "POST") {
        let body: any = {};
        try { body = await req.json(); } catch {}
        coordinator.start(body);
        return Response.json({ ok: true, status: "started" });
      }

      if (url.pathname === "/api/benchmark/stop" && req.method === "POST") {
        coordinator.stop();
        return Response.json({ ok: true, status: "stopped" });
      }

      if (url.pathname === "/api/benchmark/events") {
        let cleanup: (() => void) | undefined;
        let heartbeatInterval: any;

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {}
            };

            // Send initial state immediately
            send("init", coordinator.latestSnapshot);

            cleanup = coordinator.subscribe(send);

            // Keepalive heartbeat
            heartbeatInterval = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
              } catch {}
            }, 15000);
          },
          cancel() {
            if (cleanup) cleanup();
            clearInterval(heartbeatInterval);
          }
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        });
      }

      return new Response("Not Found", { status: 404 });
    }
  });

  console.log(`\n========================================================================`);
  console.log(`  ORIGAMI REAL-WORLD BENCHMARK · LIVE WEB DASHBOARD`);
  console.log(`========================================================================`);
  console.log(`  URL: http://localhost:${server.port}`);
  console.log(`  Model: nvidia/nemotron-3.5-super-vl:free (1,000,000 token context ceiling)`);
  console.log(`========================================================================\n`);

  if (autoRun) {
    coordinator.start();
  }

  return server;
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Origami Real-World Benchmark · Live Monitor</title>
  <style>
    :root {
      --bg: #090b10;
      --surface: #121620;
      --surface-hover: #181d2a;
      --card: #151924;
      --border: #232a3b;
      --border-bright: #36415a;
      --fg: #e2e8f0;
      --muted: #8b9bb4;
      --dim: #55657e;
      --accent: #00d8f6;
      --accent-glow: rgba(0, 216, 246, 0.15);
      --green: #4ee1a0;
      --green-glow: rgba(78, 225, 160, 0.15);
      --red: #ff5c77;
      --yellow: #f8c555;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --font-sans: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      min-height: 100vh;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1360px; margin: 0 auto; }
    
    /* Header */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo-pleat {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent), var(--green));
      clip-path: polygon(0% 0%, 100% 0%, 75% 100%, 25% 100%);
      border-radius: 4px;
    }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
    .badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.active { background: var(--green-glow); color: var(--green); border-color: var(--green); }
    .badge.evaluating { background: var(--accent-glow); color: var(--accent); border-color: var(--accent); }
    
    .actions { display: flex; gap: 10px; }
    button {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    button:hover { background: var(--surface-hover); border-color: var(--border-bright); }
    button.primary { background: var(--accent); color: #000; border-color: var(--accent); }
    button.primary:hover { opacity: 0.9; }
    button.danger { background: var(--surface); color: var(--red); border-color: var(--red); }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, transparent, var(--border-bright), transparent);
    }
    .kpi-title { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .kpi-val { font-size: 28px; font-weight: 700; font-family: var(--font-mono); letter-spacing: -0.03em; }
    .kpi-sub { font-size: 12px; color: var(--dim); margin-top: 6px; font-family: var(--font-mono); display: flex; justify-content: space-between; }
    .kpi-meter {
      height: 4px;
      background: var(--surface);
      border-radius: 2px;
      margin-top: 10px;
      overflow: hidden;
    }
    .kpi-meter-fill { height: 100%; background: var(--accent); transition: width 0.3s; }

    /* Charts & Block Deck */
    .panel-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .panel-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    
    /* Trajectory SVG */
    .chart-container { width: 100%; height: 200px; position: relative; }
    svg.traj-svg { width: 100%; height: 100%; overflow: visible; }
    
    /* Pagoda Blocks */
    .deck-counts { display: flex; gap: 8px; margin-bottom: 12px; }
    .tier-chip {
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
    }
    .tier-chip.t1 { border-color: rgba(0, 216, 246, 0.4); color: var(--accent); }
    .tier-chip.t2 { border-color: rgba(78, 225, 160, 0.4); color: var(--green); }
    .tier-chip.t3 { border-color: rgba(248, 197, 85, 0.4); color: var(--yellow); }
    
    .ghost-list {
      max-height: 140px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ghost-item {
      padding: 6px 10px;
      background: var(--surface);
      border-radius: 4px;
      border-left: 2px solid var(--accent);
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Milestone Cards */
    .milestones-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; }
    .milestone-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 16px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .milestone-card.evaluating { border-color: var(--accent); box-shadow: 0 0 15px var(--accent-glow); }
    .milestone-header {
      padding: 14px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .milestone-name { font-weight: 700; font-size: 14px; font-family: var(--font-mono); }
    .milestone-meta { display: flex; gap: 14px; font-size: 12px; font-family: var(--font-mono); color: var(--muted); }
    
    .probe-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      padding: 16px;
    }
    .probe-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .probe-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--fg); }
    .probe-compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .compare-box {
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--card);
      border: 1px solid var(--border);
    }
    .compare-box.origami { border-color: rgba(0, 216, 246, 0.3); }
    .compare-box.baseline { border-color: rgba(255, 92, 119, 0.3); }
    .compare-label { font-size: 10px; text-transform: uppercase; margin-bottom: 4px; display: flex; justify-content: space-between; }
    .score-pill { padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; }
    .score-pill.pass { background: rgba(78, 225, 160, 0.2); color: var(--green); }
    .score-pill.partial { background: rgba(248, 197, 85, 0.2); color: var(--yellow); }
    .score-pill.fail { background: rgba(255, 92, 119, 0.2); color: var(--red); }
    .response-snippet {
      margin-top: 6px;
      color: var(--dim);
      font-size: 10px;
      line-height: 1.4;
      max-height: 40px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="logo-pleat"></div>
        <div>
          <h1>Origami Real-World Benchmark <span class="badge" id="status-badge">Idle</span></h1>
          <div style="font-size: 12px; color: var(--muted); font-family: var(--font-mono); margin-top: 2px;">
            Target: <span style="color: var(--accent)" id="model-name">nvidia/nemotron-3.5-super-vl:free</span> · Window: 1,000,000t
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="btn-start" onclick="startBenchmark()">Start Benchmark</button>
        <button class="danger" id="btn-stop" onclick="stopBenchmark()">Stop</button>
      </div>
    </header>

    <!-- KPI Strip -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-title">Context Compression</div>
        <div class="kpi-val" style="color: var(--accent)" id="kpi-ratio">1.0x</div>
        <div class="kpi-sub">
          <span>Origami: <b id="kpi-orig-tok">0</b>t</span>
          <span>Base: <b id="kpi-base-tok">0</b>t</span>
        </div>
        <div class="kpi-meter"><div class="kpi-meter-fill" id="kpi-meter-comp" style="width: 10%"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Fact Retention Delta</div>
        <div class="kpi-val" style="color: var(--green)" id="kpi-acc">0%</div>
        <div class="kpi-sub">
          <span>Origami: <b id="kpi-orig-acc">0%</b></span>
          <span>Base: <b id="kpi-base-acc">0%</b></span>
        </div>
        <div class="kpi-meter"><div class="kpi-meter-fill" id="kpi-meter-acc" style="width: 0%; background: var(--green)"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Prompt Cache Hit Rate</div>
        <div class="kpi-val" style="color: var(--yellow)" id="kpi-cache">0.0%</div>
        <div class="kpi-sub">
          <span>Cached: <b id="kpi-cached-tok">0</b>t</span>
          <span>Model: Nemotron 3.5</span>
        </div>
        <div class="kpi-meter"><div class="kpi-meter-fill" id="kpi-meter-cache" style="width: 0%; background: var(--yellow)"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Token Savings & Cost</div>
        <div class="kpi-val" style="color: var(--green)" id="kpi-saved">0.0%</div>
        <div class="kpi-sub">
          <span>Total Cost: <b>$0.00</b> (FREE)</span>
          <span>Window Cap: 1.0M</span>
        </div>
        <div class="kpi-meter"><div class="kpi-meter-fill" id="kpi-meter-saved" style="width: 0%; background: var(--green)"></div></div>
      </div>
    </div>

    <!-- Dual Trajectory & Pagoda Deck -->
    <div class="panel-grid">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Context Growth Trajectory (Baseline vs Bounded Origami)</div>
          <div style="font-family: var(--font-mono); font-size: 11px; color: var(--muted)">
            <span style="color: var(--red)">■</span> Baseline (Uncompressed) &nbsp;
            <span style="color: var(--accent)">■</span> Origami Pagoda
          </div>
        </div>
        <div class="chart-container">
          <svg class="traj-svg" id="traj-svg" viewBox="0 0 800 200" preserveAspectRatio="none">
            <line x1="0" y1="190" x2="800" y2="190" stroke="#232a3b" stroke-width="1" />
            <path id="path-baseline" d="M 0 190" fill="none" stroke="var(--red)" stroke-width="2" />
            <path id="path-origami" d="M 0 190" fill="none" stroke="var(--accent)" stroke-width="2" />
          </svg>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Pagoda Tiers & JIT Hydration</div>
          <div style="font-size: 11px; font-family: var(--font-mono); color: var(--dim)">Hierarchy</div>
        </div>
        <div class="deck-counts">
          <div class="tier-chip t1" id="chip-t1">T1: 0</div>
          <div class="tier-chip t2" id="chip-t2">T2: 0</div>
          <div class="tier-chip t3" id="chip-t3">T3: 0</div>
        </div>
        <div class="ghost-list" id="ghost-list">
          <div class="ghost-item">Awaiting active pagoda blocks...</div>
        </div>
      </div>
    </div>

    <!-- Milestones & Probe Stream -->
    <div class="milestones-title">Progressive Milestone Needle Probes</div>
    <div id="milestones-container">
      <!-- Injected live via SSE -->
    </div>
  </div>

  <script>
    let evtSource = null;
    let trajectoryData = [];
    let liveProbes = [];

    function connectSSE() {
      if (evtSource) evtSource.close();
      evtSource = new EventSource('/api/benchmark/events');

      evtSource.addEventListener('init', (e) => {
        const d = JSON.parse(e.data);
        updateState(d);
      });

      evtSource.addEventListener('start', (e) => {
        const d = JSON.parse(e.data);
        updateState(d);
        document.getElementById('milestones-container').innerHTML = '';
        trajectoryData = [];
        liveProbes = [];
      });

      evtSource.addEventListener('tick', (e) => {
        const d = JSON.parse(e.data);
        if (d.ratio != null) document.getElementById('kpi-ratio').textContent = Number(d.ratio).toFixed(1) + 'x';
        if (d.origami != null) document.getElementById('kpi-orig-tok').textContent = Number(d.origami).toLocaleString();
        if (d.baseline != null) document.getElementById('kpi-base-tok').textContent = Number(d.baseline).toLocaleString();
        
        trajectoryData.push(d);
        drawTrajectory(trajectoryData);

        if (d.baseline && d.origami) {
          const savedPct = Math.max(0, Math.round((1 - (d.origami / d.baseline)) * 100));
          document.getElementById('kpi-saved').textContent = savedPct + '%';
          document.getElementById('kpi-meter-saved').style.width = savedPct + '%';
        }

        if (d.blocks) {
          document.getElementById('chip-t1').textContent = 'T1: ' + (d.blocks.t1 ?? 0);
          document.getElementById('chip-t2').textContent = 'T2: ' + (d.blocks.t2 ?? 0);
          document.getElementById('chip-t3').textContent = 'T3: ' + (d.blocks.t3 ?? 0);
        }
      });

      evtSource.addEventListener('milestone_start', (e) => {
        const d = JSON.parse(e.data);
        ensureMilestoneCard(d);
      });

      evtSource.addEventListener('probe_evaluating', (e) => {
        const d = JSON.parse(e.data);
        const badge = document.getElementById('status-badge');
        if (badge) {
          badge.textContent = 'Evaluating: ' + (d.probeName || d.probeId);
          badge.className = 'badge evaluating';
        }
      });

      evtSource.addEventListener('probe_done', (e) => {
        const d = JSON.parse(e.data);
        renderProbeCard(d.milestoneIndex, d.probe);
        if (d.probe) {
          liveProbes.push(d.probe);
          updateLiveMetrics();
        }
      });

      evtSource.addEventListener('milestone_done', (e) => {
        const d = JSON.parse(e.data);
        updateMilestoneHeader(d);
      });

      evtSource.addEventListener('complete', (e) => {
        const d = JSON.parse(e.data);
        updateState(d);
      });
    }

    function updateLiveMetrics() {
      if (!liveProbes.length) return;
      let sumOrigScore = 0, sumBaseScore = 0, totalOrigTokens = 0, totalOrigCached = 0;
      for (const p of liveProbes) {
        sumOrigScore += p.origami?.score ?? 0;
        sumBaseScore += p.baseline?.score ?? 0;
        totalOrigTokens += p.origami?.tokens ?? 0;
        totalOrigCached += p.origami?.cachedTokens ?? 0;
      }
      const count = liveProbes.length;
      const meanOrigAcc = Math.round((sumOrigScore / count) * 100);
      const meanBaseAcc = Math.round((sumBaseScore / count) * 100);
      const delta = meanOrigAcc - meanBaseAcc;

      document.getElementById('kpi-orig-acc').textContent = meanOrigAcc + '%';
      document.getElementById('kpi-base-acc').textContent = meanBaseAcc + '%';
      document.getElementById('kpi-acc').textContent = (delta >= 0 ? '+' : '') + delta + '%';
      document.getElementById('kpi-meter-acc').style.width = meanOrigAcc + '%';

      const totalCacheBasis = totalOrigTokens + totalOrigCached;
      const cacheHitPct = totalCacheBasis > 0 ? Math.round((totalOrigCached / totalCacheBasis) * 100) : 0;
      document.getElementById('kpi-cache').textContent = cacheHitPct + '%';
      document.getElementById('kpi-meter-cache').style.width = cacheHitPct + '%';
    }

    function updateState(d) {
      if (!d) return;
      const badge = document.getElementById('status-badge');
      if (badge && d.status) {
        badge.textContent = d.status;
        badge.className = 'badge ' + (d.status === 'running' ? 'active' : (d.status === 'evaluating_probes' ? 'evaluating' : ''));
      }

      if (d.model) document.getElementById('model-name').textContent = d.model;
      if (d.compressionRatio != null) document.getElementById('kpi-ratio').textContent = Number(d.compressionRatio).toFixed(1) + 'x';
      if (d.origamiTokens != null) document.getElementById('kpi-orig-tok').textContent = Number(d.origamiTokens).toLocaleString();
      if (d.baselineTokens != null) document.getElementById('kpi-base-tok').textContent = Number(d.baselineTokens).toLocaleString();

      if (d.trajectory && d.trajectory.length > 0) {
        trajectoryData = d.trajectory;
        drawTrajectory(trajectoryData);
      }

      if (d.baselineTokens && d.origamiTokens) {
        const savedPct = Math.max(0, Math.round((1 - (d.origamiTokens / d.baselineTokens)) * 100));
        document.getElementById('kpi-saved').textContent = savedPct + '%';
        document.getElementById('kpi-meter-saved').style.width = savedPct + '%';
      }

      if (d.ghostPointers && d.ghostPointers.length > 0) {
        const list = document.getElementById('ghost-list');
        list.innerHTML = d.ghostPointers.map(g => '<div class="ghost-item">' + escapeHtml(g) + '</div>').join('');
      }

      if (d.activeBlocks) {
        document.getElementById('chip-t1').textContent = 'T1: ' + (d.activeBlocks.t1 ?? 0);
        document.getElementById('chip-t2').textContent = 'T2: ' + (d.activeBlocks.t2 ?? 0);
        document.getElementById('chip-t3').textContent = 'T3: ' + (d.activeBlocks.t3 ?? 0);
      }

      if (d.milestones) {
        liveProbes = [];
        for (const m of d.milestones) {
          ensureMilestoneCard(m);
          updateMilestoneHeader(m);
          for (const p of (m.probes || [])) {
            liveProbes.push(p);
            renderProbeCard(m.milestoneIndex ?? m.requestIndex, p);
          }
        }
        updateLiveMetrics();
      }
    }

    function drawTrajectory(data) {
      if (!data || data.length < 2) return;
      const W = 800;
      const H = 200;
      const maxTurn = 327;
      let maxVal = 0;
      for (const d of data) {
        maxVal = Math.max(maxVal, d.raw ?? 0, d.baseline ?? 0, d.origami ?? 0);
      }
      maxVal = Math.max(maxVal, 50000);

      const toX = (t) => Math.round((t / maxTurn) * W);
      const toY = (v) => Math.round(H - (v / maxVal) * 170 - 15);

      let dBase = 'M ' + toX(data[0].turn) + ' ' + toY(data[0].baseline);
      let dOrig = 'M ' + toX(data[0].turn) + ' ' + toY(data[0].origami);

      for (let i = 1; i < data.length; i++) {
        dBase += ' L ' + toX(data[i].turn) + ' ' + toY(data[i].baseline);
        dOrig += ' L ' + toX(data[i].turn) + ' ' + toY(data[i].origami);
      }

      const pBase = document.getElementById('path-baseline');
      const pOrig = document.getElementById('path-origami');
      if (pBase) pBase.setAttribute('d', dBase);
      if (pOrig) pOrig.setAttribute('d', dOrig);
    }

    function ensureMilestoneCard(m) {
      const idx = m.milestoneIndex ?? m.requestIndex ?? '?';
      const id = 'm-' + idx;
      let card = document.getElementById(id);
      if (!card) {
        card = document.createElement('div');
        card.id = id;
        card.className = 'milestone-card evaluating';
        const raw = Number(m.rawTokens ?? m.rawCumulativeTokens ?? 0).toLocaleString();
        const base = Number(m.baselineTokens ?? m.baselineContextTokens ?? 0).toLocaleString();
        const orig = Number(m.origamiTokens ?? m.origamiContextTokens ?? 0).toLocaleString();
        const ratio = Number(m.ratio ?? m.compressionRatio ?? 1).toFixed(1);
        card.innerHTML = 
          '<div class="milestone-header">' +
            '<div class="milestone-name">Milestone: Request #' + idx + '</div>' +
            '<div class="milestone-meta">' +
              '<span>Raw: ' + raw + 't</span>' +
              '<span>Base: ' + base + 't</span>' +
              '<span style="color: var(--accent)">Origami: ' + orig + 't (' + ratio + 'x)</span>' +
            '</div>' +
          '</div>' +
          '<div class="probe-grid" id="' + id + '-probes"></div>';
        document.getElementById('milestones-container').appendChild(card);
      }
    }

    function updateMilestoneHeader(m) {
      const idx = m.milestoneIndex ?? m.requestIndex;
      const id = 'm-' + idx;
      const card = document.getElementById(id);
      if (card) {
        card.className = 'milestone-card';
      }
    }

    function renderProbeCard(mIndex, probe) {
      const grid = document.getElementById('m-' + mIndex + '-probes');
      if (!grid) return;

      const pId = 'p-' + mIndex + '-' + probe.probeId;
      let el = document.getElementById(pId);
      if (!el) {
        el = document.createElement('div');
        el.id = pId;
        el.className = 'probe-card';
        grid.appendChild(el);
      }

      const getPill = (score) => {
        if (score >= 1) return '<span class="score-pill pass">100% PASS</span>';
        if (score > 0) return '<span class="score-pill partial">50% PARTIAL</span>';
        return '<span class="score-pill fail">0% FAIL</span>';
      };

      el.innerHTML = 
        '<div class="probe-title">' + escapeHtml(probe.probeName) + '</div>' +
        '<div class="probe-compare">' +
          '<div class="compare-box origami">' +
            '<div class="compare-label"><span style="color: var(--accent)">Origami</span>' + getPill(probe.origami.score) + '</div>' +
            '<div>Latency: ' + probe.origami.latencyMs + 'ms</div>' +
            '<div class="response-snippet">"' + escapeHtml(probe.origami.responsePreview) + '..."</div>' +
          '</div>' +
          '<div class="compare-box baseline">' +
            '<div class="compare-label"><span style="color: var(--red)">Baseline</span>' + getPill(probe.baseline.score) + '</div>' +
            '<div>Latency: ' + probe.baseline.latencyMs + 'ms</div>' +
            '<div class="response-snippet">"' + escapeHtml(probe.baseline.responsePreview) + '..."</div>' +
          '</div>' +
        '</div>';
    }

    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function startBenchmark() {
      await fetch('/api/benchmark/start', { method: 'POST' });
    }

    async function stopBenchmark() {
      await fetch('/api/benchmark/stop', { method: 'POST' });
    }

    // Connect SSE on load
    connectSSE();
  </script>
</body>
</html>`;
}

if (import.meta.main) {
  const autoRun = process.argv.includes("--run");
  startWebServer(PORT, autoRun);
}
