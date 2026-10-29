# Origami Real-World Context Benchmark Report

**Model**: `recursive/flint-v1.0:free`  
**Session Journal**: `C:/Users/mishap/.omp/agent/sessions/--H--projects-_mishap_-origami--/2026-10-28T18-40-20-551Z_01a183d0-2c47-752f-8671-8ee42d97abc3.jsonl`  
**Preset**: `balanced`  
**Context Window Ceiling**: `262,144` tokens  

---

## Executive Summary

| Metric | Baseline (Sliding Window) | Origami (Hierarchical Compaction) | Delta / Improvement |
|---|---|---|---|
| **Fact Retention / Needle Recall** | 87.5% | **87.5%** | **+0.0%** |
| **Mean Prompt Context Size** | 76,011 tokens | **22,885 tokens** | **69.9% reduction** |
| **Total Inference Cost** | $0.0000 | **$0.0000** | **0% cost saved** |
| **Prompt Cache Hit Rate** | N/A | **74.7%** | Consistent prefix reuse |

---

## Milestone Progression

| Request Index | Raw Session Tokens | Baseline Tokens | Origami Tokens | Compression Ratio | Baseline Acc | Origami Acc | Baseline Cost ($) | Origami Cost ($) | Cost Saved (%) |
|---|---|---|---|---|---|---|---|---|---|
| Req #40 | 43,261 | 43,202 | 14,937 | 2.9x | 88% | **88%** | $0.00000 | **$0.00000** | **0.0%** |

---

## Detailed Probe Breakdowns

### Milestone Request #40 (43,261 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 100% | Latency: 7268ms | Cost: $0.000000
- **Origami Score**: **100%** | Latency: 5435ms | Cost: **$0.000000**
- **Baseline Response**: "We need answer user. Need parse. We are in long session transcript. User final asks: "What specific GitHub repository and organization was Origami ins..."
- **Origami Response**: "We need answer user. Need parse conversation. They ask: "What specific GitHub repository and organization was Origami instructed to be pushed to, and ..."

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 100% | Latency: 6048ms | Cost: $0.000000
- **Origami Score**: **100%** | Latency: 5533ms | Cost: **$0.000000**
- **Baseline Response**: "We need answer user. We need parse current conversation. They ask: "What issue was reported with the Web UI displaying 900% or 1100% context occupancy..."
- **Origami Response**: "We need answer based session. Need parse. User asks: "What issue was reported with the Web UI displaying 900% or 1100% context occupancy, and how was ..."

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 100% | Latency: 6761ms | Cost: $0.000000
- **Origami Score**: **100%** | Latency: 5366ms | Cost: **$0.000000**
- **Baseline Response**: "We need answer user question. Need parse current conversation context. We need answer accurately based on session facts/constraints/decisions. We have..."
- **Origami Response**: "Let me understand the conversation. The user is asking: "What visualization was ported from billion-context into Origami's TUI and WebUI, and how were..."

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 50% | Latency: 6650ms | Cost: $0.000000
- **Origami Score**: **50%** | Latency: 8799ms | Cost: **$0.000000**
- **Baseline Response**: "We need answer user. We need parse. They ask: "What explicit instructions did the user give regarding whether Origami branding, logos, and socials sho..."
- **Origami Response**: "We need answer user. Need parse context. They ask: "What explicit instructions did the user give regarding whether Origami branding, logos, and social..."

