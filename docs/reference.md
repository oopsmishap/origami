# Origami Reference

## How folding works

Origami replaces destructive full-window compaction with incremental, reversible range folds:

- Tier 1 summarizes raw message ranges.
- Tier 2 merges two or more Tier 1 blocks.
- Tier 3 condenses lower-tier blocks across long sessions.
- Newest messages, the latest user turn, and the initial prompt stay protected.
- Efficiency nudges are advisory; emergency nudges are mandatory.
- Folded originals are archived locally and remain searchable and recoverable.

Blocks are `active`, `consumed` by a higher tier, or `unfolded`. Status checks enforce unique coverage, valid parent-child state, and branch membership.

## Safety guards and invariants

Origami enforces structural safety checks before committing any context changes:

- Preflight window safety gate: Inline unfolds that would push context usage past the emergency threshold are blocked. The agent is advised to use `mode: "file"` instead, with an optional `force: true` override.
- Tool-pairing atomicity: Assistant tool calls and their matching `toolResult` messages are bound together. Fold candidate selection and execution never split a call from its result or across protected boundaries.
- Regurgitation and net-shrink guard: Folds must strictly reduce token mass. Any fold or distillation merge where summary tokens meet or exceed replaced tokens is rejected.
- Fold loop circuit breaker: Telemetry tracks consecutive fold errors per session. The circuit breaker arms at 3 consecutive failures with an explicit stop warning, and collapses subsequent calls into a short refusal to prevent token-burning retry loops. It clears on any successful fold or after 10 minutes of quiet.
- Frontier clamp diagnostics: Requests citing message references beyond the session's newest stored reference are caught early. Out-of-bounds spans are diagnosed as stale-generation hallucinations, while partially-exceeded spans return concrete ceiling clamps (`retry with endRef ≤ mXXXXX`).
- Coverage regression guard: Distillation merges verify that every message ref covered by active blocks before a fold remains covered after the fold, preventing accidental decompression.
- Cache collapse alerts: Telemetry monitors large prompt rounds (≥8K tokens) and flags when cache read rates drop below 10% after earlier healthy performance.

## Vault storage and payback economics

Origami tracks the long-term economics of context management:

- Archived Stored: Raw message tokens preserved in local SQLite storage.
- Active Summaries: Compact summary tokens occupying active prompt window space.
- Compression Ratio: Multiplier of archived original tokens over in-context summaries (e.g. 45.4×).
- Payback Status: Fold generation cost (summary tokens plus prefix re-cache penalty) is amortized against ongoing egress avoidance. Most folds break even within 1 to 2 turns, indicated by a checkmark (`✓`) in the status chip and detailed payback turn counts in the workbench and web dashboard.
## Workbench

Open with `/fold` or `Alt+F`.

- Overview: context map, occupancy split, vault storage KPI tiles, and payback status.
- Trajectory: 1:1 discrete round bars, cache read rates, and fold markers.
- Blocks: fold list, lifecycle, summaries, and unfold actions.
- Zones: pinned, folded, compressible, and protected regions with uncovered run auditing.
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

`/fold web` starts a token-protected loopback server on port 3780, falling back through 3789. It shows context and cache trajectories with synchronized brush zoom, protected zones, uncovered mid-history runs, fold candidates, block details, agent-session hierarchy, FTS5 search over fold summaries and archived original messages, and a real-time tool execution audit log with frustration-loop diagnosis.

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

## Local data

- `~/.omp/agent/origami.db`: fold metadata, archived originals, FTS5 indexes, and cache telemetry. It follows `PI_CODING_AGENT_DIR` when set.
- Corrupt databases are moved to `origami.db.corrupt-<timestamp>` and recreated; session journals remain the block source of truth.
- All sessions in one `omp` process share one database connection.
- File unfolds and `/fold export` write into the active OMP session artifact directory.
- If a database write fails while OMP is running, Origami keeps the journal-backed fold and disables persistence for that session rather than leaving a partial fold transaction.

## Cache behavior

Folding changes the cached prefix once, so Origami waits for meaningful context growth and reclaimable history. File unfold is cache-safe; inline unfold rewrites active context. The trajectory UI marks expected post-fold rebuilds so they can be distinguished from provider TTL expiry.
