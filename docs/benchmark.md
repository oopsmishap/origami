# Real-World Long-Context Benchmark

Empirical evaluation of Origami's hierarchical folding and reactive hydration against an uncompressed baseline on a real coding session transcript.

## Overview

Most long-context benchmarks use artificial synthetic needles inserted into synthetic filler text. This benchmark evaluates real software engineering history: an authentic 327-request session spanning 444,890 context tokens from an autonomous software engineering run.

We evaluated two context strategies side by side on identical turns:

1. **Baseline**: Uncompressed sliding window context retaining raw conversation turns up to the model context limit.
2. **Origami**: Autonomous hierarchical folding (`balanced` preset) with bounded pinned ledger extraction, pagoda block trees, and just-in-time reactive hydration.

Both tracks were evaluated on `openrouter/nvidia/nemotron-3.5-super-vl:free`, an open-weights model with a 1,000,000 token context window.

---

## Benchmark Setup

- **Model**: `nvidia/nemotron-3.5-super-vl:free` (1,000,000 token context ceiling)
- **Session Journal**: Real autonomous engineering session (`2026-10-28T18-40`, 327 turns)
- **Preset**: `balanced` (`growthStep`: 50,000 tokens, `compressibleFloor`: 8,000 tokens)
- **Probes**: Four factual architectural needles planted early in the session (turns 1 to 20):
  1. `repo-and-tools`: Target GitHub repository name and rule prohibiting inclusion of the `tools/` directory.
  2. `telemetry-bug`: Root cause and arithmetic fix for the Web UI 900%/1100% occupancy bug.
  3. `trajectory-port`: Visualization ported from `billion-context` and how trajectory bars were bounded and scaled.
  4. `agent-neutrality`: User instruction on brand neutrality and avoiding agent-specific naming.
- **Evaluation Points**: Milestones evaluated at Request #40, #100, #200, and #300.
- **Scoring**: Exact factual criteria (1.0 = full recall of facts, 0.5 = partial recall, 0.0 = missed or timed out).

---

## Results Summary

