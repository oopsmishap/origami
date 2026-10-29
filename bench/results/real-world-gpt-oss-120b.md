# Origami Real-World Context Benchmark Report

**Model**: `openai/gpt-oss-120b`  
**Session Journal**: `C:/Users/mishap/.omp/agent/sessions/--H--projects-_mishap_-origami--/2026-10-28T18-40-20-551Z_01a183d0-2c47-752f-8671-8ee42d97abc3.jsonl`  
**Preset**: `balanced`  
**Context Window Ceiling**: `131,072` tokens  

---

## Executive Summary

| Metric | Baseline (Sliding Window) | Origami (Hierarchical Compaction) | Delta / Improvement |
|---|---|---|---|
| **Fact Retention / Needle Recall** | 87.5% | **75%** | **+-12.5%** |
| **Mean Prompt Context Size** | 80,508 tokens | **24,342 tokens** | **69.8% reduction** |
| **Total Inference Cost** | $0.0076 | **$0.0035** | **53.5% cost saved** |
| **Prompt Cache Hit Rate** | N/A | **0.1%** | Consistent prefix reuse |

---

## Milestone Progression

| Request Index | Raw Session Tokens | Baseline Tokens | Origami Tokens | Compression Ratio | Baseline Acc | Origami Acc | Baseline Cost ($) | Origami Cost ($) | Cost Saved (%) |
|---|---|---|---|---|---|---|---|---|---|
| Req #40 | 43,261 | 43,202 | 14,937 | 2.9x | 88% | **75%** | $0.00757 | **$0.00352** | **53.5%** |

---

## Detailed Probe Breakdowns

### Milestone Request #40 (43,261 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 100% | Latency: 8066ms | Cost: $0.002430
- **Origami Score**: **100%** | Latency: 12418ms | Cost: **$0.000839**
- **Baseline Response**: "We need to answer: "What specific GitHub repository and organization was Origami instructed to be pushed to, and what was the strict rule specified re..."
- **Origami Response**: "**GitHub destination**  - **Organization:** `oh‑my‑pi`   - **Repository:** `github.com/oh‑my‑pi/origami` (the *origami* project lives under the `oh‑my..."

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 100% | Latency: 19179ms | Cost: $0.002532
- **Origami Score**: **100%** | Latency: 15005ms | Cost: **$0.000992**
- **Baseline Response**: "**The bug** – The Web UI’s “Context Occupancy” indicator showed absurd values such as **900 %** or **1100 %** (e.g. “237 / 1.0 M tokens”). The numbers..."
- **Origami Response**: "**What the bug was**  The Web UI’s “WINDOW OCCUPANCY” display was showing absurd numbers like **900 %** or **1100 %** even though the engine’s `occupa..."

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 100% | Latency: 18694ms | Cost: $0.001328
- **Origami Score**: **50%** | Latency: 17892ms | Cost: **$0.000850**
- **Baseline Response**: "**Visualization that was port‑ported**  The *“context‑window‑over‑time”* trajectory that lives in `../../_public_/billion‑context` – a two‑panel chart..."
- **Origami Response**: "**Visualization that was port‑ported**  The *“context‑window‑over‑time”* trajectory chart that lives in **`../../_public_/billion‑context`** – the sam..."

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 50% | Latency: 11541ms | Cost: $0.001281
- **Origami Score**: **50%** | Latency: 15720ms | Cost: **$0.000839**
- **Baseline Response**: "The transcript contains **no explicit instruction from the user** about how Origami’s branding, logos, or social‑media references should (or should no..."
- **Origami Response**: "The user never gave a direct, explicit command about how **Origami’s branding, logos, or social links should (or shouldn’t) reference “omp” or “tern.”..."

