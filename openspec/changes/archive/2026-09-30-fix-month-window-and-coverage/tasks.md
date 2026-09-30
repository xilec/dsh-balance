# Tasks

## 1. Make the windows their own length

- [x] 1.1 In `buildLedger` (`src/history.js`), replace the three tail-of-`rows` sums with one
  `windowTotal(length)` that ranges over `min(length, rows.length)` rows, so a window is a
  fixed number of days and `historyDays` decides only how many rows exist
- [x] 1.2 Derive the same helper's `covered` from what the window measured instead of from
  `windowCovered(days)`: the measured span is the first sample's day index in the row array,
  the count is `min(length, rows.length, measured)`, and `covered` is `days === length`
- [x] 1.3 Report `days` in each window object and say the rule in the JSDoc above
  `buildLedger`: windows are fixed lengths, a short ledger sums what it has, and `covered` is
  the flag that says the sum is partial
- [x] 1.4 Check the path that serves the payload (`src/index.js`) and the client's settings
  restoration: `days: runtime.historyDays` still describes the row count, and
  `ledger.rows.length` still equals `historyDays`, so neither needs a change

## 2. Label the figure the panel actually has

- [x] 2.1 In `client/client.js`, make `card.week`, `card.month`, `tip.spend1w` and `tip.spend1m`
  read the window's own `days` in both locales, falling back to the window length when an
  older Host sends no count
- [x] 2.2 Update `tip.partial` to name the shortfall ("partial: {days} of 30 days"), and keep
  it keyed on the month window's `covered`
- [x] 2.3 Leave the readout's figures, their order and the muted styling alone; only the legend
  it builds from the same keys changes

## 3. Cover the finding with tests

- [x] 3.1 In `test/history.test.js`, cover `historyDays` shorter than the month (3 and 29),
  exactly the window, and longer than it: the amount sums the window's own days, `covered` is
  false below the window, and a longer ledger does not inflate the month
- [x] 3.2 Add a case where the ledger holds every day of a window but the samples do not reach
  back to its first day, so `covered` is false and `days` is short even with `historyDays: 30`
- [x] 3.3 Add a differential check: the same samples through several `historyDays` values in
  three zones produce the figures the pre-change code produced for every `historyDays <= 30`,
  and the documented difference above it
- [x] 3.4 In `test/client.test.js`, render the Summary with a payload whose month window
  measured 3 days and assert the card and the detail row are labelled 3 days rather than 30
- [x] 3.5 Run `npm test`: no test count reduction, and every pre-existing case green unless it
  encoded the bug (say so in the PR if one did)
  — done: 299/299, four more than the 295 on `main`; no pre-existing case encoded the bug, so
  nothing was rewritten — the one pre-existing window test only gained an assertion on `days`

## 4. Docs and gates

- [x] 4.1 Correct the `historyDays` row in `README.md`: it keeps the day rows and no longer
  decides what the month window sums
- [x] 4.2 `openspec validate --all` clean, `npm test` green, `nix flake check` passed, and
  knip + jscpd clean in a scratch copy
