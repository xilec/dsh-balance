# cost-anomaly-indicators Specification

## Purpose
Names the cost problems inside one session's estimate: deterministic detectors read the per-Step
series and report Findings — spikes, retry storms, context growth, compaction bills, cache misses,
tariff effects — each carrying the threshold it cleared and the numbers that cleared it.

## Requirements

### Requirement: Indicator catalogue

The plugin SHALL detect the Indicators below over the per-Step series of one session. Every
Indicator MUST be a deterministic function of that series and of the effective thresholds: it MUST
NOT call a model, touch the network, read the clock or use randomness. The thresholds in the table
are the `balanced` Sensitivity preset; the Signal column states the default.

| id | detects | signal and default threshold | confidence inputs |
|----|---------|------------------------------|-------------------|
| `spike` | a single Step that dominates | Step cost > median + 6·MAD, or > p95 and > 5× median | margin above the threshold, MAD z-score, share of the session |
| `retry-storm` | a Step or Turn fighting retries | ≥ 2 retries in one Step, or ≥ 3 retried Steps in one Turn | retry count, share of cost spent on retried Steps |
| `context-growth` | cost rising with the context | monotone or linear fit over ≥ 8 consecutive Steps | fit quality (R²), slope against the session median |
| `post-compaction-spike` | the compaction bill | a Compaction step together with the Step it made expensive | distance to the compaction, magnitude against the session median |
| `cache-miss` | context resent instead of reused | `uncachedInput` high while `cacheRead` ≈ 0 across consecutive Steps, once the session has shown a cache in use | share of uncached input, consecutive count |
| `tool-output-inflation` | a large tool result paid for by the next Step | a large `tool_result` followed by a Step whose input tokens jump | result size against the next Step's input delta |
| `verbose-output` | unusually long generation | `output` tokens far above the session's own norm | z-score of output tokens, cost share, count of affected Steps |
| `expensive-subtree` | one subagent subtree dominating | the loaded subtree's cost above 30% of the anchoring session's own estimate | child share, child depth, Step count |
| `tariff-attributable` | cost caused by the tariff window, not by volume | cost that disappears in the `offPeak` Tariff projection | off-peak delta share, affected Steps |
| `pricing-gap` | totals that understate reality | Unpriced models present | unpriced Step count and token volume |

#### Scenario: A catalogue entry fires

- **WHEN** a fixture triggers one Indicator's signal and clears its threshold
- **THEN** a Finding of exactly that `kind` is reported and references the Steps the fixture blames

#### Scenario: Detection is free

- **WHEN** any Indicator runs
- **THEN** no network request and no model call is made, and no workspace file is read or written

### Requirement: Finding shape

A Finding SHALL be a record `{kind, refs, severity, confidence, evidence}`. `kind` MUST be one of
the catalogue ids. `refs` MUST address nodes of the same series response by their position in it —
`from`, `to` and the `turn`/`step` of both ends — so that a reader can select a Step and a client can
filter by a visible range without re-deriving positions. A Finding whose subject is a Turn MUST be
expressed as the range of that Turn's Steps rather than as a separate reference kind. `evidence` MUST
be structured numbers, not a sentence: the metric, the measured value, the threshold it cleared, the
sample it was measured over, its share of the session cost where the Indicator blames money, and —
for the Indicators that compare against a measured norm — the baseline they compared against (the
session median, its MAD, its p95 or its mean).

#### Scenario: A Step Finding

- **WHEN** an Indicator blames one Step
- **THEN** its `refs.from` and `refs.to` name that Step alone, and the evidence names the value, the threshold and the baseline

#### Scenario: A Turn or range Finding

- **WHEN** an Indicator blames several Steps, whether they are consecutive or a whole Turn
- **THEN** `refs` spans them from the first to the last by position

### Requirement: Confidence and severity

`confidence` SHALL be a whole number in 0–100, computed as the product of three factors — the margin
by which the threshold was cleared, the size of the sample the verdict rests on, and the completeness
of the evidence — and MUST be monotone in the margin: with everything else equal, a larger margin
never yields a smaller confidence. `severity` MUST be one of `info`, `warn`, `alert`, derived from
that same margin factor alone, so that it restates the margin rather than judging the Finding a
second time. An Indicator MUST stay silent below its reporting floor: no Finding, no badge, no row.
The UI MUST state, wherever a confidence is shown, that it is a ranking aid and not a probability.

#### Scenario: Margin monotonicity

- **WHEN** two fixtures differ only in how far past the threshold the measured value sits
- **THEN** the larger margin reports the greater confidence, and the severity never decreases

