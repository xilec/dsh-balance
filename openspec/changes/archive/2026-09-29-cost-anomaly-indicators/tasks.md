# Tasks

## 1. Compaction in the per-Step model

- [x] 1.1 Fold `compaction/start`, `compaction/summary`, `compaction/end` and `compaction/prune` in `src/session-cost.js`, keyed by compaction id, keeping the summary call's usage, model and shadowed token count; verify with `test/session-cost.test.js` cases for a complete start→summary→end sequence, a compaction that never summarised (no cost), and a prune-only event
- [x] 1.2 Give every node a `kind` (`step` for today's nodes, `compaction` for the new ones) and keep `steps` on the wire view counting only nodes of kind `step`; verify the existing series tests pass unchanged plus a new test asserting `kind` on both kinds and the `steps` count on a session with a compaction
- [x] 1.3 Implement the anchoring rule of design I6 — a named Turn, otherwise the Turn whose context it rewrote, otherwise turn-less; verify three tests: compaction inside a Turn placed ahead of the Step it serves, a `turn: null` compaction anchored to the previous Turn, and a compaction with no preceding Turn staying turn-less
- [x] 1.4 Keep the sum invariant over compaction nodes: the session estimate equals the sum of all node costs, compaction nodes included, with per-report rounding unchanged; verify a test summing the nodes of a fixture that contains a compaction against the session total, alongside the existing invariant test
- [x] 1.5 Carry the compaction fields (id, summary model, shadowed token count, anchor Turn or none) through `describeNode` and the node schema; verify a test asserting the fields on the series payload and that the schema rejects a compaction node without an id
- [x] 1.6 Keep a compaction node out of the conversation's Step semantics in the Host: it holds no tool call, is not counted as an in-progress Step, and does not enter the retry or unpriced logic; verify tests that a compaction node has empty `calls`, is never flagged in-progress, and never appears in `unpriced`

## 2. Detector engine and catalogue

- [x] 2.1 Extend `test/fixtures/session-cost-history.generate.mjs` with the anomaly scenarios (a dominating Step over a known median, three identical tool calls, a retry storm, linear context growth, a compaction followed by a cache rebuild, unpriced Steps, a child session) and regenerate the fixtures; verify the generator runs with `node test/fixtures/session-cost-history.generate.mjs` and the checked-in files match its output
- [x] 2.2 Create `src/indicators.js` holding the catalogue table (ids, thresholds, reference multiples, floors) and the shared statistics — one sorted copy for median, MAD and p95, prefix sums for the sliding windows, one grouping by tool name; verify unit tests for the statistics against hand-computed arrays
- [x] 2.3 Implement the margin, severity and confidence helpers of design I10 in `src/indicators.js`; verify tests for monotonicity of confidence in the margin, the three severity bands, and the 0–100 clamp
- [x] 2.4 Implement `spike`, `verbose-output` and `context-growth`; verify a positive and a negative fixture case per Indicator, including a dominating Step that stays below the floor and a short run that must not be fitted
- [x] 2.5 Implement `retry-storm` and `tool-output-inflation`; verify a positive and a negative case per Indicator, including a retried Step and a large tool result whose next Step does not grow
- [x] 2.6 Implement `cache-miss` and `post-compaction-spike`, the latter referencing the Compaction step together with the Step it made expensive (design I16); verify positive and negative cases, and that a compaction without a following Step reports nothing
- [x] 2.7 Implement `tariff-attributable` and `pricing-gap`; verify that a session priced entirely off-peak reports no tariff-attributable Finding, and that unpriced Steps yield exactly one `pricing-gap` Finding over their range
- [x] 2.8 Implement `expensive-subtree` over an already-read subtree series, and only there; verify a positive case on a subtree fixture and a negative case where the child share stays under the threshold
- [x] 2.9 Implement the population rules of design I3, I4, I11 and I14 — `fact` pricing, session-wide baseline, the eight-Step silence for statistical Indicators, Unpriced Steps skipped by money Indicators, Compaction steps ignored by everything but `post-compaction-spike`; verify one test per rule
- [x] 2.10 Address every Finding as node indices with a Turn expressed as a Step range (design I9) and sort the result by `severity × confidence` with the tie-breakers of design I20; verify tests for the reference shape on a Step Finding, a Turn Finding and a range Finding, and for a stable order across two identical runs

## 3. Configuration and the series payload

- [x] 3.1 Add the `anomalies` plugin configuration with the defensive normalisation of design I13 (unknown Indicator id, unknown field or non-positive value dropped with one warning); verify tests for a valid override, an unknown id, an unknown field and a non-numeric value, asserting the plugin still starts
- [x] 3.2 Apply the presets of design I12 as multipliers (strict ×1.5, loose ×0.6) over the `balanced` table for both thresholds and floors; verify a test comparing the effective thresholds of the three presets against the table
- [x] 3.3 Detect during the series build and return Findings, the effective thresholds and the active preset in the series response; verify a `test/plugin-host.test.js` case asserting the payload shape and that two requests over the same log return identical Findings
- [x] 3.4 Memoise detection on `(seq, effective thresholds)` and share the statistics pass across Indicators; verify a timing test over the 10⁴-Step fixture that stays inside the budget of design I24 (50 ms locally, asserted with headroom in CI) and a test that a memoised second read does not recompute
- [x] 3.5 Ship Findings for the subtree route from the subtree series alone, and only when the subtree was asked for; verify tests that the session route carries no `expensive-subtree` Finding, that the subtree route does when the share clears the threshold, and that neither route reads a child without an explicit ask

## 4. Cost view

- [x] 4.1 Draw one aggregated badge per Step — the most severe glyph plus the count, no badge for `info`, priority by `severity × confidence` when crowded (design I19); verify client tests over a synthetic Finding set covering several Findings on one Step, an `info`-only Step and the crowding cap
- [x] 4.2 Add the findings card as the third card of the band under the chart, scrolling inside itself, ordered and clickable through to its Step, with the empty-range sentence of design I18; verify client tests for order, the row-to-Step selection and the empty sentence
- [x] 4.3 Filter the held Findings by the visible range, showing a partially visible Finding with its marker and its note (design I21), and re-filter on brush, zoom and pan without requesting the series; verify a client test that counts series requests across a brush, a zoom and a pan and asserts the count is unchanged
- [x] 4.4 Explain a Finding in the tooltip and the inspector — what it detects, which numbers cleared which threshold, the preset in force and the sentence that confidence ranks suspicion (design I22); verify the existing locale key check passes for both `en` and `ru` and that the explanation renders the effective threshold from the payload
- [x] 4.5 Keep a Compaction step out of the per-Step cost line, give it its own mark at its own instant, its own top-K row labelled as a compaction and no Trajectory action (design I7); verify client tests for a compaction node in the series: not joined to the line, marked, listed and free of a focus target
- [x] 4.6 Memoise the visible-range filter on `(from, to)`; verify a timing test over the 10⁴-Step fixture that stays inside the 4 ms budget of design I24, or that a repeated filter of the same range is served without recomputation

## 5. History export

- [x] 5.1 Emit one `indicator` record per Finding with `t` at the instant its first referenced Step starts and `seq` of that Step, carrying kind, refs, severity, confidence and the structured evidence; verify `test/export.test.js` cases for a Step Finding and a range Finding, asserting the ordering key and the field names
- [x] 5.2 Emit one `compaction` record per compaction the session paid for, with its usage, its three projected costs, the shadowed token count and its anchor, or no anchor for a turn-less compaction; verify an export test over a fixture with both an anchored and a turn-less compaction
- [x] 5.3 Keep the stream ordered by `t` and then `seq` with `meta` first once the two new record types are merged in, including across a parent and child stream; verify an export test sorting a merged stream and asserting the order and the `session`/`depth` fields of the new records

## 6. Integration and documentation

- [x] 6.1 Document the catalogue, the presets and the thresholds in `README.md`, and confirm the glossary terms added to `CONTEXT.md` (Indicator, Finding, Severity, Sensitivity preset, Compaction step) match what shipped; verify the documented configuration example loads by starting the host with it and reading the effective thresholds from the series response
- [x] 6.2 Run the whole suite and the linters — `npm test`, `npm run lint`, `openspec validate --all` — and verify all three are green
- [x] 6.3 Check the feature end to end in the running shell on a real session: badges and the findings card appear, brushing changes the list without a series request, a Finding explains its numbers, and the exported NDJSON carries `indicator` and `compaction` records; verify by downloading the export and inspecting the records alongside the chart
