# Changelog

## 0.4.1 — 2026-10-30

### Features & Improvements
- **Live configuration controls across all surfaces**: Added an interactive Settings tab to the Web UI dashboard (`#settings`) with preset cards (`balanced`, `lean`, `relaxed`), threshold inputs (`growthStep`, `compressibleFloor`, `emergencyFillPct`, `cooldownTurns`, `paybackHorizonTurns`), runtime toggles, and instant session apply or save to `.omp/origami.yml`. Added `/fold config [preset <name> | set <key> <val>]` terminal command for headless or CLI environments. Added `GET /api/config` and `POST /api/config` endpoints with validation and SSE status broadcasting.
- **Semantic task boundary slicing**: Candidate range generation in `src/kernel/nudge.ts` now identifies natural developer milestones via `src/kernel/semantic-boundary.ts`: git commit deliverables, verified test suite passes (`0 fail` / `pass`), completed tasks (`todo op: "done"`), and clean user turn endpoints. In addition to full contiguous spans, `recommendRanges` surfaces cohesive milestone sub-ranges, preventing arbitrary cuts across active workflows and giving candidate generators clean task-aligned ranges.
- **Cross-preset replay matrix benchmarking**: Added `--preset all` to `bench/replay.ts` and `bun run replay:matrix` to `package.json`, evaluating session journals across `lean`, `balanced`, and `relaxed` presets and comparing `legacy-0.2` against `current` policies in a unified table.

### Safety & Correctness
- Added `cooldownTurns` to `NON_NEGATIVE_INT_KEYS` in `src/config.ts`, ensuring live updates and YAML overrides validate cleanly.
- Preserved tool-pairing atomicity, ephemeral message trimming, and duplicate range suppression across all semantic sub-ranges.
## 0.4.0 — 2026-10-29

### Features & Improvements
- **Hard context-window enforcement**: Origami now estimates the complete rendered outbound request, including injected doctrine, nudges, recall hints, ref tags and host overhead. After two ignored emergency turns it can execute normal validated emergency folds automatically; safe later tool results may be elided, and requests that still cannot fit are aborted instead of knowingly exceeding the model window.
- **Provenance-aware recall metadata**: Message facts retain natural-language prose, structured tool-call arguments and explicit tool-result failure state separately from canonical hash text. Manifests no longer treat successful source reads as path or error evidence, while real failed results remain recallable.
- **Bounded pinned ledgers**: Tier-2 and tier-3 ledgers are semantically deduplicated and deterministically budgeted at 12 records / 4,000 characters and 8 records / 2,500 characters. Constraints and decisions outrank retireable objectives and intents, and inherited record IDs remain stable.
- **Model-derived fold economics**: Cache-read, output and cache-write ratios resolve from the active model with optional per-field configuration overrides and conservative fallbacks. Each cache round persists its effective profile, and cache-write premiums now participate in fold payback decisions and reports.
- **Forward-readable storage**: Schema v7 adds `minimum_reader_schema` metadata and historical price profiles. Future additive writers may remain writable by v7 readers when they explicitly declare compatibility; incompatible or malformed future schemas fail before WAL or migration changes.
- **Truthful replay comparisons**: `bun run replay` can compare the current policy with the replay-only v0.2.3 policy, isolate state per policy, and consume deterministic cached model summaries. `bench/replay-summaries.ts` fills missing summary requests resumably through an isolated OMP agent directory.
- **Usable turn-end candidates**: Turn end is now a real fold-timing boundary even when speculative candidates are disabled; later messages invalidate the marker. Candidate generation remains opt-in, side-turn-only and non-mutating until accepted.
- **Focused engine modules**: Range, rendering, timing, fold, status, recall and shared type operations now have dedicated modules, while `OrigamiEngine` remains the compatibility entry point.
- **Web UI provenance and candidate review**: Slide-over block detail drawer renders provenance manifests (touched files, symbols, git commits, captured errors, executed tools), bounded pinned ledger records with kind badges, and summary-lint omissions. Overview dashboard includes an Active Pinned Ledger card displaying live session constraints and character budgets, an interactive candidate card with accept, edit and reject actions, a multi-session navigation switcher for subagents, and a Fold Timing Gate indicator showing fill-floor, boundary, and amortization status.
- **Replay CLI ergonomics and CI smoke target**: Added `--help` / `-h` usage flag to `bench/replay.ts` documenting input options, policies, presets, window sizing, summary sources, and output formatting; added `bun run replay:smoke` target executing synthetic benchmark runs.

