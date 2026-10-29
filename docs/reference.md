# Origami Reference

## How folding works

Origami replaces destructive full-window compaction with incremental, reversible range folds:

- Tier 1 summarizes raw message ranges.
- Tier 2 merges two or more Tier 1 blocks.
- Tier 3 condenses lower-tier blocks across long sessions.
- Newest messages, the latest user turn, the initial prompt, and first-turn tool results stay protected.
- Efficiency nudges are advisory; emergency nudges are mandatory. After two ignored emergency turn transitions, Origami may execute validated emergency folds automatically; it otherwise elides safe later tool results or blocks an oversized request.
- Advisory folds pass a timing gate: context above the fill floor (`minFoldFillPct` of the window, capped by `minFoldFillCapTokens`), a task boundary (a fresh user turn, turn end, an idle cold cache, or twice the growth step of unfolded work), and, once cache telemetry exists, break-even within `paybackHorizonTurns`. `fold_status` prints the current `Fold gate:` line. Emergency folds ignore the gate.
- The initial user instruction is untagged. Later user and tool-result messages carry `[#mNNNNN]` ref tags (`refTags`) so summaries and recalls can cite exact refs.
- Every block records a manifest of the file paths, symbols, errors, commits and tools in its source. When the current turn touches manifest items of a folded block, a tail `[origami recall]` hint names that block (at most `recallHintMax`, each block at most once per 5 turns).
- Summary lint: paths, commits and errors from the manifest that a summary omits are attached to the block as `Also covered`, and the block's token count measures the full rendered text.
- Pinned ledger: user messages of a tier-1 fold are pinned as intents, and `keep` records (`constraint`, `decision`, `objective`) are pinned explicitly. Pinned records render under `Pinned:` and are carried verbatim subject to deterministic semantic deduplication and tier-2/3 count and character budgets; constraints and decisions outrank retireable objectives and intents.
- Folded originals are archived locally and remain searchable (topics, summaries, manifests and pinned records) and recoverable.

Blocks are `active`, `consumed` by a higher tier, or `unfolded`. Status checks enforce unique coverage, valid parent-child state, and branch membership.

## Safety guards and invariants

Origami enforces structural safety checks before committing any context changes:

- Preflight window safety gate: Inline unfolds that would push context usage past the emergency threshold are blocked. The agent is advised to use `mode: "file"` instead, with an optional `force: true` override.
- Tool-pairing atomicity: Assistant tool calls and their matching `toolResult` messages are bound together. Fold candidate selection and execution never split a call from its result or across protected boundaries.
- Regurgitation and net-shrink guard: Folds must strictly reduce token mass. Any fold or distillation merge where summary tokens meet or exceed replaced tokens is rejected.
- Fold loop circuit breaker: Telemetry tracks consecutive fold errors per session. The circuit breaker arms at 3 consecutive failures with an explicit stop warning, and collapses subsequent calls into a short refusal to prevent token-burning retry loops. It clears on any successful fold or after 10 minutes of quiet.
- Frontier clamp diagnostics: Requests citing message references beyond the session's newest stored reference are caught early. Out-of-bounds spans are diagnosed as stale-generation hallucinations, while partially-exceeded spans return concrete ceiling clamps (`retry with endRef ≤ mXXXXX`).
- Coverage regression guard: Distillation merges verify that every message ref covered by active blocks before a fold remains covered after the fold, preventing accidental decompression.
- Pre-commit invariant check: Blocks with duplicate message coverage, active-child inconsistencies, or missing consumed references are rejected prior to state mutation.
- Safe anchor attribution: Distillation merges inherit the maximum anchor of their consumed children rather than advancing to the newest conversation ref, ensuring uncompressed turn growth is never erased.
- Mixed-tier batch folding: A single `fold` execution can combine Tier 1 raw message compression and Tier 2 summary distillation, letting agents reclaim prompt space and declutter block trees in one turn.
- Cache collapse alerts: Telemetry monitors large prompt rounds (≥8K tokens) and flags when cache read rates drop below 10% after earlier healthy performance.
- Nudge anti-amplification: Bookkeeping tool calls across all turns are excluded from growth tracking. Advisory efficiency and promotion nudges observe a post-fold cooldown (2 turns, extended up to 8 while the latest fold has not paid back), preventing repetitive reminders while keeping emergency window protection active.
- Single compaction authority: Origami disables omp's own compaction settings for the main session. If host compaction or shake still runs, Origami does not fold in response; it warns once and attributes the resulting cache misses to `Host rewrite`.
- Recall federation: Queries directed to cross-session memory (`recall`) are automatically cross-checked against the active session's SQLite index, appending matching fold blocks and message references without altering external memory.
- Plan-aware retrieval: Full-text search extracts active tasks and planning state from the recent message window, boosting relevant candidate blocks above unrelated matches.
- Semantic task boundary slicing: Candidate range detection slices uncompressed history along natural developer milestones (git commit deliverables, test suite passes, completed tasks, and clean user-turn endpoints), ensuring candidate ranges encapsulate cohesive units of work rather than arbitrary message windows.

