<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/header-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/header-light.svg">
    <img alt="Origami" src="assets/header-dark.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="#highlights">Highlights</a> ·
  <a href="#install">Install</a> ·
  <a href="#use">Use</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#more-documentation">Documentation</a>
</p>

<br>

Origami keeps long coding sessions usable without destructive full-window compaction. It folds completed older work in measured steps, protects your current task and recent turns, preserves prompt-cache stability, and keeps exact originals searchable and recoverable.

## Highlights

- Automatic multi-tier folding for long sessions.
- Recent turns and the latest user request stay verbatim.
- Folded originals remain available through search, recall, file unfold, and JSON export.
- Runtime safety guards: circuit breaker for failed folds, preflight window checks, tool pair atomicity, and coverage regression protection.
- Native status chip, terminal/Tern workbench, and browser dashboard.
- Main-agent and subagent sessions remain separate and selectable.
- Host auto-compaction is disabled so Origami manages context consistently.

## Install

Requires [`oh-my-pi`](https://omp.sh).

```bash
omp plugin install github:oopsmishap/origami
```

Update or remove it with the normal plugin commands:

```bash
omp plugin upgrade origami
omp plugin disable origami
omp plugin enable origami
omp plugin uninstall origami
```

For development:

```bash
git clone https://github.com/oopsmishap/origami.git
cd origami
bun install
omp plugin link .
```

GitHub plugin installation is the supported release channel; Origami is not published to npm.

## Use

No configuration is required. Work normally in `omp`; Origami prompts the agent when enough completed history is ready to fold.

- Run `/fold` or press `Alt+F` for the interactive workbench.
- Run `/fold web` for the browser dashboard.
- Run `/fold trajectory`, `/fold blocks`, or `/fold zones` to open a specific workbench view.
- Run `/fold export` to save this session's fold history, archived messages, and cache rounds as JSON.

Folded transcript sections show their block ID, tier, token reduction, and topic. Expand them in chat to inspect the summary.

### Status chip

```text
origami 11% · 12.4K↑/50.0K · 2b -50.8K (30.0× ✓)
```

- `11%`: context-window occupancy.
- `12.4K↑/50.0K`: growth since the last fold versus the next fold step.
- `2b -50.8K`: active blocks and reclaimed tokens.
- `(30.0× ✓)`: compression ratio multiplier and amortized payback indicator.
Short subagent tasks stay dormant by default. The main status chip shows how many subagents are running, and the workbench/dashboard can switch between their sessions.

## Restore or search history

Ask the agent naturally, for example:

- “Search folded history for the database schema decision.”
- “Recall messages m00042 through m00048.”
- “Unfold b3 to a file.”
- “Restore b3 inline.”

Prefer file unfold when you only need to inspect old material: it preserves the current prompt-cache prefix. Inline unfold permanently restores that material to active context.

## Configuration

The default `balanced` preset suits normal use. `lean` folds earlier for smaller windows; `relaxed` retains more verbatim history for large windows.

Create `~/.omp/agent/origami.yml` globally or `<project>/.omp/origami.yml` per project:

```yaml
preset: balanced
language: preserve
retentionDays: 0
```

See [Configuration](docs/configuration.md) for every preset and option.

## More documentation

- [Product and UI reference](docs/reference.md)
- [Configuration](docs/configuration.md)
- [Real-world long-context benchmark](docs/benchmark.md)
- [Development, benchmark, and release guide](docs/development.md)
- [Changelog](CHANGELOG.md)
## License

MIT
