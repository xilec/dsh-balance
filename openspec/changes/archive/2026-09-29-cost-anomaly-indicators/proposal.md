# Proposal

## Why

The Cost view shows the shape of a session's estimate but names nothing: on a session of 10⁴ Steps
the reader still has to eyeball where the money went, and the expensive patterns — one Step that
dominates, the same call three times, context growing step by step, a cache lost to a compaction —
are exactly the ones a human eye misses on a decimated plot. The per-Step model already carries
every input these patterns need, so naming them costs nothing: no model call, no network, no new
data source. The chart shows the shape; indicators say what is wrong with it.

## What Changes

- New capability `cost-anomaly-indicators`: ten deterministic detectors over the per-Step series
  (`spike`, `retry-storm`, `context-growth`, `post-compaction-spike`, `cache-miss`,
  `tool-output-inflation`, `verbose-output`, `expensive-subtree`, `tariff-attributable`,
  `pricing-gap`), each reporting a Finding
  `{kind, refs, severity, confidence, evidence}` with a threshold it must clear before it is
  reported at all.
- Detection runs on the Host while the series is built, on `fact` cost, against a session-wide
  baseline, and travels inside the existing series response together with the effective thresholds
  and the active Sensitivity preset. The client derives no threshold of its own.
- The Cost view draws one aggregated badge per Step (none for `info`), adds the findings list as a
  third card in the band under the chart, and filters both by the brushed visible range without
  another round trip.
- The session projection folds `compaction/start|summary|end|prune`, and a compaction becomes a node
  of its own carrying the bill for the summarizing call, so the "session estimate is the sum of its
  Steps" invariant survives an event that belongs to no Step. It is not drawn in the per-Step cost
  line, has no Trajectory target, and is ignored by every indicator except
  `post-compaction-spike`, which reports it together with the Step it made expensive.
- **BREAKING** (data shape, internal to the plugin): a series node gains a `kind`, and the series
  response and the history export gain fields and record types. The Cost view reads both, so the
  client and the Host must ship together; no external consumer is affected.
- The history export vocabulary gains `indicator` and `compaction` records.
- New plugin configuration `anomalies` (preset plus per-indicator thresholds) with unknown keys
  dropped and warned about, mirroring how fallback rates are normalised today.

## Capabilities

### New Capabilities

- `cost-anomaly-indicators`: the indicator catalogue, the Finding it reports, confidence and
  severity, the rules of the population it detects over, host-side computation inside the series
  response, the visible-range behaviour of badges and list, and the indicator and compaction records
  of the history export.

### Modified Capabilities

- `session-cost-analysis`: the per-Step series model now includes compaction nodes and the node
  `kind`; the series payload now carries findings, the effective thresholds and the active preset;
  the history-export vocabulary now includes `indicator` and `compaction` records.

## Impact

- `src/session-cost.js` — the fold gains `compaction/*`, the node model gains `kind`, and the
  detector engine runs in the same pass that builds the series.
- `src/index.js` — plugin config gains `anomalies` with the existing normalisation pattern; the
  series route and the subtree route ship findings, thresholds and the preset.
- `client/client.js` — aggregated badges on the chart, the findings card under it, the indicator
  explanation in the tooltip, and the two new export record types.
- `test/` — the session-cost fixture generator gains anomaly scenarios; new positive and negative
  cases per indicator, a determinism case, and export-shape cases.
- `CONTEXT.md` — the glossary gains Indicator, Finding, Severity, Sensitivity preset and Compaction
  step.
- No new runtime dependency, no new route, no network call, nothing written to disk.
