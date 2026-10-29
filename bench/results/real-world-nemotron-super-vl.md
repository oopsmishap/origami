# Origami Real-World Context Benchmark Report

**Model**: `nvidia/nemotron-3.5-super-vl:free`  
**Session Journal**: `C:/Users/mishap/.omp/agent/sessions/--H--projects-_mishap_-origami--/2026-10-28T18-40-20-551Z_01a183d0-2c47-752f-8671-8ee42d97abc3.jsonl`  
**Preset**: `balanced`  
**Context Window Ceiling**: `1,000,000` tokens  

---

## Executive Summary

| Metric | Baseline (Sliding Window) | Origami (Hierarchical Compaction) | Delta / Improvement |
|---|---|---|---|
| **Fact Retention / Needle Recall** | 68.8% | **84.4%** | **+15.6%** |
| **Mean Prompt Context Size** | 356,446 tokens | **124,834 tokens** | **65% reduction** |
| **Final Context Tokens (Turn 327)** | 444,890 tokens | **63,755 tokens** | **7x compression** |
| **Prompt Cache Hit Rate** | N/A | **71.5%** | Consistent prefix reuse |

---

## Milestone Progression

| Request Index | Raw Session Tokens | Baseline Tokens | Origami Tokens | Compression Ratio | Baseline Acc | Origami Acc | Accuracy Delta | Origami Cache Hit |
|---|---|---|---|---|---|---|---|---|
| Req #40 | 43,261 | 43,183 | 14,885 | 2.9x | 88% | **88%** | +0% | 95% |
| Req #100 | 168,515 | 167,408 | 27,903 | 6x | 88% | **88%** | +0% | 93% |
| Req #200 | 310,311 | 315,779 | 96,003 | 3.3x | 88% | **100%** | +12% | 98% |
| Req #300 | 415,778 | 424,024 | 122,000 | 3.5x | 13% | **63%** | +50% | 0% |

---

## Detailed Probe Breakdowns

### Milestone Request #40 (43,261 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 100% | Latency: 9345ms | Tokens: 89,920
- **Origami Score**: **100%** | Latency: 6143ms | Tokens: **27,284** (Cached: 26,016)
- **Baseline Response**: "The user is asking a specific question about GitHub repository details and a rule regarding shipping the `tools/` directory, based on what appears to be instructions given to \"Origami\" in a previous c"
- **Origami Response**: "This information is not present in the provided conversation context. The discussion covers Origami's UI/TUI/Tern/Web redesign, occupancy/telemetry bugs, trajectory graph porting from `../../_public_/"

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 100% | Latency: 9078ms | Tokens: 89,923
- **Origami Score**: **100%** | Latency: 5809ms | Tokens: **27,287** (Cached: 26,016)
- **Baseline Response**: "The user is asking about a specific issue reported with the Web UI showing 900% or 1100% context occupancy, and how the occupancy percentage calculation was corrected. Based on the transcript investig"
- **Origami Response**: "The user is asking about a specific bug reported in the Web UI where context occupancy was showing 900% or 1100% instead of a proper percentage. They want to know: 1. What issue was reported 2. How th"

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 100% | Latency: 9330ms | Tokens: 89,917
- **Origami Score**: **100%** | Latency: 6462ms | Tokens: **27,281** (Cached: 26,016)
- **Baseline Response**: "The user is asking a specific question: \"What visualization was ported from billion-context into Origami's TUI and WebUI, and how were trajectory bars bounded and scaled?\"  Looking at the conversation"
- **Origami Response**: "The user is asking a specific question about what visualization was ported from billion-context into Origami's TUI and WebUI, and how trajectory bars were bounded and scaled. I need to recall/combine "

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 50% | Latency: 9222ms | Tokens: 89,916
- **Origami Score**: **50%** | Latency: 6570ms | Tokens: **27,280** (Cached: 26,016)
- **Baseline Response**: "The user is asking about explicit instructions regarding Origami branding, logos, and socials - specifically whether they should mention \"omp\" or \"tern\".  Let me review the conversation history to see"
- **Origami Response**: "The user is asking about explicit instructions regarding Origami branding, logos, and socials - specifically whether they should mention \"omp\" or \"tern\".  Let me look back through the conversation his"

