# Proposal

## Why

Three tests in the suite read the wall clock in their **assertions**, so their outcome depends
on the day and the hour they run at rather than on the code they cover. `main` is red right now
for that reason alone: `peakNow` is a fact about the instant the view is read at and was asserted
to be `false` in a test about a Saturday session, the payload's `prices.current` column is priced
at `Date.now()` and was asserted to hold the off-peak rate, and a thinning fixture anchored at
`now` lands across a clock-hour boundary whenever the suite starts in the two minutes before one.
A fourth test names two days of September 2026 and reads them back out of a rolling 30-day
ledger, so it goes red on its own in October and stays red in 2030. None of this is a bug in the
plugin — it is a suite that is green or red depending on when and where it is run, which is the
one thing a test suite cannot afford.

## What Changes

- `test/session-cost.test.js` — the weekend-session case asserts the session's own pricing (its
  cost and its Step's `peak` projection) instead of `peakNow`, and a new case covers `peakNow`
  itself with the clock pinned through `t.mock.timers`, which is the coverage the field never had.
- `test/plugin-host.test.js` — the currency case asserts the *relation* the payload promises
  (`current` is the peak rate or `OFF_PEAK_RATIO` of it, and says which), and a new case pins the
  clock to a peak window and to the off-peak hour after it to pin down both values of the table.
- `test/plugin-host.test.js` — the log-thinning case anchors its "one old hour" inside a clock hour
  instead of at an offset from now, so the three samples cannot straddle a thinning bucket.
- `test/plugin-host.test.js` — the blocked-state-write case takes the two corrected days from the
  ledger the Host serves (`rows.at(-2)`, `rows.at(-3)`) instead of dates written into the test, so
  they stay inside the rolling window whatever the date is.
- `test/phase.test.js` — the "host zone" case compares `local` against the host's own zone by name
  instead of counting windows. West of UTC-7 the instant it uses is still the previous local day
  there, and only one of the two Beijing windows is inside it, so the count was a claim about the
  machine the suite ran on.
- A guard: `test/clock-shift.test.js` re-runs the whole suite with the clock pinned to instants
  chosen to be hostile in the ways these defects were (`test/fixtures/clock-shift.mjs` is the
  `node --import` shim that pins it). It fails on any difference, and it is what stops the next
  one from being found by a colleague instead.
- No plugin code changes. `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None — the plugin's behaviour and every spec requirement are unchanged; only tests change, and two
of them now assert what the payload actually promises instead of a value the ambient clock chose.

## Impact

- Tests only: `test/session-cost.test.js`, `test/plugin-host.test.js`, `test/phase.test.js`, plus
  the new `test/clock-shift.test.js` and `test/fixtures/clock-shift.mjs`.
- `src/` and `client/` are untouched: `peakNow` and `prices.current` are meant to be priced at
  *now*, and the fix is in the assertions, not in the fields.
- The suite costs roughly twice as long: the guard runs the suite twice more, with the clock
  pinned. `nix flake check` runs the same thing, so its `tests` check pays for it too.
- No new dependency, no change to any payload, route or figure.
