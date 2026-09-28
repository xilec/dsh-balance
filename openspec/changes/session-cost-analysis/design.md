# Design

## Context

See `proposal.md` for motivation and `specs/session-cost-analysis/spec.md` for the required
behaviour. This section records only what shapes the approach.

- `src/session-cost.js` already folds the harness event stream into a per-session estimate: the
  last usage report of a `(turn, step)` replaces the earlier one, `llm/retry-started` closes the
  slot and subtracts the evicted attempt, and the result is published through the
  `sessionProjections` service as `dshBalanceCost`. What it does not keep is per-Step history:
  the state is a running total plus a `last` slot.
- The client-visible `wire.view` of that projection is an object validated with Zod and
  republished to the client on every projection change. Anything large put there is
  re-validated and re-sent on every usage event.
- `client/client.js` is the single browser module: a `window.__ModuleLoader__.load` registration
  with no bundler, no transpiler and no `require.async` chunks. Plain functions are exported
  through `exports.__internals` for `node:test`; pixels are verified by hand in the shell.
- The shell ships no charting library, so a plot means canvas by hand.
- Balance samples (`src/history.js`, `$DSH_HOME/dsh-balance/samples.ndjson`) are the only
  account-wide truth; they are unrelated to any single session and are sparsely sampled.
- The host half reads other services through `ctx.get(...)`
  (`src/index.js:428` reads `sessions` and `sessionProjections` snapshots) and registers HTTP
  routes with `webServer.register`; the client writes settings only through
  `POST /dsh-balance/settings`, whose accepted keys are the `MUTABLE_SETTINGS` table in
  `src/index.js:80`.
- `CONTEXT.md` fixes the vocabulary this design uses: **Spend**, **Session cost estimate**,
  **Tariff rule**, **Tariff projection** (`fact`/`offPeak`/`peak`), **Session projection**,
  **Step**, **Turn**, **Unpriced model**, **Cost view**.

## Goals / Non-Goals

**Goals:**

- One fold owns the per-Step series; every surface (chip, panel card, Cost view, export) reads
  from that same fold, so two surfaces can never disagree.
- The heavy data travels through a Host route, not through the per-event wire view.
- The client renders and never re-derives the Tariff rule.
- The whole feature ships without a build step, a new runtime dependency, or any change to the
  existing plugin's outward settings contract other than additional accepted keys.

**Non-Goals:**

- Replacing Trajectory (timings, event ledger, record inspector) or the account ledger.
- Per-tool cost attribution inside a Step — the provider reports usage per assistant message,
  so a Step is the finest granularity that exists.
- Attributing balance deltas to a session or a Step.
- Log-scale Y in this change (deferred, see Decisions D14).
- An LLM-driven export path; the export is a browser download (D11).
- Backfilling the existing surfaces (balance panel, composer readout) into specs; a later
  change does that (D24).

## Decisions

Decisions D1–D39 are the accepted record of the design session; each is stated with its
rationale. Alternatives that were considered and rejected are named.

### Scope and process

- **D1 — One change, five stages.** `session-cost-analysis` is a single OpenSpec change holding
  all five stages in `tasks.md`; implementation runs in waves (stage 1 → acceptance → 2 …) and
  the change is archived after the fifth stage is accepted. Alternative: one change per stage —
  rejected, because the stages share one data model and one route contract, and five changes
  would multiply the spec deltas without adding information.
- **D24 — Only the new capability's delta.** The change adds a delta for the new
  `session-cost-analysis` capability only. Existing surfaces (balance panel, composer readout,
  peak chip) are backfilled into specs by a separate later change; restating their behaviour
  here would freeze unrelated code.
- **D37 — One branch, one PR, commits per stage.** Work happens on `feat/session-cost-view`;
  each stage is a commit; the PR and the merge (merge commit) happen once, when the feature is
  confirmed; archive follows the fifth stage's acceptance.