Origami tracks the long-term economics of context management:

- Archived Stored: Raw message tokens preserved in local SQLite storage.
- Active Summaries: Compact summary tokens occupying active prompt window space.
- Compression Ratio: Multiplier of archived original tokens over in-context summaries (e.g. 45.4×).
- Payback Status: A fold's one-time cost is `(1 − r)·T + q·σ − r·S` and its per-turn saving `r·(S − σ)`, where `S` is the replaced tokens (raw source for tier 1, child summaries for tier 2/3), `σ` the summary tokens, `T` the measured re-paid prefix, `r` = `cacheReadPrice` and `q` = `outputPrice`, all in units of one uncached input token. Break-even is their ratio; a fold whose summary is not smaller than its source never pays back.
- Cache Miss Reconciliation: Ground-truth decomposition separates missed tokens into normal turn growth, fold prefix invalidation re-pay, host compaction rewrites, and an unattributed remainder (TTL expiry or provider eviction).
- Cadence Protection: If the latest tier-1 fold has not yet broken even, post-fold cooldown extends to its break-even turns (at most 8).
- Background candidates (`speculativeFolds`, off by default): after a turn ends, a side turn that shares the session's model and prompt cache drafts one fold for a timely range. It is never written to history; the main model sees it as an `[origami]` note and answers with `fold_candidate`.
## Workbench

Open with `/fold` or `Alt+F`.
- Context zones show the latest provider cache-read prefix as cached-token coverage per protected, folded, or compressible zone. The cached boundary may split one zone (`partial`); prompt overhead is subtracted before mapping cache-read tokens onto conversation zones.
- Overview: context map, occupancy split, vault storage KPI tiles, and payback status.
- Trajectory: 1:1 discrete round bars, cache read rates, and fold markers.
- Blocks: fold list, lifecycle, summaries, and unfold actions.
- Zones: pinned, folded, compressible, and protected regions with uncovered run auditing.
- Configuration: `/fold config` inspects runtime settings, switches operational presets (`balanced`, `lean`, `relaxed`), or updates individual thresholds and options saved directly to `.omp/origami.yml`.
| Key | Action |
|---|---|
| `1`–`4` | Select a tab |
| `Tab`, `Shift+Tab`, arrows, `h`/`l` | Cycle tabs |
| `↑`/`↓`, `j`/`k` | Select a block or scroll detail |
| `PgUp`/`PgDn` | Page through block detail |
| `Enter` | Open or close block detail |
| `u` | Unfold to an artifact file |
| `i` | Unfold inline |
| `f` | Preview fold candidates |
| `s`/`S` | Select next or previous agent session |
| `q`, `Esc` | Close |

## Web dashboard

`/fold web` starts a token-protected loopback server on port 3780, falling back through 3789. It shows context and cache trajectories with synchronized brush zoom, protected zones, uncovered mid-history runs, fold candidates with timing-gate indicators and interactive review actions, multi-session navigation for concurrent subagents, active pinned ledger records and character budgets, slide-over block detail drawers with provenance manifests and pinned records, agent-session hierarchy, FTS5 search over fold summaries and archived original messages, a real-time tool execution audit log with frustration-loop diagnosis, and an interactive Settings panel with operational preset switching, threshold controls, and instant or persistent configuration updates.
The API rejects missing tokens, foreign origins, non-loopback hosts, and invalid mutation bodies.
## Agent tools

| Tool | Purpose |
|---|---|
| `fold` | Fold raw message ranges or merge existing blocks. Accepts single-fold shorthand, string tiers, stringified JSON, and block ranges. |
| `unfold` | Restore a block to a file or inline; `deep: true` reaches raw messages. Inline unfold validates window headroom before restoring, with optional `force: true`. |
| `fold_recall` | Read exact original text by message ref without changing context. |
| `fold_search` | Search block summaries and archived original messages. Supports `tier:N` and `session:ID`. |
| `fold_status` | Inspect occupancy, token split, fold state, and protected zones. |
| `fold_cache` | Inspect cache hit rates and fold cache economics. |
| `fold_candidate` | Accept, edit or reject a background fold candidate (`speculativeFolds`). |

## Local data

- `~/.omp/agent/origami.db`: fold metadata, archived originals, FTS5 indexes, and cache telemetry. It follows `PI_CODING_AGENT_DIR` when set.
- Corrupt databases are moved to `origami.db.corrupt-<timestamp>` and recreated; session journals remain the block source of truth.
- All sessions in one `omp` process share one database connection.
- File unfolds and `/fold export` write into the active OMP session artifact directory.
- If a database write fails while OMP is running, Origami keeps the journal-backed fold and disables persistence for that session rather than leaving a partial fold transaction.

## Cache behavior

Folding changes the cached prefix once, so Origami waits for meaningful context growth and reclaimable history. File unfold is cache-safe; inline unfold rewrites active context. The trajectory UI marks expected post-fold rebuilds so they can be distinguished from provider TTL expiry.
