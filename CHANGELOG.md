# Changelog

## Unreleased

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