### Milestone Request #100 (168,515 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 100% | Latency: 4835ms | Tokens: 309,145
- **Origami Score**: **100%** | Latency: 3212ms | Tokens: **51,397** (Cached: 47,696)
- **Baseline Response**: "I don't see any information about a GitHub repository, organization, or rules regarding shipping the `tools/` directory in the visible conversation history or transcript provided.  The context shown f"
- **Origami Response**: "The user is asking about a specific GitHub repository and organization that Origami was instructed to be pushed to, and a strict rule regarding shipping the tools/ directory. This appears to be asking"

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 100% | Latency: 3680ms | Tokens: 309,148
- **Origami Score**: **100%** | Latency: 3088ms | Tokens: **51,400** (Cached: 47,696)
- **Baseline Response**: "The user is asking about a specific issue reported with the Web UI showing 900% or 1100% context occupancy, and how it was corrected. I need to find evidence of this in the transcript/context.  Let me"
- **Origami Response**: "The user is asking about a specific bug reported in the conversation: Web UI showing 900% or 1100% context occupancy, and how the occupancy percentage calculation was corrected.  From the compressed c"

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 100% | Latency: 4630ms | Tokens: 309,142
- **Origami Score**: **100%** | Latency: 3107ms | Tokens: **51,394** (Cached: 47,696)
- **Baseline Response**: "The user is asking a specific question about what visualization was ported from billion-context into Origami's TUI and WebUI, and how trajectory bars were bounded and scaled. I need to find this infor"
- **Origami Response**: "The user is asking about a visualization ported from `billion-context` into `origami`'s TUI and WebUI, specifically how trajectory bars were bounded and scaled.  From the conversation context (the com"

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 50% | Latency: 3892ms | Tokens: 309,141
- **Origami Score**: **50%** | Latency: 3341ms | Tokens: **51,393** (Cached: 47,696)
- **Baseline Response**: "The user is asking: \"What explicit instructions did the user give regarding whether Origami branding, logos, and socials should mention omp or tern specifically?\"  I need to review the conversation tr"
- **Origami Response**: "The user is asking about explicit instructions regarding Origami branding, logos, and socials mentioning omp or tern specifically.  Let me review the conversation context to find any such instructions"

### Milestone Request #200 (310,311 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 100% | Latency: 7654ms | Tokens: 602,698
- **Origami Score**: **100%** | Latency: 4349ms | Tokens: **190,188** (Cached: 186,448)
- **Baseline Response**: "The user is asking two specific factual questions about the conversation history:  1. What specific GitHub repository and organization was Origami instructed to be pushed to? 2. What was the strict ru"
- **Origami Response**: "The user is asking two specific questions based on the compressed conversation history:  1. What specific GitHub repository and organization was Origami instructed to be pushed to? 2. What was the str"

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 100% | Latency: 7084ms | Tokens: 602,701
- **Origami Score**: **100%** | Latency: 4198ms | Tokens: **190,191** (Cached: 186,448)
- **Baseline Response**: "The user is asking about a specific issue that was addressed in this long coding session: the Web UI displaying \"900%\" or \"1100%\" context occupancy, and how it was fixed.  Let me recall from the sessi"
- **Origami Response**: "The user is asking about a specific issue reported earlier in the conversation: the Web UI showing 900% or 1100% context occupancy, and how it was corrected.  This is a factual question about the conv"

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 100% | Latency: 6951ms | Tokens: 602,695
- **Origami Score**: **100%** | Latency: 3602ms | Tokens: **190,185** (Cached: 186,448)
- **Baseline Response**: "The user is asking about the visualization ported from billion-context into Origami's TUI and WebUI, and how trajectory bars were bounded and scaled. Let me recall from the transcript:  1. The user or"
- **Origami Response**: "The user is asking a question about the technical content from the earlier compressed conversation sections: specifically what visualization was ported from billion-context into Origami's TUI and WebU"

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 50% | Latency: 7350ms | Tokens: 602,694
- **Origami Score**: **100%** | Latency: 3866ms | Tokens: **190,184** (Cached: 186,448)
- **Baseline Response**: "The user is asking about explicit instructions regarding branding mentions. Let me recall the conversation:  1. The user's first message was about UI/TUI/Tern integration looking bad, needing better p"
- **Origami Response**: "The user is asking about explicit instructions regarding whether Origami branding, logos, and socials should mention omp or tern specifically. I need to recall the conversation context.  Looking at th"

### Milestone Request #300 (415,778 raw tokens)

#### Probe: Repo Target & Tools Exclusion (`repo-and-tools`)

- **Baseline Score**: 0% | Latency: 0ms | Tokens: 424,024
- **Origami Score**: **100%** | Latency: 17659ms | Tokens: **230,469** (Cached: 0)
- **Baseline Response**: "Error: The operation timed out."
- **Origami Response**: "The user is asking two specific factual questions based on the conversation history:  1. What specific GitHub repository and organization was Origami instructed to be pushed to? 2. What was the strict"

#### Probe: Telemetry Percentage Bug Fix (`telemetry-bug`)

- **Baseline Score**: 50% | Latency: 0ms | Tokens: 424,024
- **Origami Score**: **50%** | Latency: 18625ms | Tokens: **230,472** (Cached: 0)
- **Baseline Response**: "Error: The operation timed out."
- **Origami Response**: "The user is asking about a specific bug reported in the Web UI showing 900% or 1100% context occupancy, and how it was corrected. Let me look through the context provided in the compressed conversatio"

#### Probe: Trajectory Visualization Port (`trajectory-port`)

- **Baseline Score**: 0% | Latency: 0ms | Tokens: 424,024
- **Origami Score**: **100%** | Latency: 17241ms | Tokens: **230,466** (Cached: 0)
- **Baseline Response**: "Error: The operation timed out."
- **Origami Response**: "The user is asking about what visualization was ported from billion-context into Origami's TUI and WebUI, and how trajectory bars were bounded and scaled.  Let me look through the compressed context t"

#### Probe: Agent Generality & Branding (`agent-neutrality`)

- **Baseline Score**: 0% | Latency: 0ms | Tokens: 424,024
- **Origami Score**: **0%** | Latency: 16508ms | Tokens: **230,465** (Cached: 0)
- **Baseline Response**: "Error: The operation timed out."
- **Origami Response**: "Based on the conversation, the user gave two explicit instructions:  1. **Agent-"
