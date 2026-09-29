# Design

## Context

See `proposal.md` — Why. This change sits on top of `session-cost-analysis`, which is already
archived and shipped: the Host folds the session log into one node per `(Turn, Step)` (D2, D10),
prices it from the Tariff rule snapshot (D8, D22), keeps the client-visible projection light (D7),
and serves the whole series for one session over an HTTP route (D26, D30). The client is a single
browser file (D4) that owns the chart, the top-K list, the inspector and the export builder (D15,
D45), and it already carries two locales, `en` and `ru` (`client/client.js:245`, `:450`), registered
through `ctx.locale.register`.

Two facts of the current code shape the design:

- The fold sees every event of the session log (`src/index.js:539` reduces the stored log into the
  projection), but it only understands `step/start`, `step/end`, `turn/end`, `llm/retry-started`,
  `tool/call`, `subagent/catalog`, `assistant/message`, `assistant/attempt` and `request/context`
  (`src/session-cost.js:595-630`). The harness does emit compaction as session events —
  `compaction/start`, `compaction/summary` (which carries `usage`, `model` and `shadowedTokenCount`),
  `compaction/end` and `compaction/prune` — so the data exists but never reaches the model.
- The per-Step node is the only unit the chart, top-K, the inspector and the export know. An event
  that carries money but belongs to no Step therefore has no home yet, and the "session estimate is
  the sum of its Steps" invariant (D5, D9) has no room for it either.

## Goals / Non-Goals

**Goals:**

- Make every Finding a pure function of the series and the effective thresholds, so the same log
  always yields the same verdict and detection costs no model call and no network.
