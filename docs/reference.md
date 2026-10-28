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

## Workbench

Open with `/fold` or `Alt+F`.

- **Overview:** context map, occupancy split, and reclaimed tokens.
- **Trajectory:** context use, cache read rates, and fold markers.
- **Blocks:** fold list, lifecycle, summaries, and unfold actions.
- **Zones:** pinned, folded, compressible, and protected regions.

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

`/fold web` starts a token-protected loopback server on port 3780, falling back through 3789. It shows context and cache trajectories, protected zones, fold candidates, block details, agent-session hierarchy, FTS5 search over fold summaries and archived original messages, and a real-time tool execution audit log with frustration-loop diagnosis.

The API rejects missing tokens, foreign origins, non-loopback hosts, and invalid mutation bodies.

## Agent tools

| Tool | Purpose |
|---|---|
| `fold` | Fold raw message ranges or merge existing blocks. |
| `unfold` | Restore a block to a file or inline; `deep: true` reaches raw messages. |
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