### Safety & Correctness
- The initial user instruction remains untagged, first-turn tool results are never elided, and later user/tool-result refs remain citeable.
- The cost gate estimates the complete suffix after the earliest candidate rather than only raw trailing messages; measured post-fold telemetry remains independent.
- Replay current-policy runs never record a sent context at or above the configured window.

### Notes
- Database schema v7 is the forward-compatibility baseline. Released v6 builds still cannot open v7 or future databases.
- Automatic pricing uses model catalog costs when valid; fallback ratios are cache read `0.1`, output `4`, and cache write `1`.
- The release benchmark retained 100% of constraints, lost 0 facts, and reported 0 invariant violations across 400 turns.

## 0.3.0 — 2026-10-29

### Features & Improvements
- **Correct fold economics**: Break-even now uses the cache-priced formula `((1 − r)·T + q·σ − r·S) / (r·(S − σ))` in units of one uncached input token (`cacheReadPrice` 0.1, `outputPrice` 4). Tier 2/3 merges are measured against their children's summaries instead of raw source, and folds whose summary is not smaller never pay back (`never`). The previous formula subtracted σ twice and ignored cache pricing. Payback-extended cooldown is capped at 8 turns.
- **Fold timing gate**: Advisory nudges wait for a fill floor (balanced: min(45% of window, 160K)), a task boundary (user turn, cold cache after `cacheTtlMs`, or 2× growth step), and break-even within `paybackHorizonTurns` (10). Emergency folds are unaffected. `fold_status` shows the gate.
- **Single compaction authority**: `auto_compaction_start` no longer triggers an Origami fold; host compaction/shake is recorded per round (`host_rewrite`, schema v5) and reported as `Host rewrite` in the cache decomposition. The residual bucket is now `Unattributed`.
- **Ref tags, manifests and recall hints**: User and tool-result messages carry `[#mNNNNN]` tags (`refTags`). Blocks store a manifest of paths, symbols, errors, commits and tools (schema v6, indexed for `fold_search`), and a tail `[origami recall]` hint points at folded blocks matching the current turn (`recallHintMax`).
- **Summary lint**: Manifest paths, commits and errors a summary omits are attached as `Also covered`; `tokensAfter` measures the full rendered block.
- **Pinned ledger**: Tier-1 folds pin user messages as intents; `keep` pins constraints, decisions and objectives. Pinned records survive every merge verbatim; `retire` drops finished objectives and intents on merge.
- **Background fold candidates** (opt-in `speculativeFolds`): a side turn drafts one fold after a turn ends; the model answers with the new `fold_candidate` tool.
- **Session replay harness**: `bun run replay` replays real session journals offline (simulated or recorded folds) with far-recall probes.

### Notes
- The CI benchmark runs 400 turns: with the fill floor, 200 turns no longer reach the first fold.
- Database schema v6. Older Origami versions refuse to open a newer database; to downgrade, set `PRAGMA user_version` to the older version's schema (4 for 0.2.10, 3 for 0.2.3). The added columns are ignored by older code, and the migrations re-run safely on upgrade.
- Compaction disarm is reapplied on every main-session start instead of once per process.

### Known limitations
- Manifest error extraction matches any tool-result line containing words like `error` or `failed`, so file reads of source code add noise to `Also covered` and recall hints.
- Merged blocks inherit every pinned record; pinned intents accumulate until the model retires them.

## 0.2.10 — 2026-10-28

