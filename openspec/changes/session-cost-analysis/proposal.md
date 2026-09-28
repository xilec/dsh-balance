# Proposal

## Why

The plugin can already answer "how much has this session cost" (the composer chip and
the panel card), but not "where did that money go". A session cost estimate of `$4.12`
gives the user nothing to act on: the spike may come from one expensive step, from a
subagent subtree, or purely from the tariff window the work ran in. Issue #1 asks for a
per-session **Cost** view that answers that in seconds, with no LLM session and no
waiting, and for a linear history export for the deeper, optional dive.

## What Changes

- A new **Cost** view tab in `conversation.view` (`order: 20`, label `Cost`), mounted
  lazily per session and shown whether or not Coding Tools are enabled.
- The Host keeps a **per-step series** (one point per `(turn, step)` node, with the usage
  reports inside it) in the `dshBalanceCost` projection state, and serves it through a new
  `GET /dsh-balance/session-cost` route. The wire view keeps only the summary plus a `seq`,
  so no heavy array is re-validated and re-sent on every usage event.
- `dshBalanceCost` becomes **derived from that series** (Σ of step costs), so the chip, the
  panel card and the tab can never disagree.
- The route ships the rule material the chart needs — rates with their effective date, the
  absolute peak intervals covering the series, holidays, rule source and date, currency —
  and the client derives nothing from the tariff rule itself.
- The view draws a hand-rolled canvas plot (step line, markers, stems) with a DOM overlay
  for axes, tooltip, peak bands, turn separators and brush handles; decimation per pixel
  column and an explicit clipping marker keep a 10⁴-step history interactive.
- Cost is shown under three **tariff projections** (`fact` default, `offPeak`, `peak`), and
  a metric selector (cost, output, cache read, cache write, total tokens) makes the driver
  of a peak visible, not only the money.
- Top-K (steps or turns, over the visible range), wheel zoom, right-drag pan, brush,
  click-through inspector and a "show in Trajectory" jump for tool-call steps.
- `Unpriced` models are surfaced explicitly and priced per model from editable fallback
  rates; entering rates retroactively reprices the whole history, chip included.
- Subagent sessions appear as spawn markers by default; their cost is **not** folded into
  the session total and is expanded into per-child lines only on demand.
- A **linear full history** export as NDJSON, built and downloaded in the browser
  (`dsh-balance-<session-id-8>-<yyyymmdd-hhmm>.cost-history.ndjson`), merging subagent
  sessions into one time-ordered stream, in `costs` (default) and `full` detail levels.
- View choices (metric, X axis, tariff projection, top-K mode) persist through the existing
  `POST /dsh-balance/settings`; brush and zoom do not persist.

Work is split into five stages (data model and chart, tariff and metric projections, top-K
and brush, subagents, export); the change is archived after the fifth stage is accepted.

## Capabilities

### New Capabilities

- `session-cost-analysis`: the per-session Cost view — the per-step cost series it reads,
  the chart, tooltip and inspector, tariff projections and metrics, top-K, brush, subagent
  markers and the linear history export.

### Modified Capabilities

None. The behaviour of the existing balance panel and composer readout is not restated
here; those surfaces are backfilled into specs by a later change.

## Impact

- `src/session-cost.js` — the projection grows per-step state and a derived total; its wire
  view gains the summary fields (`seq`, step count, projection-independent figures).
- `src/index.js` — a new `GET /dsh-balance/session-cost` route; new mutable settings keys
  for the view choices and the per-model fallback rates; the settings route keeps writing
  only through `MUTABLE_SETTINGS`.
- `client/client.js` — a new `conversation.view` registration, the canvas plot and its
  overlay, the inspector, top-K, brush, subagent handling and the export builder; new pure
  functions are exposed through the existing `exports.__internals` for `node:test`.
- `test/` — new unit tests for the fold, the scales/decimation/clipping maths, the route
  boundaries and a golden NDJSON export.
- No new runtime dependency: the plot is drawn by hand because the shipped shell has no
  charting library and the project has no bundler.
- Nothing is written to the workspace or `$DSH_HOME` by the export: the browser downloads
  the file.
