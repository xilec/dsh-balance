# Spec Delta

## Purpose

Gives a per-session **Cost view** that shows where a session's estimated cost comes from:
a per-Step cost series priced under three Tariff projections, top-K Steps and Turns, subagent
markers, and a linear history export for deeper analysis.

## ADDED Requirements

### Requirement: Cost view tab

The plugin SHALL register a per-session Cost view in the `conversation.view` slot with the
label `Cost` and a position immediately after Trajectory. The view MUST be mounted lazily on
selection and MUST be available whether or not Coding Tools are enabled. The view SHALL name
the session it belongs to on a line above the chart, in full and selectable as a whole, with a
one-click copy action, because the id is the handle the reader passes on. The two readings under the chart — the session's own
list and the subtree — SHALL be cards of equal height in one bounded band, while the chart keeps
the width it is given.

#### Scenario: The tab appears for an open session

- **WHEN** a session is open in the shell
- **THEN** a `Cost` entry is offered next to `Trajectory`, and selecting it shows the Cost view

#### Scenario: The open session is named

- **WHEN** the Cost view is mounted for a session
- **THEN** the session id is shown in full above the chart with a copy action, the two readings
  below it are cards of the same height in one bounded band, and the chart itself is not narrowed
  by that band

#### Scenario: No work before selection

- **WHEN** the session is open but the `Cost` entry has never been selected
- **THEN** no cost series is plotted and no series request is made

#### Scenario: Coding Tools disabled

- **WHEN** the profile has Coding Tools disabled
- **THEN** the `Cost` entry is still offered and the view still renders

### Requirement: Per-Step cost series in the session projection

The Host SHALL retain, inside the session projection state, one point per `(Turn, Step)` node
holding every usage report of that node (model, event time, token buckets, and whether a retry
evicted it), the tool calls of the node, and the node flags. A node's cost MUST be the sum of
its surviving usage reports, and the session **Session cost estimate** MUST be the sum of the
same nodes so that a Step is counted exactly once. Cost MUST be computed when the summary or
the series is built, from the Tariff rule snapshot, and rounding MUST happen only when the
value is presented.

#### Scenario: A restated usage report

- **WHEN** a second usage report arrives for the same `(Turn, Step)` node without an
  intervening retry
- **THEN** it replaces the node's earlier report, and the node cost counts the newer report
  only, each priced at its own event time

#### Scenario: A retried attempt

- **WHEN** a usage report for a `(Turn, Step)` node is followed by a retry of the same node
  and then by a new usage report
- **THEN** the evicted report no longer contributes to the node cost, and it is still
  retrievable as a retry for display and export

#### Scenario: The sum invariant holds

- **WHEN** any sequence of usage, retry and model-switch events is folded
- **THEN** the session cost equals the exact sum of the node costs and no rounding error is
  introduced between the parts and the whole

#### Scenario: Unpriced model inside a node

- **WHEN** a node's model has no rate in the Tariff rule
- **THEN** the node is flagged `unpriced`, its tokens are still counted in token metrics, and
  its cost is never silently counted as zero

### Requirement: Session total derived from the series

The `dshBalanceCost` session projection SHALL expose the total derived from the same per-Step
series, so that the composer readout, the panel card and the Cost view report the same figure.

#### Scenario: Chip and view agree

- **WHEN** any usage event changes the session's estimated cost
- **THEN** the composer readout and the Cost view show the same total for the same session

### Requirement: Lightweight wire view

The client-visible part of the session projection SHALL carry only a summary — the total, the
currency, the per-model totals, the token totals, the Unpriced models, the Step count and a
monotonically increasing `seq` — and MUST NOT carry the per-Step series.

#### Scenario: Usage event updates the summary

- **WHEN** a usage event is folded into the projection
- **THEN** the published summary changes and `seq` increases, without any array of steps being
  sent to the client

### Requirement: Series route for one session

The Host SHALL serve the per-Step series over an HTTP route registered like the existing
`/dsh-balance` routes. A request SHALL be answered for exactly one session — the session named
by the request — and the route MUST NOT enumerate or read any other session.

#### Scenario: Full series in one request

- **WHEN** the Cost view requests the series for the open session
- **THEN** it receives the session's whole series in one response, with no paging or
  incremental loading button

#### Scenario: Foreign sessions are not reachable

- **WHEN** a request names a session that is not the session it was made for, or names no
  session at all
- **THEN** the route answers with an explicit error or an empty series and reads no session
  other than the requested one

#### Scenario: Live tail

- **WHEN** the summary's `seq` changes while the view is open
- **THEN** the client re-requests the series and extends the chart without a full page reload

### Requirement: Series and Tariff rule payload