- **D38 — Stage 1 is the smallest useful slice.** The Cost view with the full-series chart,
  tooltip and inspector; `fact` projection only; cost metric only. Top-K, brush, subagents,
  export and the log scale are explicitly out of the first wave. Acceptance for stage 1: the
  composer chip and the Cost view show the same session total.

### Data ownership

- **D2 — The Host owns the per-Step series.** The Host emits the finished step cost under the
  three Tariff projections and the client only draws. This consciously departs from two
  statements in issue #1 — "never store the computed cost" and "fold runs client-side over the
  loaded window (no host state growth)". Reasons: the fold already exists on the Host and
  mirrors the harness's own `tokenUsage` semantics (last report wins, retries evict), a second
  client-side fold would have to reproduce rate-schedule and holiday logic the client cannot
  see, and one fold is what makes the chip and the view agree (D9). The issue's concern behind
  "never store the computed cost" — a stale, rule-dependence-laden number that makes tariff
  projections impossible — is answered by D8 instead: the state keeps raw buckets and rules
  only travel with the response.
- **D8 — The projection state keeps raw material.** The state stores buckets, event time, model
  and the retry-eviction flag per usage report; the step cost under each projection is computed
  when the summary or the series is built, from the live Tariff rule snapshot. Alternative:
  store three costs per step — rejected, because a later rule or fallback-rate change would then
  require rewriting history (D36) and the three projections could drift. The running aggregates
  the wire view needs (bucket totals, the `fact` cost, per-model totals, the Unpriced models)
  are maintained by the same fold, so a usage event produces the next client view in O(1);
  building the whole series per event would make a 10⁴-Step session quadratic. The series route
  prices its nodes from the series itself, so the two paths share one rule snapshot and one set
  of raw buckets.
- **D9 — `dshBalanceCost` becomes derived from the series** (Σ of step costs) so the chip, the
  panel card and the Cost view cannot diverge. Alternative: keep the running total and add the
  series beside it — rejected, exactly because the two can drift.
- **D10 — A chart point is a `(turn, step)` node** holding its usage reports (model, time,
  buckets, evicted-by-retry). The node cost is the sum of its surviving reports. Alternative: a
  point per usage report — rejected, because a Step that is retried would appear as several
  points at nearly the same instant and the "finest granularity the provider reports usage for"
  is the Step. Verified against the harness's own `tokenUsage` unit
  (`dsh-token-meter/lib/index.js:415-438`): a restated usage report for the same `(turn, step)`
  replaces the earlier one, and only `llm/retry-started` closes that replacement slot. The
  plugin mirrors that replacement rule, so a node holds one surviving report plus the reports a
  retry evicted. Usage is read from `assistant/message` (its `usage`, or the last `usage` chunk
  of its stream) and `assistant/attempt` (the last `usage` chunk); the removed branch for
  `assistant/chunk` was not an event type in this harness version.
- **D28a — The retry rule deliberately deviates from `tokenUsage`.** The harness's own unit
  *adds* a retried attempt to its total (the failed attempt was billed), while this plugin drops
  the evicted attempt — which is what the existing `dshBalanceCost` does today and what D28
  fixes. The evicted report is still kept in the node for the tooltip's retry count and for the
  export, so nothing becomes invisible; only the money metric follows the session estimate the
  chip already shows.
- **D5 — Count each Step once.** The session estimate is the sum of the same Step nodes;
  rounding happens only when a number is presented (the `round6` boundary), so Σ parts equals the
  whole before rounding. The chip's aggregates and a Step's per-bucket rows are sums of the very
  same six-decimal terms (`pricedReport`), so the chip, the series total and the table rows agree
  to the last printed digit; the residual is binary floating point (`~1e-16`), not a rounding of
  a rounding.
- **D6 — `Unpriced` Steps are excluded from money, included in tokens.** A Step whose model has
  no rate adds nothing to a money metric - never a silent zero - but its tokens count in every
  token metric, and the mark is explicit in the chart, the tooltip and top-K.

### Transport

