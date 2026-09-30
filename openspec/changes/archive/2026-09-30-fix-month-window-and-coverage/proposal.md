# Proposal

## Why

The 1-month total is not a month. `buildLedger` sums the last `historyDays` day rows for
`m1` and asks `windowCovered(days)` whether the samples reach back that far, while `w1` sums
at most 7 rows. `historyDays` is a panel setting writable down to 3, so the "1m" figure is
really "the last `historyDays` days", and the two ends of the setting are both wrong.

On 46 samples that spend 0.5 per day since 2026-08-10 (one instant per day, `dayZone` UTC,
`now` 2026-09-24T12:00Z), with nothing else changed:

| `historyDays` | `m1.amount` | `m1.covered` | what the amount actually spans |
| ------------- | ----------- | ------------ | ----------------------------- |
| 3             | 1.5         | true         | 3 days                       |
| 30            | 15          | true         | 30 days                      |
| 400           | 22.5        | false        | 45 days                      |

A 3-day sum is labelled "1m" and claims to be covered; a 45-day sum is labelled "1m" and
claims *not* to be covered. Shortening the ledger improves the coverage claim, and lengthening
it inflates the month and destroys the coverage claim — both backwards. The panel then prints
the same two figures under hard-coded "Last 30 days" / "30 days" labels, so the wrong number
is also the wrong claim about the data, one layer up.

`openspec/specs/balance-tracking/spec.md` already says the 1-day, 1-week and 1-month totals
are summed from the rows and that `covered` is true "only when the samples reach back to the
first day of that window". The code does not implement that: it reaches back to the first day
of a window whose length is a setting. The reviewer is right and the spec is right.

## What Changes

- Each window ranges over its own fixed length — 1, 7 and 30 days — computed from the day keys
  (`recentDayKeys`) rather than from the row array, so `amount` and `covered` describe the same
  range. `historyDays` keeps saying how many day rows the ledger keeps, and nothing else.
- `covered` is true only when the samples actually reach the first day of that window **and**
  the ledger holds a row for every day of it. A `historyDays` below the window therefore
  reports `covered: false` for that window instead of quietly shortening it.
- The amount of a window that the ledger is too short to fill is the sum of the rows it does
  have, and `covered` is the flag that says so. Each window additionally reports `days`: how
  many days inside the window the samples actually measure, capped by the window length and by
  the rows available. `covered` is exactly `days === length`, so a reader can tell a truncated
  ledger from a merely short one, and the panel can label the figure.
- The panel's copy stops asserting a length the payload does not have. The card labels and the
  detail rows read the window's own `days` (falling back to the window length when an older
  Host sends no count), and the "partial" flag names how much was measured.
- A ledger of 30 or more rows produces exactly the same figures as before, in every zone. A
  ledger longer than 30 rows now reports a 30-day month instead of a `historyDays`-day one,
  and a shorter one reports what it has with `covered: false`.
- Tests: `test/history.test.js` gains cases for `historyDays` of 3, 29, 30 and longer than the
  window, for a sample set that genuinely does not reach back, and a differential check that
  the figures a complete ledger produces are unchanged; `test/client.test.js` gains a case for
  the rendered label of a truncated ledger.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-tracking`: "Per-day ledger, windows and coarse days" — the window lengths are fixed
  and independent of `historyDays`; a window reports the number of days it measured; `covered`
  is true only when the ledger holds the whole window and the samples reach its first day.
- `balance-panel`: "The Summary tab" — the window cards and detail rows label a window by the
  days the payload reports for it rather than by a hard-coded 7 and 30, and the partial flag
  names the shortfall.

## Impact

- `src/history.js` — `buildLedger`'s window totals and their JSDoc. Pure module, no signature
  change, no new dependency.
- `client/client.js` — the copy for `card.week`, `card.month`, `tip.spend1w`, `tip.spend1m`
  and `tip.partial` in both locales, and the two places that render them. The readout's muted
  styling and its figure order are unchanged.
- The read payload gains `days` inside each of `ledger.totals.{d1,w1,m1}`. A browser half
  older than this change ignores it and keeps rendering the window names; the numbers it shows
  change only where they were wrong (a ledger shorter or longer than the window).
- `src/index.js` needs no change: it passes `days: runtime.historyDays` and serves whatever
  `buildLedger` returns, and the settings field the client reads back
  (`ledger.rows.length`) is still exactly `historyDays`.
- `README.md` — the one-line description of `historyDays` no longer claims the rows are rolled
  up into the month window.
