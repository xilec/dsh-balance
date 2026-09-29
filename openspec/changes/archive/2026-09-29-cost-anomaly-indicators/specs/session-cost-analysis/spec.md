# Spec Delta

## MODIFIED Requirements

### Requirement: Per-Step cost series in the session projection

The Host SHALL retain, inside the session projection state, one node per `(Turn, Step)` location
holding every usage report of that node (model, event time, token buckets, and whether a retry
evicted it), the tool calls of the node, the node flags and the node's `kind`, which is `step` for a
Step of the conversation. A node's cost MUST be the sum of its surviving usage reports, and the
session **Session cost estimate** MUST be the sum of the same nodes so that a Step is counted
exactly once. Cost MUST be computed when the summary or the series is built, from the Tariff rule
snapshot, and rounding MUST happen only when the value is presented.

The projection SHALL also fold the compaction events of the session — `compaction/start`,
`compaction/summary`, `compaction/end` and `compaction/prune` — and SHALL hold one node of kind
`compaction` per compaction whose summarizing call was paid for, carrying that call's usage and cost,
the compaction id, the model that wrote the summary and the number of shadowed tokens. A **Compaction
step** MUST belong to a Turn like any other node: the Turn named by its own event when the event
names one, otherwise the Turn whose accumulated context it rewrote, and when no Turn precedes it, it
MUST stay turn-less. The sum invariant MUST hold over compaction nodes too, and a compaction node
MUST hold no tool call, MUST NOT be drawn in the per-Step cost line, and MUST NOT be treated as a
Step of the conversation by any reader.

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

- **WHEN** any sequence of usage, retry, model-switch and compaction events is folded
- **THEN** the session cost equals the exact sum of the node costs, the Compaction steps included,
  and no rounding error is introduced between the parts and the whole

#### Scenario: Unpriced model inside a node

- **WHEN** a node's model has no rate in the Tariff rule
- **THEN** the node is flagged `unpriced`, its tokens are still counted in token metrics, and
  its cost is never silently counted as zero

#### Scenario: A compaction inside a Turn

- **WHEN** a compaction event names the Turn it belongs to
- **THEN** its node is placed in that Turn ahead of the Step the compaction serves, and the Turn's
  Steps keep their own numbers

#### Scenario: A compaction between Turns

- **WHEN** a compaction event names no Turn
- **THEN** its node belongs to the Turn whose accumulated context it rewrote, its instant is the
  compaction's own instant, and the per-Step cost line is unchanged by it

#### Scenario: A compaction before the first Turn

- **WHEN** a compaction event names no Turn and no Turn precedes it
- **THEN** the node stays turn-less, is still counted in the Session cost estimate and still
  appears in the export, and draws no point on the chart

### Requirement: Series and Tariff rule payload

The series response SHALL be self-describing: each node carries `turn`, `step`, its `kind`, start and
end time, the token buckets split per model, the retry count, its tool calls (name, call id, and an
argument preview of up to three lines and at most 200 characters, with escaped
newlines decoded), its subagent spawns — the `children` list of child id, mode, label and
creation time, the parent's own catalog facts, which is what the markers are drawn from — and
its flags; a node of kind
`compaction` carries the compaction id, the model that wrote the summary, the shadowed token count
and the Turn it is anchored to, or no Turn when it has none. The response also
carries the rates with their effective dates, the absolute peak intervals covering the series,
the holidays, the Tariff rule source and verification date, the currency, the account-wide
calibration of the session's interval when the samples can express one, the `seq` the series
was built from, the Findings detected over that same series, and the effective Indicator thresholds
with the active Sensitivity preset they were detected under.

#### Scenario: The client needs no tariff logic

- **WHEN** the client renders phases, peak bands or projections
- **THEN** every value it uses comes from the response, and the client derives no peak,
  holiday or rate decision of its own

#### Scenario: Absolute intervals cover the series

- **WHEN** a session spans several days, weekends or holidays
- **THEN** the response contains the absolute peak intervals for the whole series range, so the
  chart can band them without recomputing the rule

#### Scenario: The client needs no detection logic

- **WHEN** the client draws badges, lists Findings or explains one
- **THEN** every Finding, threshold and preset value it uses comes from the response

### Requirement: Linear history export

The view SHALL be able to export the session's history as one ordered NDJSON stream,
`dsh-balance-<first 8 chars of the session id, with a leading "session-" prefix dropped>-<yyyymmdd-hhmm>.cost-history.ndjson`, assembled by the
view and downloaded in the browser. The stream MUST begin with a `meta` record (plugin version,
session id and title, models, currency, the Tariff rule snapshot with rates, holidays, rule
source and date, the projection names, and the detail level) and every record MUST carry
`i`, `type`, `session`, `depth`, `seq` and `t` — the position in the stream, the record type, the
session the record came from, its nesting below the exported session, the session-log sequence it
came from, and its instant. A record the builder synthesizes rather than reads from a log (the
`subagent_spawn` and `subagent_settle` markers) carries `seq: null` instead of inventing one. Records MUST be ordered by `t` and then by `seq`, with `meta` first.

The record vocabulary SHALL be `meta`; one `usage` record per usage report carrying the model,
the token buckets and the cost under all three Tariff projections; one `retry` record per attempt
evicted by a retry carrying its model, buckets and projections and never counted in a total;
`tool_call` carrying the call name and id; `user_message`, `assistant_message`,
`assistant_thinking` and `tool_result` carrying text at the `full` level only; `indicator` carrying
one Finding with its kind, references, severity, confidence and evidence; `compaction` carrying one
compaction the session paid for, with its id, the model that wrote the summary, that call's usage
and its cost under all three projections, the shadowed token count and the Turn it is anchored to;
and `subagent_spawn` / `subagent_settle` around the records of a child session. Subagent sessions
MUST be merged into the same stream in time order and marked by spawn and settle records, with
`session` and `depth` allowing the streams to be split apart again. Text at the `full` level
comes from the session log, because the projection holds usage and not messages.

Every field the name and the truncation are built from MUST survive a degenerate value: a session
id that is empty, not a string or holds characters a file name cannot, and a clock the browser
cannot read, must still produce a name in the documented shape, and a 2000-character cut MUST NOT
split a character in half.

The plugin MUST NOT write the export anywhere on disk or in the workspace.

#### Scenario: Default export

- **WHEN** the reader exports with the default detail level
- **THEN** a single NDJSON file with the described name is downloaded, containing the ordered
  record stream with costs and no message or tool text

#### Scenario: Subagents in one stream

- **WHEN** the session has subagent sessions and they are included
- **THEN** their records appear in the same stream at their own times, inside spawn and settle
  records, and nothing is written to the workspace or the harness home

#### Scenario: A name and a cut that hold under odd input

- **WHEN** the session id is empty, is not a string, or holds characters a file name cannot, or
  the clock the browser offers cannot be read
- **THEN** the downloaded name keeps the documented shape, with `unknown` where the id is missing
  and no unreadable stamp — and a text field cut at the limit still ends on a whole character

#### Scenario: Findings in the stream

- **WHEN** the exported session's series reported Findings
- **THEN** the stream carries one `indicator` record per Finding, at the instant its first
  referenced Step starts, ordered with the other records

#### Scenario: A compaction in the stream

- **WHEN** the session paid for a compaction, including one that precedes its first Turn
- **THEN** the stream carries a `compaction` record for it with its usage, its three projected
  costs, its shadowed token count and its anchor, or no anchor when it has none
