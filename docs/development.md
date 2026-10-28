# Development

## Setup and checks

```bash
bun install
bun run typecheck
bun test
bun run bench -- --turns 200 --assert --json benchmark.json
```

## Host compatibility

Runtime peer dependencies support OMP `>=18.6.0` with no upper bound. Development dependencies stay pinned to the current host so CI catches forward changes. The floor was verified by installing each host version in isolation, loading the extension, rendering its ANSI surfaces, and typechecking `src/` (18.6.0, 18.10.0, 18.12.2, 18.13.2 pass; 18.3.0 and earlier lack `@oh-my-pi/pi-coding-agent/config/registry` and `ExtensionContext.agent`).

Native (Tern) rendering is optional. `src/ui/native.ts` loads the `@oh-my-pi/pi-tui/native/*` and `tools/native-view` modules dynamically; when they are unavailable, the workbench, transcript banner, and inline tool views fall back to ANSI. Import native builders only through that module, never statically.

The test preload in `bunfig.toml` redirects `PI_CODING_AGENT_DIR` to a temporary directory so tests never migrate or write the user's live Origami database.

## Benchmark

`bun run bench` executes a seeded long session through the real engine and compares it with an uncompressed baseline.

```bash
bun run bench -- --turns 400 --seed 7 --window 200000 \
  --preset balanced --fact-keep 0.85 --promotion mass --assert --json out.json
```

Metrics include peak and mean context, constraint survival, fact recall, cache hit rate, relative input cost, tier growth, nudges, rejected folds, and invariant violations. `--promotion growth` compares growth-derived Tier 2/3 thresholds with the default summary-mass thresholds.

`--assert` fails when invariants or facts are lost, no Tier 1 fold occurs, or input cost exceeds 70% of the uncompressed baseline. CI uploads the JSON result.

Reference result: lean preset, 1,200 turns, 64K window, seed 7. Mass promotion peaked at 33.5K context and 8.7% of baseline input cost with two Tier 2 merges. Growth promotion peaked at 41.9K and 10.4% with no merge. Both retained all constraints with zero lost facts and zero invariant violations.

## Release

GitHub plugin installation is the supported distribution channel. For a release:

1. Update `CHANGELOG.md` and `package.json`.
2. Run the full verification and production extension smoke test.
3. Commit and push `master`.
4. Create and push an annotated `vX.Y.Z` tag.

There is no npm publication workflow.

## Design references

Origami follows the incremental hierarchical context-folding model and trajectory visualization introduced by [`ranxianglei/billion-context`](https://github.com/ranxianglei/billion-context) and its paper, [*Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents*](https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md).
