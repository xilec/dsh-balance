# Proposal

## Why

The three windows answer a different question than the one the panel asks them. `w1` is a
rolling 7 days and `m1` a rolling 30, so both are anchored on today rather than on a
calendar: on Thursday 2026-09-24 the "1w" figure is four days of spend under a "Last 7
days" label, on 2026-10-01 the "1m" figure is a single day of spend under "Last 30
days", and on 2026-09-30 a 30-day window reaches back into August. A reader asking "what
have I spent this week?" gets an answer to "what have I spent in the last 7 days?", and
the two differ most at the start of a week or a month — the moment a reader is most likely
to be looking.

The window lengths are baked into the two fields the payload reports for each window.
`days` is "how many rows were summed" and `covered` is `days === length`, which cannot
describe a window whose length changes with the day: on a Wednesday a covered week is
three days long, and the panel's `tip.partial` — "partial: {days} of 30 days measured" —
then fires on a month that is short only because it is the 2nd, which is the normal state
of a calendar month and not a shortfall at all.

## What Changes

- **`w1` is the current week, Monday to today.** ISO 8601 weeks start on Monday and that
  is the rule the panel now states; a Sunday-start week is the obvious alternative and is
  not this one.
- **`m1` is the current month, the 1st to today.** 28, 29, 30 or 31 days, whatever the
  month has.
- **Each window reports its own calendar length** (`days`: 1–7 for the week, 1–31 for the
  month), derived from the ledger's day keys rather than from a constant. The derivation is
  pure string/date arithmetic: the ledger's zone has already decided which calendar day
  each sample belongs to, so a window's first day is "the Monday on or before that key" or
  "the first of that month" — no clock, no `Date.now()`, no second timezone conversion.
- **`covered` keeps its one honest meaning**: the samples and the day rows reach back to
  the window's first day. A ledger that starts on Tuesday has not covered a week that began
  on Monday, whatever day it is read on.
- **`days` is the window's calendar length and a new `measured` is what the samples fill**,
  so `covered` is exactly `measured === days` and the two cannot describe different
  ranges. `historyDays: 3` leaves a week and a month almost entirely unsampled, and the
  payload now says so (`covered: false`, `measured: 3`) rather than reporting a confident
  small number as a whole week.
- **The panel's copy stops claiming a length.** The week and the month read as "so far
  this week" / "so far this month" in both locales, the cards are labelled "week from
  Monday" / "month from the 1st" with the day count as their hint, `d1` reads "today", and
  the partial flag appears only for a window the ledger does not reach — naming the days
  measured out of the days it spans, per window instead of only for the month.
- **The `d1` figure is byte-identical, and the day rows do not change at all**: a window
  is still a sum of the rows inside it, so the only thing that moves is which rows are
  summed. Where the new and old ranges overlap, the money is the same arithmetic over the
  same numbers; it differs only by the days the old rolling range included and the new
  calendar range does not.
- Tests: the boundary arithmetic in `test/history.test.js` (Monday, the day before a
  Monday, the 1st of a month, 31-day and 28/29-day months, the year boundary, each in a DST
  zone and a half-hour-offset zone) and the rendered labels in `test/client.test.js` (start
  of a week, middle of a week, month boundary, truncated ledger).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-tracking`: "Per-day ledger, windows and coarse days" — the week window starts on
  the Monday of the current week and the month window on the 1st; both end on today;
  `days` is the window's own calendar length, a new `measured` says how much of it the
  samples fill, and `covered` is true only when the ledger reaches back to the window's
  first day.
- `balance-panel`: "The composer readout" and "The Summary tab" — the windows are named as
  "so far this week" / "so far this month" / "today", the day count is shown as the span of
  the window rather than baked into the label, and the partial flag names a window the
  ledger does not reach instead of a shortfall against a fixed length.

## Impact

- `src/history.js` — the window table becomes a table of first-day derivations
  (`weekStartKey`, `monthStartKey`, `daySpan`, all exported for the tests), `windowTotal`
  ranges over a key range instead of a length, and the window objects report `days` and
  `measured`. Pure module: no imports, no clock, no IO, no signature change, no new
  dependency.
- `client/client.js` — the copy for `tip.spend1d`, `tip.spend1w`, `tip.spend1m`,
  `card.week`, `card.month`, `tip.partial` in both locales, plus a new `window.days` string
  for the span; `WINDOW_DAYS` and the length fallback in `windowDays` go away, since a
  browser half can no longer assume a length the Host did not report. The figures, their
  order, the muted styling and the Settings and Days tabs are untouched.
- The read payload gains `measured` inside each of `ledger.totals.{d1,w1,m1}` and `days`
  changes meaning from "rows summed" to "calendar length of the window". An older browser
  half keeps rendering the numbers and would label a truncated week with the count it was
  given; a newer browser half on an older Host renders the window name with no count, which
  is why the count is optional in the copy.
- `README.md` and one JSDoc line in `src/index.js` — the `historyDays` row, the feature
  bullet, the readout's one-line description and a new "Limits worth knowing" entry.
