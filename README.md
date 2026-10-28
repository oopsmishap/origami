# Origami

Incremental, reversible hierarchical context folding for [`oh-my-pi`](https://omp.sh) (`omp`).

Origami replaces destructive full-window compaction with model-driven, range-based context folding. As a session grows, it compresses completed conversation spans into summary blocks in measured steps so prompt-cache prefixes stay intact, active work and pinned context remain unchanged, and any folded block can be searched or restored on demand.

Origami is a native [`oh-my-pi`](https://omp.sh) implementation inspired by [`billion-context`](https://github.com/ranxianglei/billion-context) and the paper [*Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents*](https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md).

---

## Features

- Incremental, reversible folding: compresses completed older spans while leaving your initial prompt, recent turns, and active work untouched. Any block can be unfolded to a sidecar artifact file (cache-safe) or restored inline in context.
- Stable prompt-cache prefixes: waits for configurable growth thresholds before proposing folds instead of rewriting history on every turn.
- Three compression tiers with an explicit block lifecycle (`active` → `consumed` / `unfolded`):
  - Tier 1 compresses raw message ranges (`m00012..m00048`) into structured summary blocks.
  - Tier 2 merges two or more Tier 1 blocks (`b1..b5`, `b1,b4`) into a denser milestone summary; the merged blocks are consumed, so every source message is represented exactly once in context.
  - Tier 3 condenses lower-tier blocks across long sessions while retaining goals, constraints, and open objectives.
- Protected recent zone: the newest messages (by count and tokens, widened to whole turns) and everything from the latest user message onward are never folded or proposed. Finished `fold` call/result pairs are hidden from the rendered context so fold bookkeeping does not accumulate.
- Fold benefit floor: a Tier 1 fold batch must reclaim at least `max(minFoldBenefitTokens, minFoldBenefitWindowPct × window)` tokens (waived in emergencies), so the cache prefix is never broken for a trivial saving.
- Block age: each block tracks how many later folds it has survived (`young` / `old`); only blocks older than `blockMatureFolds` are proposed for tier merges.
- Advisory nudges: efficiency nudges list candidate ranges largest first with size, message count, and tool-output share; the model may fold a subset or defer, and a deferred nudge returns only after another half growth step. Promotion nudges suggest tier merges once summary mass crosses `tier2MassTokens` / `tier3MassTokens`. Emergency nudges (window nearly full) are mandatory.
- Durable originals: folded messages are archived in SQLite, so `fold_recall` and file unfolds still work after a branch switch, and `fold_search` finds archived messages by content.
- Invariant checks: every status report verifies that no message is covered twice, no active block has an active child, and no active block has drifted off the current branch.
- Native `oh-my-pi` UI: integrates into `omp` with collapsible transcript dividers, a live status-bar chip, an interactive TUI and Tern workbench (`/fold`, `Alt+F`), and a browser dashboard (`/fold web`). All surfaces share a process-wide session registry that tracks the main agent and its subagents, so the chip and dashboard stay on the main session while subagents run, and either surface can switch to any session in the hierarchy.
- Host compaction guard: disables destructive host auto-compaction so Origami manages context end-to-end, with an automatic archive safeguard if window occupancy hits critical thresholds.

---

## Installation

Requires [`oh-my-pi`](https://omp.sh) (`omp`). Choose any installation method below.

### Option 1: Install from Git (Recommended)

Install directly from GitHub. `omp` supplies its own extension API and TUI packages, so the plugin does not download a second copy of the host dependency tree:

```bash
omp plugin install github:oopsmishap/origami
```

Manage or update the plugin at any time:

```bash
omp plugin list
omp plugin upgrade origami
omp plugin disable origami
omp plugin enable origami
omp plugin uninstall origami
```

For a development checkout, clone and link it instead:

```bash
git clone https://github.com/oopsmishap/origami.git
cd origami
bun install
omp plugin link .
```

### Option 2: Auto-Discovered Extension Directory

Clone Origami, install its runtime dependencies, then symlink it into `oh-my-pi`'s native extension directory:

```bash
git clone https://github.com/oopsmishap/origami.git
cd origami
bun install

# Global (enabled for all projects)
ln -s "$PWD" ~/.omp/agent/extensions/origami

# Project-local (enabled for a single workspace)
ln -s "$PWD" /path/to/project/.omp/extensions/origami
```

### Option 3: Explicit Configuration or Single Session

After cloning Origami and running `bun install` in its directory, reference that directory in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/origami
```

Or load Origami for a single session from the command line:

```bash
omp --extension /path/to/origami
```

---

## Quick Start

Origami uses the `balanced` preset by default and needs no manual setup.

1. Work as usual in `omp`. Once your session grows past the configured growth step, Origami prompts the agent to fold completed older spans while leaving recent turns intact.
2. Check the footer status chip for live session metrics:
   ```text
   origami 11% · 12.4K↑/50.0K · 2b -50.8K
   ```
   - `11%`: current context window occupancy.
   - `12.4K↑/50.0K`: context growth since the last fold relative to `growthStep`.
   - `2b -50.8K`: active folded blocks and total tokens reclaimed.
3. Expand folded blocks in chat when needed. Folded spans render in the transcript as horizontal dividers showing the block ID, tier, token reduction, and topic. Press `Ctrl+O` (or click the divider in Tern) to toggle the summary.
4. Press `Alt+F` or run `/fold` to open the terminal workbench, or run `/fold web` to open the browser dashboard.

> **Subagents:** Origami stays dormant in subagents below `40,000` projected tokens by default so short delegated tasks incur zero overhead. The status chip always shows the main session plus a `· N sub` count of running subagents.

---

## Commands & Shortcuts

| Command / Shortcut | Action |
|---|---|
| `/fold` or `Alt+F` | Open the interactive Origami Workbench (`Overview` tab) |
| `/fold trajectory` | Open the Workbench directly on the `Trajectory` tab (aliases: `/fold graph`, `/fold chart`) |
| `/fold blocks` | Open the Workbench directly on the `Blocks` tab |
| `/fold zones` | Open the Workbench directly on the `Zones` tab |
| `/fold web` | Launch and open the live Web Dashboard in your browser (alias: `/fold dashboard`) |
| `/fold export` | Write this session's blocks, cache rounds, and archived messages to a JSON artifact |

---

## Interactive Workbench (`/fold` / `Alt+F`)

The Workbench overlay runs in both terminal (ANSI TUI) and native Tern surfaces with four tabs:

- `Overview`: proportional 2D context map, occupancy breakdown (system/harness overhead, live conversation, tool definitions, fold summaries, free headroom), and reclaimed token totals.
- `Trajectory`: context window usage over time paired with prompt-cache read rates and fold markers.
- `Blocks`: navigable list of folded blocks with tier, message coverage, token compression ratio, and status (`active`, `consumed` into a higher tier, or `unfolded`).
- `Zones`: token-weighted map of pinned head messages, folded summaries, compressible history, and protected recent turns.

### Keyboard Controls

| Key | Action |
|---|---|
| `1` – `4` | Jump directly to `Overview`, `Trajectory`, `Blocks`, or `Zones` |
| `Tab` / `Shift+Tab` / `←` `→` / `h` `l` | Cycle between tabs |
| `↑` `↓` / `j` `k` | Select a fold block (or scroll line-by-line inside block detail view) |
| `PgUp` / `PgDn` | Scroll page-by-page inside block detail view |
| `Enter` | Open full summary & metadata for the selected block (`Esc`, `Backspace`, or `Enter` returns) |
| `u` | Unfold selected block to an artifact file (preserves prompt-cache prefix) |
| `i` | Unfold selected block inline (reactivates original messages in live context) |
| `f` | Preview candidate message ranges for the next fold |
| `s` / `S` | Focus the next / previous session in the agent hierarchy (shown when subagents exist; ended sessions are read-only) |
| `q` / `Esc` | Close the Workbench |

---

## Live Web Dashboard (`/fold web`)

Running `/fold web` starts a local server at `http://127.0.0.1:3780` (falling back to ports `3780–3789` if `3780` is busy) and streams live Server-Sent Events updates as turns complete and folds run. Each launch generates a random access token embedded in the opened URL; the API rejects requests without it, from foreign `Origin`s, or with a non-loopback `Host`, and mutating requests additionally require a JSON body and the `X-Origami-Token` header.

- Context trajectory and cache hit rate: synchronized charts for total input tokens, cached prefix tokens, fold boundaries, and uncached gap causes (cold start, post-fold cache rebuild, prefix seam, or cache TTL expiry).
  - Click and drag horizontally across either chart to zoom both charts to a request range; double-click or press `Esc` to reset.
  - Toggle the trajectory Y-axis between `Y: Auto` (data fit) and `Y: Window` (full context window ceiling).
- Context zones and next-fold candidates: token-weighted zone bar and preview of eligible message spans approaching the fold threshold.
- Slide-over block inspector: click any row in the Fold Blocks table to read its full markdown summary and trigger Unfold to File or Unfold Inline from the browser.
- Session selector: an indented tree of the main session and its subagents (including recently ended ones). By default the dashboard follows the main session; picking a session pins it for the browser tab. Live updates are filtered to the selected session.
- Full-text search: ranked search across folded block topics and summaries in your local store with `tier:<1|2|3>` and `session:<id>` filters.
- Theme toggle: switch between dark and light themes in the header.

---

## Agent Tools

Origami registers six inline tools that the model uses automatically and that you can also ask the agent to invoke in conversation (for example, *"search folded blocks for the database schema decision"* or *"unfold b2 to a file"*):

| Tool | Purpose |
|---|---|
| `fold` | Compress completed message ranges (Tier 1) or distill existing blocks (Tier 2 & Tier 3). |
| `unfold` | Reconstruct a folded block's original messages to an artifact file (`mode: "file"`, default) or restore it inline (`mode: "inline"`). Inline unfold of a merged block restores its child blocks; `deep: true` unfolds all the way to raw messages. A consumed child cannot be unfolded before its parent. |
| `fold_recall` | Read the original text of specific refs (`"m00042..m00045,m00051"`, max 64) without changing context. Falls back to the SQLite message archive for refs no longer on the current branch. |
| `fold_search` | Full-text search (BM25, stemmed) over folded block topics and summaries (active blocks first) and over archived original messages; message hits carry refs for `fold_recall`. Multi-term queries match all terms, falling back to any term. Supports `tier:1`–`tier:3` (blocks only) and `session:<id>` filter prefixes. |
| `fold_status` | Report current window occupancy, token breakdown, growth since last fold, active blocks, and protected zones. |
| `fold_cache` | Inspect per-round prompt-cache hit rates and cache savings across folds. |

---

## Configuration

Origami works without a configuration file. To customize behavior, create an `origami.yml` file at either or both locations (project settings override global settings):

1. Global: `~/.omp/agent/origami.yml`
2. Project: `<project>/.omp/origami.yml`

### Presets

| Preset | `growthStep` | `compressibleFloor` | `emergencyFillPct` | `elideFillPct` | `protectedTailMessages` / `Tokens` | `tier2MassTokens` / `tier3MassTokens` | `minFoldBenefitTokens` / `WindowPct` | `blockMatureFolds` | Best For |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `balanced` *(default)* | `50,000` | `22,500` | `0.85` (85%) | `0.95` (95%) | `5` / `5,000` | `15,000` / `22,500` | `5,000` / `0.01` | `2` | Everyday coding sessions with strong cache retention |
| `lean` | `20,000` | `10,000` | `0.80` (80%) | `0.92` (92%) | `4` / `3,000` | `8,000` / `12,000` | `2,000` / `0.005` | `1` | Smaller context windows or tight token budgets |
| `relaxed` | `100,000` | `40,000` | `0.90` (90%) | `0.97` (97%) | `8` / `10,000` | `30,000` / `45,000` | `10,000` / `0.01` | `3` | Large-window models (200K–1M) prioritizing maximum verbatim history |

### Configuration Options

| Key | Type | Default | Description |
|---|---|---|---|
| `preset` | `"balanced" \| "lean" \| "relaxed"` | `"balanced"` | Base threshold profile; individual keys below override preset values. |
| `growthStep` | `number` | Preset value | Tokens of new context growth since the last fold before nudging a new fold. |
| `compressibleFloor` | `number` | Preset value | Minimum eligible compressible tokens required before proposing a fold. Must be strictly less than `growthStep`. |
| `subagentActivateTokens` | `number` | `40000` | Minimum projected tokens before Origami activates inside subagent sessions. |
| `emergencyFillPct` | `number` `(0, 1)` | Preset value | Window occupancy fraction that triggers an urgent fold prompt regardless of `growthStep`. |
| `elideFillPct` | `number` `(0, 1)` | Preset value | Window occupancy fraction above `emergencyFillPct` where oldest compressible spans are archived automatically to prevent overflow. |
| `protectedTailMessages` | `integer ≥ 0` | Preset value | Minimum number of newest messages that can never be folded. |
| `protectedTailTokens` | `integer ≥ 0` | Preset value | Minimum tokens of newest messages that can never be folded. The tail covers both minimums, widened to whole turns. |
| `tier2MassTokens` | `number` | Preset value | Summed size of active Tier 1 summaries at which a Tier 2 merge is suggested. |
| `tier3MassTokens` | `number` | Preset value | Summed size of active Tier 2 summaries at which a Tier 3 merge is suggested. |
| `minFoldBenefitTokens` | `integer ≥ 0` | Preset value | Minimum tokens a Tier 1 fold batch must reclaim (outside emergencies). |
| `minFoldBenefitWindowPct` | `number` `[0, 1)` | Preset value | Same floor as a fraction of the window; the larger of the two applies. |
| `blockMatureFolds` | `integer ≥ 0` | Preset value | Later folds a block must survive before it is proposed for a tier merge. |
| `retentionDays` | `integer ≥ 0` | `0` | Delete stored blocks, rounds, and archived messages older than this many days at session start, across all sessions. `0` keeps everything. |
| `language` | `"preserve" \| "english"` | `"preserve"` | `"preserve"` keeps summaries in the conversation's language; `"english"` standardizes summaries in English. |

### Example `origami.yml`

```yaml
preset: balanced
growthStep: 60000
compressibleFloor: 25000
subagentActivateTokens: 40000
emergencyFillPct: 0.85
elideFillPct: 0.95
language: preserve
```

---

## Local Data & Storage

- Fold store and search index: `~/.omp/agent/origami.db` stores block history and status, FTS5 full-text indexes (porter-stemmed) over blocks and archived messages, archived originals of folded messages, and per-round cache telemetry (follows `PI_CODING_AGENT_DIR` when set). The schema is versioned and migrated in place; a database that fails its integrity check is moved aside as `origami.db.corrupt-<timestamp>` and recreated (session journals remain the source of truth for blocks). All sessions in one `omp` process share a single connection.
- Unfolded artifacts: unfolding a block in `file` mode (`u` in the Workbench or `unfold` with `mode: "file"`) writes the reconstructed messages to the active `oh-my-pi` session artifact directory.
- Exports: `/fold export` writes the session's stored data as JSON to the session artifact directory.

---

## Benchmark

`bun run bench` runs a deterministic marathon session (seeded generator, scripted model that obeys nudges with a doctrine-shaped summarizer) through the real engine and compares it with an uncompressed baseline: peak/mean context, constraint survival, fact recall (in context / restored via recall / lost), prompt-cache hit rate, relative input cost, tier growth, nudge counts, rejected folds, and invariant violations.

```bash
bun run bench -- --turns 400 --seed 7 --window 200000 --preset balanced --fact-keep 0.85 --promotion mass --json out.json
```

`--promotion growth` replaces the mass-based tier merge thresholds with growth-based ones (`growthStep × 1.5` / `× 2.25`) for comparison. On the lean preset over 1,200 turns with a 64K window (seed 7), mass triggers peaked at 33.5K context and 8.7% of uncompressed input cost (2 Tier 2 merges); growth triggers peaked at 41.9K and 10.4% and never merged. Both kept 100% of constraints with 0 lost facts and 0 invariant violations.

---

## FAQ

**Why didn't Origami fold immediately after a large tool output?**
Origami only proposes a fold once both `growthStep` (new tokens accumulated since the last fold) and `compressibleFloor` (tokens outside protected head/tail zones) are met. Folding too frequently invalidates the prompt-cache prefix and increases cost rather than reducing it.

**Should I unfold to a file (`u`) or inline (`i`)?**
Prefer unfolding to a file (`u` / `mode: "file"`). It writes the exact original messages to a local session artifact that you or the agent can read selectively without mutating past conversation history or invalidating your prompt cache. Use inline unfold (`i` / `mode: "inline"`) only when you want the entire original span permanently restored into the active prompt.

**Why did prompt-cache hit rate dip on a turn?**
Open `/fold trajectory` or `/fold web`. The chart marks expected single-turn cache rebuilds after a fold so you can separate planned fold boundaries from upstream provider cache TTL expirations.

---

## References & Acknowledgments

Origami builds on the incremental hierarchical context-folding model and trajectory visualization introduced by billion-context:

- Original repository: [`ranxianglei/billion-context`](https://github.com/ranxianglei/billion-context)
- Paper: Xianglei Ran, [*Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents*](https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md)

---

## License

MIT