The series response SHALL be self-describing: each node carries `turn`, `step`, start and end
time, the token buckets split per model, the retry count, its tool calls (name, call id, and an
argument preview of up to three lines and at most 200 characters, with escaped
newlines decoded), its subagent spawns (child id, mode, label and creation time — the parent's
own catalog facts, which is what the markers are drawn from) and its flags; the response also
carries the rates with their effective dates, the absolute peak intervals covering the series,
the holidays, the Tariff rule source and verification date, the currency, the account-wide
calibration of the session's interval when the samples can express one, and the `seq` the series
was built from.

#### Scenario: The client needs no tariff logic

- **WHEN** the client renders phases, peak bands or projections
- **THEN** every value it uses comes from the response, and the client derives no peak,
  holiday or rate decision of its own

#### Scenario: Absolute intervals cover the series

- **WHEN** a session spans several days, weekends or holidays
- **THEN** the response contains the absolute peak intervals for the whole series range, so the
  chart can band them without recomputing the rule

### Requirement: Per-Step chart

The view SHALL draw a per-Step chart as a step line with point markers and stems on a canvas,
with axes, bands and handles in a DOM overlay. The X axis SHALL default to time and SHALL be
switchable to the Step index, numbering points by `(Turn, Step)`. The Y axis SHALL be linear.
The chart SHALL band peak and off-peak windows from the response, separate Turns, and decimate
points per pixel column by minimum and maximum so a history of 10⁴ Steps stays interactive.
When an outlier would flatten the rest of the visible range, the chart SHALL apply a clipping
threshold of `p95 × 10` over the visible range, mark the clipped points explicitly, and offer
an action that removes the clipping.

#### Scenario: Many steps

- **WHEN** the series holds 10⁴ points at the current width
- **THEN** the chart draws at most a bounded number of marks per pixel column and stays
  interactive

#### Scenario: Outlier clipped

- **WHEN** one Step exceeds `p95 × 10` of the visible range
- **THEN** the chart scales to the rest of the range, marks the outlier as clipped, and a
  control removes the clipping

#### Scenario: Step index axis

- **WHEN** the reader switches the X axis to the Step index
- **THEN** points are spaced by index and labelled by `(Turn, Step)`

### Requirement: Tariff projections and metric selector

The view SHALL price the same tokens under three Tariff projections — `fact` (rates at each
event's instant, the default), `offPeak` (every token at the off-peak rate) and `peak` (every
token at the peak rate) — and SHALL expose a metric selector with cost (default), output
tokens, cache read, cache write and total tokens. Changing the projection MUST change the
chart, top-K and the totals together, while a `fact` figure MUST stay visible so the
projection never hides the actual estimate.

#### Scenario: Switching the projection

- **WHEN** the reader switches from `fact` to `offPeak`
- **THEN** the chart, top-K and the totals are recomputed under the off-peak rate and the
  `fact` total remains visible

#### Scenario: Metric is not money

- **WHEN** the reader selects output tokens as the metric
- **THEN** the chart plots output tokens per Step while every row and total still shows its
  cost

### Requirement: Tooltip and inspector

Hovering a point SHALL show a tooltip with Turn and Step, the time and the tariff phase, the
model, the token buckets, the Step cost and the Step's share of the session. Clicking a point
SHALL open an inspector with the prompt preview, the tool list, the model, the tokens, the
cost and, for a Step that holds tool calls, an action that shows that call in Trajectory. For
a Step with no tool call the inspector MUST state that there is no focus target instead of
offering the action. When the conversation events for the preview are not loaded, the
inspector SHALL say so and offer an explicit action that loads older events; it MUST NOT load
them automatically.

#### Scenario: Tool-call Step

- **WHEN** the reader clicks a Step that holds a tool call and chooses the Trajectory action
- **THEN** the Trajectory view opens focused on that call

#### Scenario: Assistant-only Step

- **WHEN** the reader clicks a Step that holds no tool call
- **THEN** the inspector states that there is no focus target and offers no Trajectory action

#### Scenario: Prompt preview not loaded

- **WHEN** the inspector has no prompt text for the Step
- **THEN** it shows a placeholder and offers an explicit action to load older events

### Requirement: Top-K Steps and Turns

Below the chart the view SHALL list the top ten Steps or the top ten Turns (switchable) of the
visible range, ranked by the selected metric. Every row MUST identify itself: Turn and Step,
time and phase, model, the tool name with a short argument preview when the Step holds calls,
the bucket breakdown, the cost and the share of the session. Selecting a row SHALL select the
corresponding point, and the selected Step SHALL stay selected while the reader visits another
view. When the list is grouped by Turns, the chart SHALL band each Turn so the span of a Turn
and the boundary between two of them are visible on the plot itself.

#### Scenario: Ranking follows the metric