- **D7 — The series lives in projection state and travels over a Host route, not in `wire.view`.**
  `wire.view` is re-validated with Zod and republished on every projection change, so an array of
  steps there would be O(n²) work and traffic over a session. The wire view carries the summary
  plus `seq`; the series is served by a route registered like `/dsh-balance`.
- **D12 — Live update through `seq`.** When the summary's `seq` increases, the client re-requests
  the series tail and extends the chart. A full reload happens only on an explicit action or a
  range change.
- **D26 — One session per route, children on a separate route.** The main series route answers for
  exactly one session - the one it was asked about - and never enumerates others. Subagent
  sessions are served by a separate route that walks `subagentCatalog`. Alternative: accept any
  `sessionId` on the main route — rejected: it turns a view into a session-reading surface.
- **D22 — The route ships the rule material.** Rates with their effective dates, the absolute
  peak intervals covering the series, the holidays, the rule source and verification date and
  the currency all travel with the series. The client derives no peak, holiday or rate decision
  of its own, which is also what keeps the client free of the Tariff rule (as the existing peak
  chip already does with `peak.schedule`).
- **D30 — First request returns the whole series.** One call, no incremental loading button;
  `Load full history` survives only as the explicit action for a subagent subtree.
- **D13 — `loadOlder()` is called only on demand.** The chart needs the projection's step data,
  not the conversation; older conversation events are loaded only when a point is clicked (for
  the inspector's prompt preview or for the Trajectory jump). This is a deliberate deviation from
  the issue's suggestion to page history in through the slot, and it is what keeps the first
  render instant.
- **D32 — No automatic prompt loading.** The inspector shows the prompt preview the projection
  already has; otherwise it says "events not loaded" and offers an explicit `Load older` action.

### Rendering

- **D15 — Canvas by hand plus a DOM overlay.** The plot (step line, markers, stems) is drawn on a
  canvas; axes, peak bands, turn separators, the tooltip and the brush handles are DOM. No
  charting library ships with the shell, and adding one would mean a bundler or a new runtime
  dependency, both excluded by `openspec/config.yaml`.
- **D4 — One client file.** `client/client.js` stays the only browser module; pure functions
  (scales, decimation, clipping, series folding for the export, formatting) are exported through
  the existing `exports.__internals` so `node:test` can exercise them without a DOM. Bundling
  (tsdown) and `require.async` chunks were rejected: they add a build step to a repository that
  currently has none.
- **D16 — Clipping with an explicit escape hatch.** The Y scale clips at `p95 × 10` of the visible
  range, clipped points get a visible marker, and a control removes the clipping. Alternative:
  always scale to the maximum — rejected, one outlier would flatten the whole session.
- **D14 — Log scale deferred.** Y is linear in this change. The spec states the linear axis as
  required behaviour; a log toggle returns after the first wave (see Open Questions).
- **D19 — The tab is `conversation.view` at `order: 20` with the label `Cost`.** Directly after
  Trajectory (`order: 10`), per-session, mounted lazily on selection, and shown regardless of the
  Coding Tools setting.
- **D21 — X marks the Step start.** A point is drawn at `t_start`; the `t_start..t_end` interval
  belongs in the tooltip and the inspector. Switching the X axis to the Step index numbers points
  by `(turn, step)`.

### Reading the chart

- **D17 — Top-K follows the metric, but always shows cost.** Rows are ranked by the selected
  metric (so the driver of a peak is visible) while the cost stays in every row; a ranking by
  tokens never hides money. The Turn mode also bands the chart: each Turn owns the span up to
  where the next one starts, alternating shades keep the boundary readable, and the Step named
  in a Turn row is the one that drove the Turn's rank.
- **D40 — The selected Step is remembered across views, not across reloads.** The conversation
  mounts only the selected view, so a jump to Trajectory unmounts the Cost view; the Step the
  jump came from is remembered as `(turn, step)` (never as an index, which a new window would
  move) and is marked again on return, while brush and zoom stay transient (D34).
- **D18 — An in-progress Step is drawn immediately.** A Step whose usage has arrived but whose
  turn has not ended appears as a semi-transparent "in progress" mark and counts in top-K and in
  the totals, so a running session is never blank.
- **D33 — Three explicit empty states.** No Steps with usage yet; tokens present but no rates;
  the history read failed (with a retry action). Each is a distinct message rather than an empty
  plot.
- **D20 — The node carries what a reader needs.** `turn`, `step`, `t_start`, `t_end`, the buckets
  per model, the retry count, the calls (`name`, `callId`, a preview of up to three lines and at
  most 200 characters, with escaped newlines decoded) and the flags (`interrupted`, `unpriced`, `unknownModel`). Full argument text appears
  only in the export's `full` level. The route also prices the buckets separately
  (`costByBucket`), so the inspector can show where a Step's money went as a table without the
  client touching the Tariff rule; the per-bucket figures add up to the Step's cost.
- **D27 — The calibration line is conditional and honest.** It appears only when the session's
  interval holds at least two balance samples, and it is labelled as account-wide and including
  other activity; with fewer samples no line is offered, because a single sample cannot express a
  delta.
- **D28 — Retries are visible but not billed.** An attempt evicted by a retry does not enter the
  cost (matching the current `dshBalanceCost` semantics) but stays in the state: the tooltip
  reports the retry count and the export emits a `retry` record with the evicted buckets.

### Unpriced models and rates

- **D35 — Fallback rates are per model.** The reader enters cache miss (input), cache hit (cache
  read) and output rates per 1M tokens, as peak rates with the off-peak rate at half of them;
  `cacheWrite` is billed as `cacheMiss`. Entry happens through the existing settings surface plus
  a control offered in the unpriced state. Alternative: one global fallback set (the current
  `fallbackPrices`) — rejected, because models differ by an order of magnitude and one set would
  make the estimate misleading.
- **D36 — Entering a rate reprices the whole history.** Because the state keeps raw buckets (D8),
  a new rate recomputes every affected Step, the session estimate and the chip; the UI warns that
  the history is being recomputed so a moving number is expected, not a bug. The state carries the
  rule its running aggregates were priced with (a `ruleKey` of the currency, the holidays, the
  global fallback and the per-model rates): when the live rule stops matching, the aggregates are
  rebuilt from the stored reports before they are read or advanced, so the chip catches up on the
  next read without waiting for an event, and no `stateVersion` bump is needed for a rate change.
- **D34 — View choices are global, through the existing settings route.** Metric, X axis, Tariff
  projection and top-K mode persist via `POST /dsh-balance/settings` and come back on the read
  route as `prefs`; brush and zoom are transient and are not stored. They live in their own
  `UI_SETTINGS` map beside `MUTABLE_SETTINGS`, because they are browser choices with no runtime
  counterpart: the route stores and echoes them and never applies them to the Host config.

### Subagents and export

- **D25 — Children never enter the session total.** "The whole session" means that session; the
  subtree is a separate row/overlay, so a session's headline number stays comparable over time.
- **D23 — Export defaults to the current session plus markers.** By default the export covers the
  current session and records `subagent_spawn`/`subagent_settle` markers; folding children into
  the stream is an explicit checkbox with progress, because it reads other sessions.
- **D11 — The export is a browser download, and nothing else.** Nothing is written to the
  workspace or `$DSH_HOME`; putting the file where it is needed is the user's job. The
  LLM-consumption path is a separate preset that gets tools, not a side effect of a plugin.
  Established while designing: a model cannot read other sessions with stock tools (session logs
  are `session.vN.jsonl.zstd`, `read`/`grep` see a binary, no `dsh-tool-*` reads sessions,
  `dsh-session-reference` requires the user to mention the session, `/export` is a human
  command), which is exactly why "expand subtree" must read foreign sessions on the Host.
- **D29 — Export file name.**
  `dsh-balance-<session id first 8 chars>-<yyyymmdd-hhmm>.cost-history.ndjson`.
- **D31 — Two detail levels.** `costs` (default): no message or tool text. `full`: message, tool
  and thinking text, each text field truncated at 2000 characters and flagged `truncated: true`;
  `thinking` exists only at this level. The UI warns before downloading `full`.

### Verification

- **D39 — What is tested where.** Unit tests cover the fold (buckets, retries, unpriced, the Σ
  invariant), the scales (decimation, clipping), the route (page bounds and "own session only")
  and a golden NDJSON export; pixels are checked by hand in the running shell and the check is
  recorded in `tasks.md`. This matches the repository's existing split: `npm test` plus manual
  shell verification.

### Platform surfaces

Verified against the live Host/Client API catalog of dsh 0.1.7-rc.2 (Host `Service` provider,
Client `Slots` provider) and the shipped bundles while writing this design:

- The view registers through `ctx.slots.inject('conversation.view', ...)` with
  `{ name: 'conversation.view', id, order: 20, locale, label: () => t('view.cost'),
  inject: (sessionId) => ({ ... }) }` — the same shape Trajectory uses with `order: 10`
  (`dsh-client-ui-trajectory/lib/client.js:8736`), and the same registration mechanism as the
  existing `conversation.composer.dock` entry in `client/client.js`. The live slot catalog adds
  only `id` (required), `order` and `label` to that registration.
- A view component receives the shell's standard props (`t`, `sessionId`, `useSession`,
  `useProjection`, `useConversation`, `renderSlot`, … — the slot's `standardProps` list) plus the
  owner props the conversation shell passes at the render call — `inspectCall`, `viewRequest`,
  `openView`, `completeViewRequest`
  (`ConvViewOwnerProps`, `dsh-client-ui-conversation/lib/client.js:16338`) — plus whatever the
  registration's `inject` returns.
- `inspectCall(callId)` activates the one view definition that declares `toolCallFocus`
  (`dsh-client-ui-trajectory/lib/client.js:1636`); with no such target it does nothing, which is
  exactly the "no focus target" case the inspector states for an assistant-only Step.
- `loadOlder` is not handed to a view automatically: Trajectory builds its own loader in
  `inject` on top of the session binding
  (`ctx.sessions.binding(sessionId).session.loadOlder()`, same file). The Cost view does the
  same, and only on demand (D13, D32).
- The projection unit contract is
  `{ key, stateVersion, stateSchema, init(header, inheritedEventCount), apply(state, event),
  wire: { viewSchema, view(state) } }` (`sessionProjections.register`). `apply` runs for every
  committed event of the session (eager drive), the next client view is computed when the state
  reference changes, and the change feed is notified only when that raw view changes by
  `Object.is` — the mechanism D7/D12 rely on.
- The Host can read the same state outside the client view through
  `sessionProjections.stateOf(session, key)` and `sessionProjections.snapshot(session, keys)`
  (schema-validated values plus `asOfSeq`); the series route uses the projection service and
  `ctx.get('sessions').get(sessionId)` exactly where `src/index.js:428` does today.
- A `stateVersion` bump is safe by contract: a persisted checkpoint row is usable only while its
  `ver` matches the live unit's `stateVersion`, and a mismatched or absent row pulls
  `restoreFloor` to `0`, so the unit refolds the full session log. Moving the unit to version 2
  therefore rebuilds the new per-Step state from the log with no migration code and no loss.
- Child sessions are reachable on the Host without touching their logs by hand:
  `subagents.listChildren(parentSessionId)` and `subagents.listDescendants(rootSessionId)` give
  the tree, and `sessionQuery.observeSession(sessionId)` / `readSession(sessionId)` /
  `listEvents(sessionId)` give a child's events for replay through the same fold. The main route
  uses none of them (D26); the child route uses all three.
- The event vocabulary the fold consumes is the session log's own
  (`SessionEventMap`): `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`,
  `assistant/message` (with `usage`, `interrupted`), `assistant/attempt`, `tool/call`
  (`callId`, `name`, `arguments`), `tool/result`, `request/header`, `request/context` — which is
  what the node fields of D20 need, and what the export's event vocabulary is derived from.
- The series route is a `GET` route registered with `webServer.register` next to the existing
  `/dsh-balance` route, parsing its own query string and answering with JSON; the child route is
  a second, separate registration.
- The append-only per-Step series in projection state uses `@deepseek-ai/dsh-chunked-list`, the
  same package the harness's `subagentCatalog` projection uses for its child list, so appending a
  Step is not a whole-state copy.

## Risks / Trade-offs

- **Projection state growth** (every Step of every session kept in memory) → the series is an
  append-only chunked list, the wire view stays small, and the state is dropped with the session;
  the per-node record is a few hundred bytes.
- **`stateVersion` bump and old state** → the unit moves to version 2 when the series appears.
  The projection contract makes this self-healing: a checkpoint row whose `ver` does not match
  the live `stateVersion` is discarded and the unit refolds the whole session log, so an
  already-open session gets its series rebuilt from its events rather than from a migration.
  The cost of the refold is one pass over the session log, paid once per session per version
  change.
- **Canvas cost on a 10⁴-Step series** → decimation by pixel column (min/max) bounds the number
  of drawn marks, and the overlay is kept to a handful of DOM nodes.
- **The single client file keeps growing** (roughly 1.2k lines today) → pure logic is factored
  into small functions covered by `node:test`, the file keeps its region markers, and both `knip`
  and `jscpd` (1% threshold) stay in the loop after every stage.
- **Reading foreign sessions is a privacy-relevant capability** → it is confined to the subtree
  route, only runs on an explicit action, and is never reachable from the main route.
- **Retroactive repricing makes numbers move** → the entry point warns before recomputing (D36),
  and the projection state keeps raw buckets, so the recomputation is exact rather than
  approximate.
- **The chart can lie by scale** → clipping is always marked and removable (D16), the `fact`
  figure stays in the header under any projection (spec: Tariff projections and metric selector),
  and the calibration line is labelled account-wide (D27).
- **Two routes can drift from one fold** → both are built from the same series and the same
  `seq`; the main route is the only one the chart's totals use.

## Migration Plan

Stages are additive and land in order on one branch; each stage keeps `npm test` and
`npm run lint` green and is verified by hand in the shell before the next one starts.

1. Stage 1 (series fold, wire summary with `seq`, series route, Cost view with chart, tooltip,
   inspector, `fact`/cost) — `dshBalanceCost` switches to the series-derived total here.
2. Stage 2 (projections `offPeak`/`peak`, metric selector, X axis, rule material in the route,
   unpriced fallback rates and their settings keys).
3. Stage 3 (top-K, brush/zoom, Trajectory jump).
4. Stage 4 (subagent markers, subtree route, calibration line).
5. Stage 5 (NDJSON export, detail levels).

Rollback: every stage is a commit, so a bad stage is reverted on the branch before the PR. After
the merge, the projection state version is the only durable artefact; it is owned by the harness
projection cache, and a version mismatch makes the unit refold from the session log rather than
serve a stale row. The settings file gains keys that older builds simply ignore.

## Open Questions

Deferrable, and none of them changes the specs, the approach or the task breakdown:

1. The exact log-scale parameters (which base, what minimum) when the deferred log toggle returns
   (D14).
2. Whether the calibration overlay is on by default or behind a toggle once the line exists.
3. The Trajectory view highlights the row it was asked to focus only when the focused call is
   among the records it has built: it looks the id up in its flattened turns, and a collapsed Turn
   or a record outside the loaded history window makes that lookup miss, in which case the request
   is dropped silently and nothing is highlighted (the plugin can only pass a `callId` — see D15's
   note on what a view definition offers). Highlighting a Step there rather than a call needs a
   change in that view, not in this plugin.
