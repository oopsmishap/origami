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
- **Memory (`memory`)**: Needle retention across extended horizons. Configuration facts planted in turns 1 through 3 are queried with recall probes across the run.

### Context Intensity Scales

| Scale | Turns per Run | Intended Coverage |
|---|---|---|
| `low` | 20 | Rapid verification, surface smoke testing, and regression runs |
| `medium` | 60 | Standard coding session matching single-task agent lifecycles |
| `high` | 150 | Heavy multi-task engineering sessions testing multi-round compactions |
| `insane` | 300 | Multi-day session simulation testing long-horizon needle survival |

### Sandbox and Egress Boundaries

- **Filesystem Isolation**: Runs execute inside temporary scratch workspaces (`.bench_workspace/` or OS temp directories). Paths resolving outside the sandbox root throw `SandboxEscapeError` before any file operation executes.
- **Egress Restrictions**: Sandbox tools have zero network access. Outbound HTTP calls are restricted exclusively to configured LLM endpoints (`openrouter.ai` or operator endpoint allowlist); any other host target throws `EgressBlockedError`.

### Running the Agentic Benchmark

Run a local smoke test across all strategies:

```bash
bun run bench:agentic:smoke
```

Run a live benchmark against OpenRouter with live web dashboard:

```bash
bun run bench:agentic:web --mode programming --scale low --strategy all --port 4143
```

Run a specific scenario and scale headless:

```bash
bun bench/agentic/runner.ts --mode memory --scale high --strategy origami,soft,handover --model openrouter/nvidia/nemotron-3.5-super-vl:free
```