#### Scenario: Below the floor

- **WHEN** a Step clears an Indicator's threshold but stays under its reporting floor
- **THEN** nothing is reported for it

### Requirement: Detection population

Detection SHALL run on the `fact` Tariff projection regardless of the projection or metric the
reader has selected, and SHALL take its baseline statistics from the whole session rather than from
the visible range, so that zooming never redefines what is normal.

Statistical Indicators MUST stay silent on a session with fewer than eight Steps with usage.
Money-based Indicators MUST skip Unpriced Steps, because their cost is unknown rather than zero;
token-based Indicators MUST still read them. Compaction steps MUST be ignored by every Indicator
except `post-compaction-spike`. `pricing-gap` MUST be reported once per session, over the range of
its Unpriced Steps, and MUST NOT add per-Step Findings to Steps that already carry the unpriced mark.

#### Scenario: Projection switch does not move the verdict

- **WHEN** the reader switches the Tariff projection from `fact` to `offPeak` or `peak`, or the
  metric to output tokens
- **THEN** the same Findings, with the same confidence, are shown

#### Scenario: Short session

- **WHEN** a session has usage in fewer than eight Steps
- **THEN** no statistical Indicator is reported, while rule-based ones may still fire

#### Scenario: Unpriced Steps

- **WHEN** Steps are Unpriced
- **THEN** money-based Indicators ignore them and `pricing-gap` reports the range once

#### Scenario: Compaction is not a Step

- **WHEN** a Compaction step is in the series
- **THEN** it is not itself reported as a spike, a verbose Step or a cache miss, and only
  `post-compaction-spike` refers to it

### Requirement: Detection travels with the series

The Host SHALL compute Findings while it builds the series of one session and SHALL return them in
the same response, together with the effective thresholds and the active Sensitivity preset. The
client MUST NOT derive a threshold of its own. Findings MUST be recomputed whenever the series is
rebuilt — including on the live tail — and MUST NOT be sticky: a Finding that the grown series no
longer supports disappears, and no dismissal state is kept. Detection MUST run on the series the
response carries, after pricing and after subagent spawns are attached.

#### Scenario: One request

- **WHEN** the reader opens the Cost view of a session
- **THEN** the series response carries the Findings, the thresholds and the preset, and no second
  request is made for them

#### Scenario: The tail recomputes

- **WHEN** new usage changes the session and the client re-requests the series
- **THEN** the Findings are recomputed from the whole series and a Finding the new series no longer
  supports is gone

### Requirement: Visible-range behaviour

Brushing, panning or zooming MUST NOT request the series again: the badges and the findings list
SHALL be recomputed from the Findings already held by the client. A Finding SHALL be shown when at
least one Step it references is visible, its badge MUST be drawn only on visible Steps, and the list
MUST mark a Finding whose range extends beyond the visible range.

#### Scenario: Partially visible range

- **WHEN** the visible range covers only part of a Finding's range
- **THEN** the Finding is listed, is marked as reaching beyond the visible range, and carries a badge
  only on the visible Steps it references

#### Scenario: Nothing in view

- **WHEN** no Finding references a Step in the visible range
- **THEN** the list states that this range has no findings

### Requirement: Indicators on the chart

The chart SHALL draw one aggregated badge per Step, holding the glyph of that Step's top-ranked Finding —
the same `severity × confidence` rank the list is ordered by — and the count of the others. Findings of `info` severity MUST NOT be drawn as badges. When
badges would crowd the chart, the ones with the highest `severity × confidence` SHALL be drawn and
the rest left to the list. Badges MUST coexist with the marks the chart already carries — spawn
markers, Unpriced Steps, clipped points and in-progress Steps — and MUST NOT hide them. Activating a
badge SHALL select that Step, exactly as selecting its point does.

#### Scenario: Several Findings on one Step

- **WHEN** three Indicators blame the same Step
- **THEN** that Step carries one badge naming the top-ranked kind and counting three

#### Scenario: Info stays in the list

- **WHEN** a Finding is of `info` severity
- **THEN** it appears in the list and draws no badge

#### Scenario: Badge selects its Step

- **WHEN** the reader activates a badge
- **THEN** the Step is selected and its inspector is available

### Requirement: Findings list

The Cost view SHALL show the Findings of the visible range as a card of the same height beside the
two readings it already shows under the chart, scrolling inside itself rather than extending the
page. The list SHALL be ordered by `severity × confidence`, ties broken by the Finding's share of the
session cost, then by the earlier position, then by `kind`. Each row MUST name the Indicator, the
location it blames, its severity, its confidence as a ranking aid, and its evidence; activating a row
SHALL select the Step it starts at.