- **WHEN** the reader switches the metric from cost to cache read
- **THEN** the rows are re-ranked by cache read while each row still shows its cost

#### Scenario: Selecting a row

- **WHEN** the reader selects a top-K row
- **THEN** the corresponding point on the chart is selected and its inspector is available

#### Scenario: Turns are banded on the chart

- **WHEN** the reader groups the top list by Turns
- **THEN** each Turn covers its own band on the chart, labelled with the Turn and alternating
  with its neighbour, so the reader can see where a Turn starts and ends

#### Scenario: The selected Step survives a trip to Trajectory

- **WHEN** the reader follows the Trajectory action of a Step and then returns to the Cost view
- **THEN** that Step is still the selected one, with its point, its row and its inspector shown
  again, while a new window and a reload start with nothing selected

### Requirement: Visible-range interaction

The view SHALL support wheel zoom, right-drag pan and brushing an interval. Top-K and the
totals MUST be recomputed for the visible range. Brush and zoom MUST NOT be persisted.

#### Scenario: Brushing an interval

- **WHEN** the reader brushes an interval of the chart
- **THEN** top-K and the totals describe only that interval

#### Scenario: Reopening the view

- **WHEN** the reader reopens the Cost view after a reload
- **THEN** the chart shows the full range again, with metric, axis, projection and top-K mode
  restored from the saved settings

### Requirement: Unpriced models and fallback rates

A Step whose model has no rate in the Tariff rule MUST be shown explicitly — in the tooltip,
in top-K and as a visible mark on the chart — MUST be excluded from money metrics and MUST be
fully counted in token metrics. The reader SHALL be able to enter fallback rates per model
(cache miss / input, cache hit / cache read, output, per 1M tokens, as peak rates with the
off-peak rate at half of them, cache write counted as cache miss) through the existing
settings surface and through a control offered in the unpriced state. Entering a rate SHALL
reprice the whole history, including the session estimate and the composer readout, after a
warning that the history is being recomputed.

#### Scenario: Unpriced step

- **WHEN** a Step's model has no rate
- **THEN** the Step is marked as unpriced, its tokens appear in token metrics, and it adds
  nothing to a money total

#### Scenario: Entering a fallback rate

- **WHEN** the reader supplies a rate for an unpriced model and confirms the recomputation
- **THEN** all Steps of that model are repriced, the session total and the chip change, and the
  unpriced mark disappears

### Requirement: Retries and in-progress steps

An attempt evicted by a retry MUST NOT contribute to any cost total, but it MUST be reported:
the tooltip shows the retry count and the export carries the evicted attempt with its buckets.
A Step whose usage has already arrived but whose turn has not ended MUST be drawn immediately
as an in-progress mark and MUST be included in top-K and in the totals.

#### Scenario: Retry is visible but not billed

- **WHEN** a Step was retried
- **THEN** its cost counts the surviving attempt only, and the tooltip reports the retries

#### Scenario: In-progress step

- **WHEN** usage for a Step has been reported while the Step is still running
- **THEN** the point appears immediately as an in-progress mark and its cost is part of the
  totals

### Requirement: Calibration line

When the session's interval contains at least two account balance samples, the view SHALL offer
a calibration line for that interval, labelled as account-wide and including other activity.
With fewer than two samples no such line is shown.

#### Scenario: Enough samples

- **WHEN** the session interval contains two or more balance samples
- **THEN** the view can show the account-wide spend of that interval next to the session cost
  estimate, labelled as account-wide

#### Scenario: Too few samples

- **WHEN** the session interval contains fewer than two balance samples
- **THEN** no calibration line is offered

### Requirement: Subagent sessions

The view SHALL mark subagent spawns on the Step that spawned them, using the subagent catalog
for the child's id, label and mode and the child's own session cost estimate for its total. The
cost of a subagent session MUST NOT be folded into the session total of the parent, which
covers that session only. Expanding the subtree SHALL be an explicit action with progress that
reads the child sessions through a separate route walking the subagent catalog; the main series
route MUST NOT serve any child session. Per-child lines and the subtree cost attributed to the
spawning Step SHALL be shown only after that action: the first ask reads the direct children,
and the explicit "load full history" action — which exists for the subtree only — extends the
read to every session below the session. Reading the subtree SHALL be a tab of the view beside
the session's own reading, so including or excluding subagents is a tab switch and never a
change to what the header total means; the selection of the session's own tab SHALL be a saved
view choice. Each child line SHALL offer a one-click jump into that child session's own Cost
view, so following the money does not require retyping an id. The jump SHALL open the session
through the shell and SHALL ask for the Cost tab both as that session's stored view preference
and on the live conversation binding, because a session the shell has not bound yet can only be
steered through its stored preference.

