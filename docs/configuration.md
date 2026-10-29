# Configuration

Origami works without configuration. To customize it, create `origami.yml` globally at `~/.omp/agent/origami.yml` or per project at `<project>/.omp/origami.yml`. Project settings override global settings.

## Presets

| Preset | Growth step | Compressible floor | Emergency / elide | Protected messages / tokens | Tier 2 / 3 mass | Minimum benefit tokens / window | Mature folds | Fill floor (window / cap) | Best for |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `balanced` (default) | 50,000 | 22,500 | 85% / 95% | 5 / 5,000 | 15,000 / 22,500 | 5,000 / 1% | 2 | 45% / 160,000 | Everyday sessions |
| `lean` | 20,000 | 10,000 | 80% / 92% | 4 / 3,000 | 8,000 / 12,000 | 2,000 / 0.5% | 1 | 30% / 100,000 | Smaller windows |
| `relaxed` | 100,000 | 40,000 | 90% / 97% | 8 / 10,000 | 30,000 / 45,000 | 10,000 / 1% | 3 | 55% / 200,000 | Large windows, maximum verbatim history |

## Options

| Key | Type | Default | Purpose |
|---|---|---|---|
| `preset` | `balanced`, `lean`, `relaxed` | `balanced` | Base threshold profile. Other keys override it. |
| `growthStep` | number | Preset | New context growth before an efficiency nudge. |
| `compressibleFloor` | number | Preset | Minimum eligible history before a fold is proposed; less than `growthStep`. |
| `subagentActivateTokens` | number | `40000` | Projected tokens required before Origami activates in subagents. |
| `emergencyFillPct` | number `(0,1)` | Preset | Window occupancy that triggers an urgent fold. |
| `elideFillPct` | number `(0,1)` | Preset | Occupancy that triggers automatic archival to prevent overflow. |
| `protectedTailMessages` | integer ≥ 0 | Preset | Minimum newest messages never folded. |
| `protectedTailTokens` | integer ≥ 0 | Preset | Minimum newest tokens never folded, widened to whole turns. |
| `tier2MassTokens` | number | Preset | Active Tier 1 summary mass before a Tier 2 merge is suggested. |
| `tier3MassTokens` | number | Preset | Active Tier 2 summary mass before a Tier 3 merge is suggested. |
| `minFoldBenefitTokens` | integer ≥ 0 | Preset | Minimum Tier 1 token reclaim outside emergencies. |
| `minFoldBenefitWindowPct` | number `[0,1)` | Preset | Minimum reclaim as a window fraction; the larger floor applies. |
| `blockMatureFolds` | integer ≥ 0 | Preset | Later folds a block must survive before merge eligibility. |
| `minFoldFillPct` | number `[0,1)` | Preset | Advisory folds wait until context reaches this window fraction (capped by `minFoldFillCapTokens`); must be below `emergencyFillPct`. |
| `minFoldFillCapTokens` | integer ≥ 0 | Preset | Cap on the fill floor in tokens; `0` leaves it uncapped. |
| `cacheReadPrice` | number ≥ 0 | Active model / `0.1` fallback | Optional cache-read price override relative to an uncached input token. |
| `outputPrice` | number ≥ 0 | Active model / `4` fallback | Optional output-token price override relative to an uncached input token. |
| `cacheWritePrice` | number ≥ 0 | Active model / `1` fallback | Optional cache-write price override relative to an uncached input token. |
| `cacheTtlMs` | integer ≥ 0 | `300000` | Idle time after which the prompt cache counts as cold, making a fold free of re-pay; `0` never assumes cold. |
| `paybackHorizonTurns` | integer ≥ 0 | `10` | Advisory folds must break even within this many turns; `0` disables the cost gate. |
| `refTags` | boolean | `true` | Prefix user and tool-result messages with their `[#mNNNNN]` ref so summaries can cite them. |
| `recallHintMax` | integer ≥ 0 | `3` | Folded blocks named per `[origami recall]` hint; `0` disables hints. |
| `speculativeFolds` | boolean | `false` | Draft fold candidates in a background side turn for the model to accept, edit or reject. |
| `retentionDays` | integer ≥ 0 | `0` | Delete older stored blocks, rounds, and messages at startup; `0` retains all. |
| `language` | `preserve`, `english` | `preserve` | Preserve conversation language or standardize summaries in English. |

## Example

```yaml
preset: balanced
growthStep: 60000
compressibleFloor: 25000
subagentActivateTokens: 40000
emergencyFillPct: 0.85
elideFillPct: 0.95
language: preserve
```