#### Scenario: Order is stable

- **WHEN** the same series is rendered twice
- **THEN** the list is in the same order both times

#### Scenario: Row selects its Step

- **WHEN** the reader activates a row
- **THEN** the Step the Finding starts at is selected on the chart and in the inspector

### Requirement: Indicator explanation

Hovering or opening a Finding SHALL explain what its Indicator detects and which of that Step's
numbers cleared which threshold, using the effective thresholds from the payload. The explanation
MUST state that the confidence ranks suspicion inside the Session cost estimate and MUST NOT present
a Finding as a claim about real billing.

#### Scenario: Explanation names the numbers

- **WHEN** the reader opens a `spike` Finding
- **THEN** the explanation names the Step's cost, the session median, the MAD z-score and the share
  of the session, and says the confidence is a ranking aid

### Requirement: Indicator configuration

The plugin SHALL take a Sensitivity preset — `strict`, `balanced` (default) or `loose` — together
with per-Indicator threshold overrides from its plugin configuration, so that tuning needs no code
change. A preset MUST move every reporting floor and every gate it ships by a documented factor rather
than substituting a second table, a threshold given explicitly MUST be used as written rather than
scaled, and the calibrated rates the detectors compare against (`reference`, `minR2`,
`uncachedShare`, `cacheReadShare`, and the `pricing-gap` floor) MUST stay where they are in every
preset. Unknown Indicator ids and unknown threshold fields MUST be dropped
with a warning in the log instead of failing the plugin, following the existing handling of fallback
rates. The effective thresholds and the active preset MUST travel in the series response, and the UI
SHALL show them without offering a live edit.

#### Scenario: Preset moves everything

- **WHEN** the preset changes from `balanced` to `strict`
- **THEN** every Indicator's threshold and floor that the configuration did not name moves by the
  documented factor together, and a named threshold keeps its configured value

#### Scenario: Bad configuration is survivable

- **WHEN** the configuration names an unknown Indicator or an unknown field
- **THEN** that entry is dropped, a warning is logged, and detection runs on the remaining values

### Requirement: Determinism and cost of detection

The same series and the same effective thresholds MUST yield the same Findings, in the same order and
with the same evidence numbers, on every run. Detection SHALL be computed in a bounded number of
passes over the series — a constant number of passes, however many Steps there are — and MUST stay within 50 ms for a series of
10⁴ Steps on the Host; filtering the held Findings for the visible range MUST stay within 4 ms on the
client, including while zooming.

#### Scenario: Same input, same output

- **WHEN** the same session log is folded and detected twice
- **THEN** both runs produce identical Findings

#### Scenario: A long session

- **WHEN** a series of 10⁴ Steps is detected
- **THEN** detection completes within the stated budget and the chart stays interactive

### Requirement: Findings of a subtree

`expensive-subtree` SHALL be computed only from a subtree the reader has already asked for, and its
Findings SHALL be shown on the subtree reading of the view. Detection MUST NOT read a child session on
its own initiative, and a Finding about a subtree MUST NOT appear on the reading that covers the
session alone.

#### Scenario: Subtree not loaded

- **WHEN** the reader has not asked for the subtree
- **THEN** no `expensive-subtree` Finding is reported and no child session is read

#### Scenario: Subtree loaded

- **WHEN** the subtree has been read
- **THEN** `expensive-subtree` is reported on the subtree reading when its share clears the threshold,
  while the session's own reading still lists only its own Findings

### Requirement: Indicator and compaction records in the export

The history export SHALL carry one `indicator` record per Finding of the exported session, holding
`kind`, `refs`, `severity`, `confidence` and the structured `evidence`, with `t` set to the instant
the Finding's first referenced Step starts and `seq` set to that Step's log sequence. It SHALL carry
one `compaction` record per compaction that the session paid for, holding the compaction id, the
model that wrote the summary, the usage of that call, its cost under all three Tariff projections,
the number of shadowed tokens and the Turn it is anchored to — a compaction has no Step of its own —
or no anchor at all when it precedes the session's first Turn. Both record types MUST obey the ordering the export already guarantees.

#### Scenario: Export carries the findings

- **WHEN** the reader exports a session whose series reported Findings
- **THEN** the stream contains one `indicator` record per Finding, with the same kind, refs, severity,
  confidence and evidence, ordered with the other records by `t` and then `seq`

#### Scenario: Export carries the compaction bill

- **WHEN** the session paid for a compaction
- **THEN** the stream contains a `compaction` record for it with its usage, its three projected costs
  and its shadowed token count