- Keep thresholds and presets in one place (the Host's plugin configuration) and the client a pure
  renderer: it receives Findings and thresholds, never derives them.
- Preserve the existing invariants while adding the compaction bill: one Step counted once, the
  session estimate equal to the sum of its nodes, the wire view still carrying only a summary.
- Stay inside the chart budget already promised: brushing, zooming and panning never re-request the
  series, and recomputation stays within a frame.
- Say nothing when there is nothing to say: a floor under every Indicator and an explicit silence on
  sessions too short to have a norm.

**Non-Goals:**

- No LLM, no ML, no statistical inference beyond an order statistic baseline; no claim about real
  billing, and no automatic fixing of anything the Indicators find.
- No live tuning UI in this change: thresholds are plugin configuration, and the view only reports
  what is in force.
- No dismissal, acknowledgement or "mute this Finding" state: Findings are recomputed, not tracked.
- No new route, no second chart, no log axis (D14 stays deferred), no persistence of Findings.
- No `off` preset: the catalogue is always on and the reader tunes it through thresholds.

## Decisions

### Where detection runs

- **I1 — Detection runs on the Host, inside the series build.** The catalogue reads the same nodes
  the response carries, immediately after pricing and after subagent spawns are attached, so a
  Finding can never describe a series the reader does not have. The alternatives were detection in
  the client (rejected: thresholds are plugin configuration and would have to be mirrored, and two
  implementations of the same rule would drift) and a hybrid (rejected: it splits one verdict into
  two sources of truth). The Host already folds and prices the whole series on every request, so the
  marginal cost is bounded by the budgets in I25.
- **I2 — Findings travel in the series response, not in the projection state and not over a second
  route.** The projection stays about money and keeps the light `wire.view` of D7; the response
  gains the Findings, the effective thresholds and the active preset. This also fixes what "the list
  recomputes for the brushed range" means: the client filters what it already holds, with no request
  per brush.
- **I3 — Detection always reads the `fact` projection.** Tariff projections are a reading aid, and
  `tariff-attributable` exists precisely to compare `fact` with `offPeak`; detecting on the selected
  projection would make a Finding appear and disappear when the reader flips a switch. The metric
  selector does not reach detection either: token-based Indicators read tokens whatever the axis
  shows. The explanation states that Findings were computed on `fact`.
- **I4 — The baseline is the whole session, and brushing only filters.** Median, MAD, p95 and the
  session norm come from every Step of the session, so zooming never redefines what is normal — the
  alternative would let a Step stop being a spike exactly when the reader looks at it. A visible-range
  baseline would be a different feature and is not in this change.

### Compaction

- **I5 — The fold consumes `compaction/*`, and a compaction becomes a node with `kind`.** The node
  carries the summarizing call's usage and cost, the compaction id, the model and the shadowed token
  count, and it enters the session estimate, so the Σ invariant survives an event that belongs to no
  Step. Alternative considered: a separate turn-level line item outside the node list — rejected
  because it breaks the invariant the whole Cost view rests on.
- **I6 — Anchoring rule.** A compaction event that names a Turn places its node in that Turn, ahead
  of the Step the compaction serves. An event with `turn: null` (an idle `/compact`) belongs to the
  Turn whose accumulated context it rewrote, i.e. the previous Turn. When no Turn precedes it, the
  node stays turn-less: it is counted, exported and listed, but draws no point. The first draft of
  this design anchored such a compaction to the *next* Turn, on the grounds that the summary is paid
  for the request that follows; that was rejected because the node would then have no home until an
  event that may never arrive, while Σ must hold at every read.
- **I7 — A Compaction step is not a Step of the conversation.** It stays out of the per-Step cost
  line (that line is money per Step), it has no tool calls, no Trajectory target and no inspector
  action, it appears as its own row in top-K labelled as a compaction, and every detector ignores it
  except `post-compaction-spike`. On a time axis it sits at its own instant; on the Step-index axis
  it shares the column of the Step it serves, or of its Turn's last Step when turn-less.
- **I8 — The export gains a `compaction` record type.** Reusing `usage` with a flag was rejected:
  in that vocabulary `usage` means a usage report of a Step, and the export is read by tools that
  rely on that meaning. The record carries the compaction's usage, its three projected costs, the
  shadowed token count and its anchor, or no anchor for a turn-less compaction.

### The Finding model

- **I9 — `refs` addresses the series by position.** `{from, to, turnFrom, stepFrom, turnTo, stepTo}`
  uses node indices for the mechanics (filtering by a visible range is a comparison of indices) and
  keeps `turn`/`step` for humans and for the export. A Turn-level verdict, such as `retry-storm`
  across a Turn, is expressed as the range of that Turn's Steps instead of a new reference kind:
  fewer entities, and Turn banding already shows the reader where it starts and ends.
- **I10 — Confidence is a product of three factors; severity restates one of them.** The margin
  factor `m ∈ [0,1]` measures how far past the threshold the value sits, normalised by a
  per-Indicator reference multiple; the sample factor `s = min(1, n / 20)` grows with the number of
  Steps the verdict rests on; the completeness factor `c ∈ {0.7, 0.85, 1}` discounts a verdict whose
  inputs are partly missing. `confidence = round(100 · m · s · c)`, clamped to 0–100 and monotone in
  `m` by construction. `severity` comes from `m` alone — below 0.5 `info`, 0.5–0.85 `warn`, at or
  above 0.85 `alert` — so it is a discrete restatement of the margin rather than a second judgement.
  One Indicator caps its own grade: `tariff-attributable` never rises above `info`, because every
  session inside a peak window loses money to the clock, and an explanation of the bill must not
  wear the same grade as a leak. The UI says everywhere that confidence ranks suspicion, not a
  probability.
- **I11 — Floors and short sessions.** Every Indicator has a reporting floor on `m` (0.25 in
  `balanced`): below it no Finding, no badge, no row. Statistical Indicators (`spike`,
  `context-growth`, `cache-miss`, `verbose-output`, `tool-output-inflation`)
  report nothing on a session with fewer than eight Steps with usage, because an order statistic over
  three points is noise dressed as a verdict; rule-based Indicators (`retry-storm`,
  `post-compaction-spike`, `tariff-attributable`, `pricing-gap`, `expensive-subtree`) still fire.
- **I12 — The `balanced` table is pinned in the spec, so tests and the UI can name it.** Per
  Indicator: the threshold from the catalogue table, the reference multiple that maps the threshold
  to `m = 1` (3× for ratio thresholds, 2× for the ones that fire just past their gate), and the
  floor of 0.25. A z-score is evidence rather than a gate: with ten Steps the largest possible
  z is about three, so a z-gated `verbose-output` could never fire on the sessions it is meant for —
  its gate is a multiple of the session's own median output plus a minimum length, and the z is
  reported beside them.
  Presets are transformations of that one table rather than three tables that can disagree: `strict`
  multiplies the *gates* — the thresholds a value must clear, listed per Indicator — and the floors
  by 1.5, `loose` by 0.6, unless the configuration named that threshold — a value set by hand is used
  as written. Calibrated rates such as `minR2`, `uncachedShare` or `reference` are not
  moved, because scaling them could push them out of reach, and the `pricing-gap` floor stays put in
  every preset: a strict reader must not be left with a silent gap in the totals.
- **I13 — Configuration shape and validation.** `anomalies: { preset, thresholds: { <id>: { <field>:
  number } } }`, with the same defensive normalisation the fallback rates already get: an unknown
  Indicator id, an unknown field or a value that is not a positive finite number is dropped with one
  warning line, never an exception. Effective values travel in the payload, and the panel shows the
  preset and the thresholds read-only, so a reader can always tell which rule produced a Finding.
- **I14 — Money-based Indicators skip Unpriced Steps.** For them an unpriced Step has no signal:
  its cost is unknown, not zero, and the existing unpriced mark already says so. Token-based
  Indicators read every Step. `cache-miss` reads a run of resent context only once the session has
  shown a cache in use — a session that never cached anything has not missed anything, and a cold
  start must not be reported as a leak. `pricing-gap` is one Finding per session over the range of
  its Unpriced Steps — it exists to warn that the totals understate reality, which is a session-level
  statement, and repeating it per Step would double the unpriced mark the chart already draws. It is
  the one Indicator whose margin starts at the middle of its range: a gap is never merely noise, so
  only its share of the tokens moves it between `warn` and `alert`.
- **I15 — `expensive-subtree` is computed only from a subtree that was already read.** It appears on
  the subtree reading of the view and never on the reading that covers the session alone, because
  the header total there means one session (D25, D43, D44). Detection must not read a child session
  on its own initiative; a subtree that was never asked for simply has no such Finding, and the
  view says the subtree has not been read rather than reporting "no findings".
- **I16 — `post-compaction-spike` is one Finding over two references.** It references the Compaction
  step and the Step it made expensive, and its evidence names both figures — what the summarizing
  call cost and what the cache rebuild cost. Two separate Indicators were rejected: to the reader
  this is one story, and splitting it would double the badges on the same pair of Steps.
- **I17 — Findings are recomputed, never sticky.** Each series build detects from scratch; a Finding
  the grown series no longer supports disappears. No dismissal state exists, so there is nothing to
  persist and nothing to migrate when thresholds change.
- **I18 — Zero Findings is a normal state with its own sentence.** The list says that the visible
  range has no findings instead of rendering an empty card, and a session below the short-session
  floor says that its norm is not established yet rather than pretending to have looked.

### Presentation

- **I19 — One aggregated badge per Step.** The badge shows the glyph of that Step's top-ranked
  Finding — `severity × confidence`, the one ranking the list, the cap and the badge all use — and
  the count of the others; `info` Findings draw no badge at all and live in the list.
  When the number of badges would crowd the plot, those with the highest `severity × confidence` are
  drawn and the rest stay in the list. Badges do not replace any mark the chart already draws — spawn
  markers, unpriced Steps, clipped points and in-progress Steps keep their own marks — and activating
  a badge selects the Step exactly as activating its point does.
- **I20 — The findings list is the third card of the band under the chart.** The band already holds
  the session reading and the subtree reading at equal height (D43); the list joins them at the same
  height and scrolls inside itself, so including indicators never pushes the top-K list or the export
  controls off the page. Order is `severity × confidence`, ties broken by share of the session cost,
  then by the earlier position, then by `kind`, so the list does not shuffle between recomputations.
- **I21 — A partially visible range is still shown.** A Finding is listed when at least one Step it
  references is inside the brushed range, its badge is drawn only on visible Steps, and the row is
  marked as reaching beyond the visible range. Hiding it would conceal exactly what the reader
  zoomed in to inspect.
- **I22 — The explanation names the numbers.** The tooltip and the inspector repeat what the
  Indicator detects and which of that Step's numbers cleared which threshold, using the effective
  thresholds and the preset from the payload, and state that the confidence is a ranking aid inside
  an estimate.

### Text, configuration and cost

- **I23 — Evidence is structured on the Host; sentences are the client's.** The Host reports
  `{metric, value, threshold, baseline, sample, …}`, the client renders it from its own dictionary,
  and the export carries the structure and the numbers. A reader running the Russian UI would
  otherwise get the only English sentence in the panel; both locales already exist in the plugin.
- **I24 — Shared statistics, then memoisation.** Detection computes its order statistics once — one
  sorted copy for median and MAD, one output sample for the mean and deviance, one grouping by tool
  name — and each Indicator then walks the series for its own gate: a constant number of passes,
  independent of how many Steps there are, which is what the budget needs rather than a single fused
  loop. Results are memoised on `(seq, effective thresholds)` on the Host and the visible-range filter
  on `(from, to)` on the client, so a wheel zoom does not refilter per frame. Budgets: 50 ms for 10⁴
  Steps on the Host, 4 ms for the client filter.
- **I25 — Module layout.** The catalogue, the detectors and the threshold normalisation live in a new
  `src/indicators.js` as pure functions over the built series, so they are unit-testable without a
  Host, a session or a clock; the fold of `compaction/*` stays in `src/session-cost.js`, next to the
  node model it extends; the route wiring and the config normalisation stay in `src/index.js`, which
  already owns plugin config; the rendering stays in `client/client.js`, which D4 keeps as the only
  browser module. No new runtime dependency.
- **I26 — The spec deltas match the shape of the code.** Two capabilities: the new
  `cost-anomaly-indicators`, and three MODIFIED requirements in `session-cost-analysis` — the node
  model, the series payload and the export vocabulary. Chart-side additions (badges, the findings
  card) are additive and live in the new capability rather than rewriting the chart requirement that
  remains true.
- **I27 — Tests follow the fixture generator, not hand-written logs.** `test/fixtures/session-cost-history.generate.mjs`
  gains anomaly scenarios (a dominating Step with a known median, three identical calls, a retry
  storm, linear context growth, a compaction with a cache rebuild, unpriced Steps, a child session),
  and each Indicator gets a positive and a negative case built from them. Beyond per-Indicator cases:
  monotonicity of confidence in the margin, silence below the floor, silence on a short session,
  determinism of two identical runs, the shape and stability of the evidence, and the shapes of the
  `indicator` and `compaction` export records.
- **I28 — Staged implementation, in the order the invariants allow.** Stage 1 folds compaction and
  extends the node model (the Σ invariant is the riskiest part and the tests around it already
  exist); stage 2 adds the detector engine and the catalogue; stage 3 puts Findings, thresholds and
  the preset into the response and the config; stage 4 renders badges, the card and the explanation;
  stage 5 adds the two export record types; stage 6 completes fixtures, README and validation. Each
  stage leaves `npm test` and `npm run lint` green.
- **I29 — There is no `repeat-tool-call` Indicator.** An earlier draft had one, matching a tool name
  plus its argument preview. The preview is a *display* string — up to three lines, 200 characters,
  whitespace collapsed — and the projection keeps no other form of the arguments, so the signature
  cannot tell a repeated command from two commands that open the same way. Measured on a real
  535-call session: six Findings, and every one of them grouped calls whose full arguments all
  differed (13 distinct of 13, 15 of 15, 8 of 8, …) — all six were heredoc commands sharing a
  three-line header. Keyed on a hash of the exact arguments instead, the same session yields no
  Finding at all, which is the honest answer: iterating on failing tests is not repetition. The
  re-run signal the harness does report lives in the projection as `retries`, and `retry-storm`
  already reads it. Detecting *redundant* repetition would need the outcome of each call (success,
  failure, result identity) in the series, which it does not carry; until it does, the catalogue
  stays silent rather than guess.

## Risks / Trade-offs

- **False positives on short or unusual sessions** → the eight-Step floor, the per-Indicator margin
  floor, and the `strict` preset give three independent ways to quieten the catalogue without a code
  change; the negative fixtures of I27 pin the behaviour.
- **The thresholds are a judgement, not a measurement** → they are configuration with documented
  defaults, the effective values travel with every Finding, and the explanation names them, so a
  reader can always see which rule spoke.
- **The session estimate grows by the compaction bill** → this is the point of I5, but it changes a
  number readers may have memorised. Mitigation: the Compaction step is visible as its own row and
  its own export record, so the difference is attributable rather than mysterious.
- **Two capabilities change at once, and the node model is shared** → the client and the Host must
  ship together (the proposal marks it BREAKING); the projection state is derived from the log, so
  there is no stored data to migrate.
- **Badges can crowd a chart that already carries four kinds of marks** → one badge per Step, no
  badge for `info`, and a priority cap by `severity × confidence`; the list remains the complete
  record.
- **Findings can flicker while a session is live** → accepted and documented: a Finding vanishes when
  the recomputed series no longer supports it. Recompute happens only when the series is rebuilt, so
  the flicker is tied to new usage rather than to rendering.
- **Detection on `fact` while the reader looks at another projection** → the explanation states the
  projection detection used, and `tariff-attributable` is the one Indicator that reads another
  projection, by definition.
- **The catalogue may be too large to land usefully in one change** → the staging of I28 lands the
  model first and the last stage is pure polish; if the catalogue has to shrink, `expensive-subtree`
  (I15) is the one entry that depends on data the session tab does not hold, and it can be dropped
  without touching the rest.

## Open Questions

- The exact reference multiples that map each threshold to `m = 1` (I10, I12) are a calibration
  detail: the defaults in the spec table are the starting point, and the monotonicity and floor tests
  do not depend on their precise values. Tightening them later is a default change, not a shape
  change.