### Features & Improvements
- **Cache Miss Ground-Truth Reconciliation Engine (#800)**: Decomposes every turn's prompt cache misses into three conservation components: fresh content growth ($\Delta I$), fold prefix re-pay cost ($T$), and provider TTL or cluster eviction ($E$). Operates with exact token conservation ($M = \Delta I + T + E$).
- **Per-Fold Payback & Cadence Health**: Tracks measured re-pay $T$, summary cost $\sigma$, gross token savings $S$, net prompt tokens saved, break-even rounds $n^*$, and interleave cadence health across all folds in the session.
- **Dynamic Cadence Protection**: When a fold requires multiple rounds to amortize its measured re-pay penalty, `decideNudge` automatically adjusts post-fold cooldown to ensure the active fold breaks even before triggering subsequent advisory folds.
- **Cache Write Alias Normalization**: Maps diverse provider usage payloads (including camelCase `cacheWrite`, snake_case `cache_creation_input_tokens`, and `cacheCreationInputTokens`) to accurately record cache write creation tokens.
- **Web UI & CLI Tool Integration**: Added `/api/cache-report` API endpoint and four integrated KPI decomposition cards (Fresh Growth, Fold Re-pay, TTL Eviction, Net Prompt Saved) matching the dashboard design system. Replaced stacked tables with a unified ledger card featuring an inline switcher between the per-request cache ledger and the per-fold payback ledger.
- **Batch-Aware Cadence & Session Scoping**: Measures fold interleave cadence across distinct round boundaries so sibling folds executed within the same tool turn are not penalized with distance zero. Scopes cache report generation to active session blocks.

## 0.2.9 — 2026-10-28

### Bug Fixes & Improvements
- **Dashboard Server Idle Timeout & SSE Keep-Alive**: Configured `idleTimeout: 0` on `Bun.serve` in `dashboard-server.ts` to disable Bun's default 10-second socket idle timeout on long-lived Server-Sent Events (SSE) streams (`/api/events`). Added a 15-second heartbeat interval emitting `: ping\n\n` comments to prevent browser event sources, proxies, and bridges from disconnecting during quiet periods.
- **Obsolete Ephemeral Developer Reminder Pruning**: `planRender` now schedules removals for obsolete ephemeral developer reminders (`<system-reminder>`, `[shaken]`, `WSL bridge`, `<system-notice>`) that are surrounded by folded history or whose turn has folded. Ephemeral messages in live history and the protected tail remain untouched.
- **Context Zone De-Fragmentation**: Fixed `protectedZoneMap` to assign `folded` or `compressible` status to internal ephemeral messages based on their surrounding context rather than unconditionally marking them `protected`. This eliminates fragmented `sys..sys` zone rows.
- **Accurate Ephemeral Token Accounting**: `status().occupancy` now counts only live system tokens, reducing inflated system token reports from 2.7K to the actual active count (~65t). Zone token accounting now includes intermediate ephemerals in range slices and restricts isolated fallback reporting to specific zone messages.
- **Nudge Candidate Run Ephemeral Spanning**: `recommendRanges` now allows candidate runs to span across intermediate ephemeral messages within foldable turns, trimming range endpoints to valid non-ephemeral message references so runs do not split or orphan tool-pair partners.

## 0.2.8 — 2026-10-28

### Features & Invariant Fixes
- **Safe Anchor Attribution for Distillations**: Tier 2 and Tier 3 distillation merges now inherit the highest anchor reference among their consumed children rather than stamping the newest conversation ref. This preserves growth tracking across uncompressed turns and ensures efficiency reminders continue to fire on schedule.
- **Per-Fold Spec Tier Support & Auto-Inference**: `FoldSpec` now accepts an optional `tier` field (`1 | 2 | 3`). The salvage engine auto-infers `tier: 2` for block ranges (`b1..b5`) and `tier: 1` for message spans (`m00001..m00010`) within the same call, enabling mixed-tier batch folding where raw turns are compressed alongside summary distillation.
- **Backlog-Aware Compound Nudges**: When efficiency candidate ranges and block promotion candidates are both eligible, `decideNudge` emits a compound reminder advising agents to wrap up pending Tier 1 raw ranges first to reclaim prompt space, or fold both together. Standard promotion nudges also include a concrete notice when pending raw history candidate ranges exist.
- **Pre-Commit Structural Invariant Verification**: `executeFold` checks duplicate coverage, active-child state, and consumed reference consistency before mutating the session tree, preventing invalid block trees from landing.

## 0.2.7 — 2026-10-28

### Features
- **Recall Federation Hook**: Intercepts cross-session memory queries (`recall` and `write xd://recall`) and cross-checks the active session's SQLite FTS5 index. Appends a clean `[Origami In-Session History]` section with matching fold blocks and original message references without modifying external memory.
- **Nudge Self-Amplification Prevention (#5058)**: Excludes all Origami bookkeeping tools (`fold`, `unfold`, `fold_recall`, `fold_search`, `fold_status`, `fold_cache`) across all turns from `growthSinceFold`. Implements a 2-turn post-fold cooldown suppressing advisory efficiency and promotion nudges immediately after a fold while keeping emergency window overflow protection active.
- **Plan-Aware Search Re-ranking (#5047)**: Implements plan-aware retrieval in `fold_search`. Scans recent messages for planning tool calls (`todo`, `task`, `update_plan`) and user instructions, tokenizes weighted signal terms, and re-ranks search hits to prioritize active plan-relevant blocks.
- **Doctrine and Tool Clarification**: Updated Origami doctrine prompt and tool descriptions to explicitly distinguish in-session history retrieval (`fold_search`, `fold_recall`) from cross-session memory (`recall`, `retain`).

## 0.2.6 — 2026-10-28
### Features
- Upstream billion-context architectural alignment (round 2):
  1. **Fold Loop Circuit Breaker (#2146, #4812)**: Tracks consecutive fold failures in session telemetry. Arms at 3 consecutive failures with an explicit stop notice, and collapses into a short refusal on subsequent calls (`[Fold refused: circuit breaker still armed...]`), breaking infinite tool retry loops. Automatically disarms on any successful fold or after a 10-minute quiet window.
  2. **Frontier Clamp Diagnostics (#2146, #4252)**: Detects requests referencing messages beyond the session's highest stored reference. Accurately diagnoses all-above-frontier ranges as stale-generation hallucinations (`range is above this session's highest ref (mXXXXX)`) and provides concrete ceiling clamp notes for partially-above-frontier ranges (`endRef is above the highest stored ref (mXXXXX); retry with endRef ≤ mXXXXX`).
  3. **Coverage Regression Guard (#3322)**: Pre-commit invariant check in `executeFold` guaranteeing that every message covered by active blocks before a fold remains covered after the fold. Rejects any corrupted or partial merge that would decompress or orphan previously-covered messages without modifying session state.
  4. **Tool Call Assistant Message Fingerprinting (#4110)**: Deserializes top-level `tool_calls` and `toolCalls` on assistant messages when `content` is null or empty. Synthesizes canonical tool-call representation into message text and generates distinct, deterministic content hashes to eliminate cross-session and cross-message hash collisions.
  5. **Payback Economics & Break-Even Turns (#4899, #4916, #4956)**: Real-time calculation of amortized fold payback based on one-time summary overhead vs subsequent prompt egress avoidance. Computes `breakEvenTurns`, `paidBack` status, `cumulativeSavedTokens`, and concrete payback strings, surfaced across the footer status chip (`✓` indicator), Workbench Overview KPI tiles, and Web UI Vault Storage card.

## 0.2.5 — 2026-10-28

### Features
- Upstream billion-context feature alignment:
  1. **Regurgitation Guard & Net-Shrink Enforcement (#1819, #2748, #3635)**: Hard rejection gate in `executeFold` blocking any fold or multi-fold batch where summary tokens exceed or equal replaced message tokens, including Tier 2 distillation merges exceeding combined child mass. Updated origami doctrine with time-sensitivity warnings and resolved objective pruning.
  2. **Lenient Fold Argument Salvage (#2580, #1502)**: Expanded tool schema and introduced `salvageFoldParams` supporting shorthand `{ range, topic, summary }`, string tiers (`"1"`, `"2"`, `"3"`), stringified JSON payloads, stripped outer quotes/backticks, and automatic Tier 2 distillation inference for block ranges (`b1..b5`).
  3. **Prompt Cache Collapse Warning (#499, #1847)**: Telemetry tracking in `evaluateCacheRound` flagging collapse when 4 consecutive large turns (≥8Kt) drop to ≤10% hit rate after earlier healthy cache hits (≥50%). Surfaced as visual warning banners in the Web UI Audit tab and `fold_cache` status output.
  4. **Uncovered Mid-History Runs Auditing (#4331)**: Algorithmic detection of uncompressed message spans stranded between active fold blocks or prior to protected tails (`detectUncoveredRuns`). Exposed in `StatusReport`, `fold_status` CLI output, and the Web UI Context Zones table.
  5. **Vision & Thinking Token Realism (#488, #767, #1320, #1843)**: High-detail vision tile modeling (`pixelTileEstimate`, `decodeImageDims`) parsing container headers (PNG, JPEG, GIF, BMP) to replace flat ~6-token string approximations with realistic 765–2805 token counts, alongside accurate accounting for extended thinking and encrypted `redacted_thinking` blocks.

## 0.2.4 — 2026-10-28

### Features
- Running context and session vault storage telemetry: added `StatusVaultReport` tracking original archived tokens, in-context active summaries, reclaimed tokens, compression multiplier, and space reduction percentage across all surfaces.
- Workbench Overview KPI stat tile row: 4-tile stat strip in both Tern TSP and ANSI TUI displaying Archived Stored tokens, Active Summaries, Compression Ratio, and Growth / Step threshold.
- Persistent status chip compression indicator: footer status bar now reports the running compression ratio alongside live blocks and reclaimed tokens (`8b -803.7K (45.4×)`).
- Web UI Origami Vault Storage: added an Overview card and updated top KPI metrics with live vault storage and compression ratio details.
- Discrete 1:1 bar trajectory chart with bounded visible window (`slice(-maxBars)`) and recent-peak Y-axis ceiling in Tern TSP, eliminating chart overflow while preserving turn-by-turn granularity.
- Ported billion-context context trajectory graph and linked prompt cache hit-rate chart with brush zoom into the Web UI.
- Context Pleat brand kit: high-DPI vector lockups, adaptive dark/light headers, OpenGraph social previews, and web dashboard favicon.
- Complete user-facing `README.md` documentation covering installation, configuration presets, slash commands, workbench controls, and web dashboard usage.
### Fixes
- Fixed web dashboard window occupancy percentage calculation (preventing 100x over-scaling).
- Corrected live token telemetry to account for prompt baseline overhead and active turn projection.
- Handled Windows file-lock cleanup in test teardown without spurious unlink errors.

## 0.2.3 — 2026-10-28

### Fixes
- Fixed malformed generated JavaScript that prevented the web dashboard from loading when block search results were rendered.
- Historical `fold` tool-call and result messages remain in outbound model context, preventing the host from treating completed fold actions as absent and requesting them again.

## 0.2.2 — 2026-10-28

### Compatibility
- Supports oh-my-pi `>=18.6.0` with no upper bound (previously `^18.13.2`, which failed to install on 18.12.x).
- Native Tern rendering is optional: native UI modules load dynamically, and the workbench, transcript banner, and inline tool views fall back to ANSI when they are unavailable.

### Fixes
- A fold batch whose disjoint ranges share one turn no longer fails with a false overlap error. Turn widening gives the shared turn to the earlier fold; only intersecting requested ranges are rejected.

## 0.2.1 — 2026-10-28

### Reliability
- Fold archive, block, and child-status writes are committed in one SQLite transaction. A write-time storage failure now disables persistence for the affected session without undoing its journal-backed fold, and reports the degradation once.
- Cache-round fold attribution is cleared only after the round is durably inserted.
- Dashboard fold and unfold endpoints return stable `400` responses for malformed JSON and invalid request fields.

### Search and tooling
- Dashboard search now returns archived original-message hits alongside fold blocks.
- CI enforces deterministic benchmark gates for invariants, fact retention, fold activity, and input cost, and uploads the benchmark JSON artifact.

### Documentation
- README focuses on installation and everyday use; configuration, storage, UI, tool, benchmark, and development reference moved under `docs/`.

## 0.2.0 — 2026-10-28

### Correctness
- Blocks have an explicit lifecycle (`status`: `active` / `consumed` / `unfolded`, plus `consumedBy`) replacing the `superseded` flag. Tier 2/3 folds consume their children atomically, so merged sources are no longer rendered twice.
- Unfolding is parent-first: a consumed block reports which block to unfold; inline unfold restores one level, `deep: true` restores raw messages.
- Fold batches are validated as a whole before anything is written: overlapping folds, merging a block twice, empty topics/summaries, summaries that are not smaller than what they replace, and merges of fewer than 2 lower-tier blocks are rejected.
- A Tier 1 fold over refs already owned by an active block covers only the unfolded refs.
- Configurable protected recent tail (`protectedTailMessages`, `protectedTailTokens`), excluded from folds, recommendations, and compressible totals.
- Growth since the last fold is anchored at the newest message present when the fold happened and no longer counts folded messages.
- Invariant judge (`duplicate-coverage`, `active-child`, `orphan-consumed`, `missing-child`, `off-branch`) reported by `fold_status`; rendering skips any block that would duplicate coverage.
- Rendered block headers carry the block id and coverage (`[Compressed conversation section] b3 (m00012..m00020) — topic`).
- Everything from the latest user message onward is protected, and finished `fold` call/result pairs are hidden from the rendered context and excluded from growth and compressible totals.
- Tier 1 fold batches must reclaim at least `max(minFoldBenefitTokens, minFoldBenefitWindowPct × window)` tokens unless the window is at emergency fill.
- Blocks track survived folds (`survivedFolds`, `young`/`old` in `fold_status`); tier merges are proposed only for blocks that survived `blockMatureFolds` later folds.

### Nudges
- Efficiency nudges are advisory: candidates are listed largest first with size, message count, and tool share; the model may fold a subset or defer. A deferred nudge returns only after another half growth step. No fill percentage outside emergencies.
- Promotion nudges suggest Tier 2/3 merges once active summary mass crosses `tier2MassTokens` / `tier3MassTokens`.
- Emergency nudges are explicitly mandatory.
- Dormant subagents no longer receive the doctrine in their system prompt; it is injected into context if they wake up.

### Storage
- SQLite schema v2 with in-place migration: block status/ranges/children, a message archive of folded originals, integrity check with quarantine of corrupt databases, per-session export, and optional retention (`retentionDays`).
- New `fold_recall` tool reads original text for refs from the current branch or the archive; file unfolds fall back to the archive as well.
- `/fold export` writes the session's stored data as JSON.
- Host-compaction archive folds use a clipped one-line-per-message digest instead of copying full text into the summary.
- Schema v3: trigger-maintained, porter-stemmed FTS5 indexes over blocks (topic weighted above summary; the duplicate `body` text is no longer indexed) and over archived messages. `fold_search` returns active blocks first, block status, archived message hits with refs, and falls back to any-term matching; result limits are clamped to 50.
- A fold database that cannot be opened (e.g. written by a newer origami) no longer crashes omp: origami reports the error and keeps folding without persistence for that process. The v3 migration is re-runnable on a database that was downgraded by hand.
- Tests run against a temporary agent directory (`bunfig.toml` preload) instead of migrating and writing the real `~/.omp/agent/origami.db`.

### Multi-session UI
- A process-wide session registry tracks the main agent and its subagents (parent links from agent identity). The status chip and dashboard stay on the main session instead of following whichever session last ran a hook, which removed the flicker while subagents work.
- Status chip shows `· N sub` for running subagents; the workbench switches sessions with `s`/`S`; the dashboard has a session tree selector, per-session `?session=` APIs, `/api/sessions`, and serves ended sessions read-only.
- All sessions share one database connection.

### Dashboard security
- Per-launch access token, strict `Host`/`Origin` checks, no wildcard CORS, `OPTIONS` refused, and JSON + header token required for mutating requests.

### Tooling
- `bun run bench`: deterministic marathon benchmark against an uncompressed baseline; `--promotion mass|growth` compares merge triggers.
- MIT `LICENSE`, CI workflow (typecheck, tests, benchmark smoke).