| Metric | Baseline (Sliding Window) | Origami (Hierarchical Compaction) | Delta |
|---|---|---|---|
| Mean Needle Recall | 68.8% | 84.4% | +15.6% |
| Recall at >400K Tokens (Req #300) | 0.0% (attention loss / timeout) | 62.5% | +62.5% |
| Mean Prompt Tokens per Query | 356,446 tokens | 124,834 tokens | 65.0% reduction |
| Final Context Size (Turn 327) | 444,890 tokens | 63,755 tokens | 7.0× compression |
| Origami Prompt Cache Hit Rate | N/A | 71.5% | Prefix preserved |

---

## Milestone Progression

| Milestone | Raw Tokens | Baseline Tokens | Origami Tokens | Compression | Baseline Acc | Origami Acc | Delta | Origami Cache Hit |
|---|---|---|---|---|---|---|---|---|
| Req #40 | 43,261 | 43,183 | 14,885 | 2.9× | 87.5% | 87.5% | +0.0% | 95.3% |
| Req #100 | 168,515 | 167,408 | 27,903 | 6.0× | 87.5% | 87.5% | +0.0% | 92.8% |
| Req #200 | 310,311 | 315,779 | 96,003 | 3.3× | 87.5% | 100.0% | +12.5% | 98.0% |
| Req #300 | 415,778 | 424,024 | 122,000 | 3.5× | 0.0% | 62.5% | +62.5% | 0.0% (eviction) |

At turn 327 (session completion), Origami held context to 63,755 tokens across 10 active Tier 1 blocks, compared to 444,890 uncompressed tokens in the baseline.

---

## Key Findings

### 1. Attention Preservation at Scale

In early and mid-session milestones (Requests #40 through #200, spanning 43K to 315K tokens), both systems recalled architectural facts accurately. However, at Request #300 (424K baseline tokens), the baseline model failed all four probes due to attention dilution and prompt latency timeouts.

Origami retained needle recall at Request #300. Reactive hydration matches current turn topics against block manifests and surfaces relevant decisions and ghost pointers in an ephemeral tail block, bypassing deep context degradation.

### 2. Context Bounding and Token Reduction

The baseline prompt grew monotonically with each request, reaching 444,890 tokens by the final turn. Origami's growth step triggers folded completed turns into compact blocks, stabilizing working context between 14K and 122K tokens. Across the entire run, Origami reduced total input prompt volume by 65.0%.

### 3. Prompt Cache Stability

During probe execution, Origami achieved a 71.5% mean prompt cache hit rate across query evaluations. Because historical blocks form an immutable prefix at the head of the context, provider KV caches stay valid across successive turns. The only cache miss occurred at Request #300 after a network eviction boundary.

### 4. Query Latency

| Milestone | Baseline Mean Latency | Origami Mean Latency | Speedup |
|---|---|---|---|
| Req #40 (43K tokens) | 9,244 ms | 6,246 ms | 1.48× |
| Req #100 (168K tokens) | 4,259 ms | 3,187 ms | 1.34× |
| Req #200 (315K tokens) | 7,260 ms | 3,991 ms | 1.82× |
| Req #300 (424K tokens) | Timed out (>30s) | 17,508 ms | Baseline failed |

Origami showed lower latency across all milestones because the model processed smaller input prefixes.

---

## Cross-Model Comparison

We evaluated the benchmark harness across three model families on OpenRouter:

| Model | Context Window | Status | Findings |
|---|---|---|---|
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | Complete | Full 327-turn run. Origami delivered +15.6% recall delta and 7.0× compression. |
| `recursive/flint-v1.0:free` | 262,144 | Milestone 40 Verified | Fast inference. Reached 2.9× compression at Req #40 with identical 87.5% recall. Context window saturates before turn 150 without folding. |
| `openai/gpt-oss-120b:free` | Variable | Replaced | Required paid credits despite `:free` tag; swapped for verified free endpoints. |

---

## Reproducing the Benchmark

Start the benchmark web server:

```bash
bun bench/web-server.ts --port 4142
```

Open `http://localhost:4142` in your browser to inspect live trajectory curves, active pagoda blocks, and probe evaluations in real time.

To run headless from the terminal:

```bash
bun bench/real-world.ts --model nvidia/nemotron-3.5-super-vl:free --preset balanced
```

---

## Multi-Strategy Agentic Benchmark Suite

The agentic benchmark harness (`bench/agentic/runner.ts`) evaluates context compaction strategies inside an egress-guarded sandbox running realistic autonomous multi-turn tasks.

### Compaction Strategies

1. **Origami (`origami`)**: Hierarchical pagoda folding with monotonic prefix retention, bounded pinned ledgers, and just-in-time reactive tail hydration.
2. **Soft Compaction (`soft`)**: Periodic full-history summarization replacing older turns with a synthesized Markdown brief (`omp /compact soft`, Claude Code).
3. **Handover (`handover`)**: Structured state transfer document capturing decisions, files, and next actions while clearing prior conversation history (`omp /handoff`, Devin, SWE-agent).
4. **Shake (`shake`)**: Observation elision replacing bulky file contents and tool outputs with truncation markers while leaving user/assistant dialog intact (`omp /shake`, SWE-Pruner).
5. **Sliding Window (`sliding-window`)**: Standard FIFO truncation dropping oldest turns when approaching the context boundary.

### Evaluation Modes

- **Programming (`programming`)**: Builds a playable HTML5 Canvas Pac-Man arcade game in `game.js`, `index.html`, and `style.css`. Rubric verifies 15 functional criteria including maze rendering, directional controls, four ghost AI algorithms (Blinky, Pinky, Inky, Clyde), pellets, power pellets with frightened mode, score tracking, local storage persistence, sound effects, and game over states.
- **Research (`research`)**: Conducts a security vulnerability audit across seeded repository code (`src/db/users.js`, `src/api/files.js`, `src/utils/media.js`, `src/config/auth.js`, `src/api/comments.js`, `src/api/orders.js`). Rubric checks `AUDIT_REPORT.md` for detection of SQL injection, path traversal, command injection, hardcoded credentials, stored XSS, and broken object authorization.
- **General (`general`)**: Sustained development session building a matrix math library (`src/matrix.ts`), updating architectural specifications (`docs/ARCHITECTURE.md`), and authoring unit tests (`tests/matrix.test.ts`).
- **Memory (`memory`)**: Stratified deep-horizon and temporal-override needle retention under sustained engineering load. Needles are never planted on Turn 1 (preventing head-pinning freebies), enforce a $\ge 45\%$ session-length lag before probing, keep secrets strictly out of workspace files, and mix static operational facts (75%) with superseded policy overrides (25%).
- **All (`all`)**: Full-spectrum multi-phase session combining `programming`, `research`, `general`, and `memory` across a single continuous run.

Every turn across every mode and scale generates a **unique, non-repeating engineering deliverable** (distinct module, stage, security control, numerical algorithm, test suite, or RFC), preventing models from short-circuiting repeated prompts.

### Task Rubric vs Probe Recall

The two headline columns measure different things and are never merged:

- **Task Rubric** scores what the run *shipped* into the sandbox. In `memory` (and the memory slice of `all`) this is scale-aware: platform modules, unit tests, domain barrel exports (`src/**/index.ts` with re-exports), and operational runbooks are checked against the deliverables actually scheduled at the chosen scale (unscheduled kinds report `unavailable`, excluded from the score), plus a **zero-leaked-secrets scan** asserting no session-only needle value ever landed in a workspace file.
- **Probe Recall** scores the stratified deep-horizon and override needles only, using `evaluateProbeAnswer` (stale-value and hedged-answer rejection).

### Context Intensity Scales & Stratified Needle Counts

| Scale | Turns per Run | Needles (`memory` / `all`) | Domain Probes (`programming` / `research` / `general`) | Intended Coverage |
|---|---:|---:|---:|---|
| `low` | 20 | 4 (1 override) | 2 | Rapid verification, surface smoke testing, and regression runs |
| `medium` | 60 | 8 (2 overrides) | 4 | Standard coding session matching single-task agent lifecycles |
| `high` | 150 | 14 (3 overrides) | 6 | Heavy multi-task engineering sessions testing multi-round compactions |
| `insane` | 300 | 20 (5 overrides) | 10 | Multi-day session simulation testing long-horizon needle survival |
| `marathon` | 1500 | 32 (8 overrides) | 16 | Extreme 1,500-turn stress run testing multi-tier Pagoda consolidation (`T1 → T2 → T3`) |
### Runtime Architecture and Boundaries

- **Model and Agent Loop Orchestration**: Multi-step tool execution, retries, and schema validation are driven by the Vercel AI SDK Core (`generateText`, `stopWhen`, `prepareStep`) with `zod` parameter schemas.
- **Filesystem Isolation**: Runs execute inside temporary scratch workspaces (`.bench_workspace/` or OS temp directories). Paths resolving outside the sandbox root throw `SandboxEscapeError` before any file operation executes.
- **Egress Restrictions**: Sandbox tools have zero network access. The only model transport is the configured Ollama host (`OLLAMA_HOST`, default `http://127.0.0.1:11434`).
### Modeled Cost and Cache Telemetry

Ollama reports prompt and completion token counts but does not expose provider billing or prompt-cache read/write counts. The agentic benchmark therefore models each live Ollama run against the **GPT-5.6 Sol Standard** profile; these values are estimates, not an Ollama invoice:

| Input category | Rate per 1M tokens |
|---|---:|
| Uncached input (≤272K prompt) | $4.00 |
| Cache read (≤272K prompt) | $0.40 |
| 30-minute cache write (≤272K prompt) | $5.00 |
| Output (≤272K prompt) | $20.00 |

For prompts above 272K tokens, the modeled rates are $8.00 input, $0.80 cache read, $10.00 cache write, and $30.00 output per million tokens. The simulator treats a stable prefix of at least 1,024 tokens as a cache read; newly eligible prompt tokens are cache writes. Prefixes are compared across actual requests in the run, including tool-result rounds, so the estimate reflects real benchmark work rather than a fixed cache percentage.

The profile follows the published GPT-5.6 pricing and prompt-caching behavior: [pricing](https://developers.openai.com/api/docs/pricing) and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
For `lfm3:*` models, the adapter preserves Ollama's native `thinking` field in assistant history. The benchmark does not replay reasoning as ordinary assistant text: late-context probes showed that plain replay inflated a 22,040-token native prompt to 108,045 tokens and caused LFM3 to spend the full output budget without a tool call, while native thinking still recalled a marker and emitted tools. Ollama's `prompt_eval_count` does not include the native thinking field, so benchmark context telemetry also reports a local logical outbound estimate that includes reasoning; provider prompt and billing counters remain the raw Ollama values.
If LFM3 returns an empty assistant response whose native thinking contains unparsed `<tool_call>`, `<function>`, or `<parameter>` markup, the adapter retries that same request once with thinking disabled so the action can be emitted through Ollama's native tool channel. The malformed thought is discarded rather than parsed or replayed as assistant content.
The default model is `gemma4:latest` (E4B), with a 131,072-token context window sent to Ollama as `num_ctx`. The benchmark uses temperature `1.0`, top-p `0.95`, top-k `64`, and native Ollama thinking (`think: true`); Ollama's Gemma renderer handles the thinking control tokens. Generated thoughts remain visible in the transcript but are not replayed in later requests, including tool-result rounds. The text-only benchmark does not send image or audio inputs.

LFM3 defaults to a 220,000-token effective window (below its 262,144-token Ollama ceiling). Gemma 4 and LFM3 have no benchmark-imposed output cap; other models default to 4,096 tokens. Use `--max-tokens <tokens>` to set Ollama's `num_predict` and `--window <tokens>` to override the effective context window.

At 80% of the configured window, the runner requests strategy-specific maintenance before model requests and after turns, using the estimated outbound history and the latest provider-reported prompt count. Origami folds eligible completed ranges; soft and handover summarize or hand off; shake prunes eligible observations; sliding-window truncates older history. Maintenance cannot always reclaim space, for example when all history is protected or there are no eligible tool outputs. `--compact-every <n>` additionally requests maintenance every N turns.

Each strategy also uses a `max(10,000, window - 8,000)` estimated-token outbound guard. Counts are character-based estimates, not model tokenization; the guard can retain an oversized indivisible message, so it is not a guaranteed provider limit. Tool-call/result pairs are sanitized when history is trimmed. Ollama's reported prompt count is recorded separately.

### Running the Agentic Benchmark

Run a local smoke test across all strategies:

```bash
bun run bench:agentic:smoke
```

Run a live Ollama benchmark with the modeled GPT-5.6 Sol billing profile and live web dashboard:

```bash
bun run bench:agentic:web --mode programming --scale low --strategy all --model gemma4:latest --pricing-model gpt-5.6-sol --port 4143
```

Run a specific scenario and scale headless:

```bash
bun bench/agentic/runner.ts --mode memory --scale high --strategy origami --model gemma4:latest --pricing-model gpt-5.6-sol
```