#### Scenario: Markers by default

- **WHEN** the reader opens the Cost view of a session that spawned subagents
- **THEN** the spawning Steps carry markers and the header total still covers the session alone

#### Scenario: Switching between the session and the subtree

- **WHEN** the reader switches the tab under the chart
- **THEN** one tab shows the session's own top list and the other shows the subtree, while the
  header total covers the session alone on both

#### Scenario: Expanding the subtree

- **WHEN** the reader asks to include subagents
- **THEN** progress is shown, the child sessions are read through the subagent route, and their
  costs appear as per-child lines attributed to the spawning Step

#### Scenario: Loading the whole subtree

- **WHEN** the reader asks for the full history of the subtree
- **THEN** every session below the session is read, and each one appears as its own line with its
  own cost under the Step that spawned it

#### Scenario: Following a child into its own Cost view

- **WHEN** the reader activates the jump on a child line whose session is already open on another
  tab
- **THEN** the shell switches to that session with its Cost view active, or — if the shell offers
  neither the preference nor the binding — opens the session and leaves the tab to the reader

#### Scenario: A child that cannot be read

- **WHEN** a child session cannot be read
- **THEN** the remaining lines are still reported and the unreadable branch is named as a
  diagnostic

### Requirement: Linear history export

The view SHALL be able to export the session's history as one ordered NDJSON stream,
`dsh-balance-<session id first 8 chars>-<yyyymmdd-hhmm>.cost-history.ndjson`, assembled by the
view and downloaded in the browser. The stream MUST begin with a `meta` record (plugin version,
session id and title, models, currency, the Tariff rule snapshot with rates, holidays, rule
source and date, the projection definitions, and the detail level) and every record MUST carry
`i`, `type`, `session`, `depth`, `seq` and `t` — the position in the stream, the record type, the
session the record came from, its nesting below the exported session, the session-log sequence it
came from, and its instant. Records MUST be ordered by `t` and then by `seq`, with `meta` first.

The record vocabulary SHALL be `meta`; one `usage` record per usage report carrying the model,
the token buckets and the cost under all three Tariff projections; one `retry` record per attempt
evicted by a retry carrying its model, buckets and projections and never counted in a total;
`tool_call` carrying the call name and id; `user_message`, `assistant_message`,
`assistant_thinking` and `tool_result` carrying text at the `full` level only; and
`subagent_spawn` / `subagent_settle` around the records of a child session. Subagent sessions
MUST be merged into the same stream in time order and marked by spawn and settle records, with
`session` and `depth` allowing the streams to be split apart again. Text at the `full` level
comes from the session log, because the projection holds usage and not messages.

The export SHALL offer two detail levels: `costs` (default, no message or tool text) and `full`
(message, tool and thinking text, each text field truncated at 2000 characters and flagged as
truncated, with `thinking` present only at this level). The UI MUST warn before a `full` export.
The plugin MUST NOT write the export anywhere on disk or in the workspace.

#### Scenario: Default export

- **WHEN** the reader exports with the default detail level
- **THEN** a single NDJSON file with the described name is downloaded, containing the ordered
  record stream with costs and no message or tool text

#### Scenario: Full export warns

- **WHEN** the reader selects the `full` detail level
- **THEN** a warning is shown before the download starts, and the resulting records carry text
  truncated at 2000 characters with the truncation flagged

#### Scenario: Subagents in one stream

- **WHEN** the session has subagent sessions and they are included
- **THEN** their records appear in the same stream at their own times, inside spawn and settle
  records, and nothing is written to the workspace or the harness home

### Requirement: Empty and error states

The view SHALL distinguish three states: the session has no Steps with usage yet; the session
has tokens but no rates apply to them; reading the history failed. The first two states MUST
explain themselves in place; the failed read MUST offer a retry.

#### Scenario: No steps yet

- **WHEN** the session has reported no usage
- **THEN** the view says that there is nothing to chart yet instead of drawing an empty plot

#### Scenario: No rates

- **WHEN** every Step of the session is unpriced
- **THEN** the view shows the token totals and states that no rates apply, with the control to
  enter fallback rates

#### Scenario: Read failure

- **WHEN** the series request fails
- **THEN** the view shows the error with a retry action

### Requirement: View-choice persistence

The metric, the X axis, the Tariff projection, the top-K mode and the open tab (the session's
own reading or the subtree) SHALL be stored globally through the existing settings write and
restored on the next mount of the view. Brush and zoom MUST NOT be stored.

#### Scenario: Choices survive a reload

- **WHEN** the reader sets the metric to cache read, the axis to Step index, the projection to
  `peak` and switches to the subagents tab, then reloads the page
- **THEN** the Cost view opens with those choices
