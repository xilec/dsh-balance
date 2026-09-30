# Tasks

## 1. Derive the windows from the day keys

- [x] 1.1 In `src/history.js`, add `weekStartKey(dayKey)` (the Monday on or before it),
  `monthStartKey(dayKey)` (the first of that month) and `daySpan(fromKey, toKey)` as exported
  pure helpers over a `YYYY-MM-DD` key, with the Monday rule stated in the JSDoc
- [x] 1.2 Replace `WINDOW_DAYS` with a table of first-day derivations per window and compute
  each window's length as the number of calendar days from that first day through today
- [x] 1.3 Rewrite `windowTotal` to take a first day key: it sums the rows from
  `max(0, rows.length - length)`, reports `days` as the length and `measured` as the days
  the rows and the samples fill, and keeps `covered` as `measured === days`
- [x] 1.4 Update the JSDoc on `buildLedger` (`options.days`, the return) so the three windows
  are today, this week from Monday and this month from the 1st

## 2. Make the panel's copy match the windows

- [x] 2.1 In `client/client.js`, rewrite `tip.spend1d`, `tip.spend1w` and `tip.spend1m` in
  both locales to name today / so far this week / so far this month, and add `window.days`
  for the span
- [x] 2.2 Label the Summary cards with the anchors ("week from Monday", "month from the
  1st") and pass the payload's span as the card hint
- [x] 2.3 Delete `WINDOW_DAYS` and the length fallback in `windowDays`; the span comes from
  the payload, and a payload without one renders the window's name alone
- [x] 2.4 Key the partial flag on both the week and the month and make it name the window,
  the days measured and the days it spans
- [x] 2.5 Check the readout legend and `aria-label` (both are built from the same keys), and
  leave the Settings and Days tabs alone — their `historyDays` field already reads as
  retention, which is what it is

## 3. Prove the boundaries

- [x] 3.1 In `test/history.test.js`, cover `weekStartKey`/`monthStartKey`/`daySpan` and the
  window lengths: a Monday, the day before a Monday (a Sunday), a Wednesday, the 1st of a
  month, a 31-day month, February in a leap year and outside one, and the year boundary
- [x] 3.2 Build the same fixtures through five zones, among them a DST zone and a
  half-hour-offset one, and assert the windows and the rows are the same, including a week
  that spans a DST transition
- [x] 3.3 Pin the day rows a pre-change build produced for the 45-day fixture in three zones,
  and assert each window's amount as the sum of the rows inside its own key range, so the
  money arithmetic cannot move for the days both definitions share
- [x] 3.4 Cover the short ledger (`historyDays: 3` on a Thursday and on a Wednesday): `days`
  is the window's own length, `measured` is 3, and `covered` is false for the month on both
  days but true for a Wednesday's three-day week
- [x] 3.5 In `test/client.test.js`, render the Summary at the start of a week, in the middle
  of one, at a month boundary, with a truncated ledger and with no day count at all, and
  assert the labels, the card hints and the partial flag; assert both locales' copy carries no
  length of its own
- [x] 3.6 Run `npm test`: no test count reduction, and every pre-existing case green unless
  it encoded the old window length — four of them did, and each was rewritten to the calendar
  range rather than deleted

## 4. Docs and gates

- [x] 4.1 Correct the `historyDays` row in `README.md`, the feature bullet, the readout's
  one-line description, the development map and the `historyDays` JSDoc in `src/index.js`,
  and add the Monday/1st rule to "Limits worth knowing"
- [x] 4.2 `openspec validate --all` clean, `npm test` green, the determinism proof (five `TZ`
  values, `test/clock-shift.test.js`, six concurrent copies) green, `nix flake check` passed,
  and knip + jscpd clean in a scratch copy
