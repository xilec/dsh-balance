# Tasks

## 1. Fix the three defects `main` is red on

- [x] 1.1 `test/session-cost.test.js` — replace `assert.equal(unit.wire.view(state).peakNow, false)`
  in *a weekend session is priced off-peak even inside peak hours* with the session's own money:
  `state.cost`, the Step's `node.cost` and `node.peak.cost`, the idiom the neighbouring projection
  cases use. Verify with `node --test test/session-cost.test.js`, and confirm the case still fails
  if the session is priced at peak (move the fixture to a Thursday morning in a scratch copy)
  — done: the fold prices the Saturday session at 5 against the Thursday's 10, and `node.peak.cost`
  is the 10 it would have cost at peak, so the case says what its name says
- [x] 1.2 `test/session-cost.test.js` — add the case `peakNow` never had: pin the clock with
  `t.mock.timers.enable({ apis: ['Date'], now: bjt(2026, 9, 24, 10, 0) })`, assert `true`, `tick`
  three hours to 13:00 BJT, assert `false` and that the session's cost did not move; `reset` the
  mock at the end so the rest of the file is unaffected
  — done: the field is covered for both phases, and the case passes only with the clock pinned —
  on a peak-window host without the pin the first assertion fails, which is the point
- [x] 1.3 `test/plugin-host.test.js` — in *the account currency replaces a preference the account
  does not have*, stop asserting the literal off-peak rate against `prices.current`; assert the
  relation to `prices.peak` through `OFF_PEAK_RATIO` and the `peak` flag the field carries, and
  import `OFF_PEAK_RATIO` from `src/pricing.js`
  — done: the assertion holds at any hour of any day and still fails if the ratio or the USD peak
  rate is wrong
- [x] 1.4 `test/plugin-host.test.js` — add *the price table is priced at the instant the payload
  was built*: pin the clock to a Beijing peak window, assert `current` is the peak rate and
  `peak` agrees, `tick` to the off-peak hour after it and assert `current` is `OFF_PEAK_RATIO` of
  the peak while the `peak` column has not moved. The field is client-visible, so it wants the
  exact numbers rather than only the relation
  — done: all four numbers are asserted, and the case is what the relation in 1.3 stands on
- [x] 1.5 `test/plugin-host.test.js` — in *the sample log is thinned while the Host runs, not only
  at startup*, anchor the "one old hour" inside a clock hour: floor the instant to the hour and add
  ten minutes, so the three samples 60 s apart cannot straddle a thinning bucket. Verify by running
  the file with the clock pinned two minutes before an hour boundary
  — done: the case passes at `…T13:58:30Z` and at `…T19:45:00Z`, and before the change it counted
  two survivors at the first of those

## 2. Audit the rest of the suite for the same class

- [x] 2.1 Walk every clock read in `test/`: `Date.now()`, `new Date(`, `Date.UTC(`, `mkdtemp`,
  `setTimeout`, `t.mock.timers` — 60-odd hits across eleven files — and decide for each whether
  the *assertions* depend on where now sits. Record the ones that did and the ones that were
  checked and are sound
  — done: four more defects found (2.2 to 2.4 below) and the rest are fixtures whose assertions
  read fixed instants: `test/history.test.js` and `test/pricing.test.js` pass `nowMs`/instants
  explicitly, `test/phase.test.js` reads `Date.parse`ed ISO strings, `test/export.test.js` times
  its own export and names a file from a fixed date, and the `Date.now()` uses in
  `test/client.test.js` and `test/store.test.js` only build fetch-cache states, sample logs and
  override anchors that the assertions compare against other fixture values
- [x] 2.2 `test/phase.test.js` — *local windows convert the Beijing windows into the display zone*
  failed in every zone at or west of UTC-7: its instant is still the previous local day there, so
  the host's day holds one Beijing window and the case asserted two. Compare `local` against
  `Intl.DateTimeFormat().resolvedOptions().timeZone` and assert only that the host's day is a
  trading day. Verify with `TZ=America/New_York`, `TZ=Pacific/Midway` and `TZ=Asia/Tokyo`
  — done: green in nine zones, and it failed in `America/New_York` before
- [x] 2.3 `test/plugin-host.test.js` — *a state write that cannot land is reported and does not
  wedge the next one* named `2026-09-02` and `2026-09-03` and then read one of them back out of
  the rolling 30-day ledger, so it goes red on 2026-10-03 and stays red. Add the `readLedger`
  helper and take the two days from `rows.at(-2)` and `rows.at(-3)`
  — done: the case is green on every date from 2026-09-30 to 2030-07 that it was run against,
  where before it failed on every date after 2026-10-03
- [x] 2.4 `test/plugin-host.test.js` — *two corrections written at the same time both land on disk*
  also names `2026-09-01`, but only as a key of a state document it writes itself and reads back;
  the ledger window never enters it. Left alone deliberately, and noted in the PR
  — done: verified against the overrides route and the state document, no dependency on today
- [x] 2.5 Verify the audit by sweeping, not by reading alone: run the suite with the clock pinned
  across a grid of instants — every two hours of a weekday, a public holiday, a Saturday and a
  Sunday, at minute `:00` and minute `:58` — in `UTC`, `Asia/Kolkata` and `America/New_York`, and
  again across ten dates from 2026-09-30 to 2030-07 at three hours of the day
  — done: the grid found the `phase.test.js` defect (it appears in the `America/New_York` column
  only) and the date sweep found the ledger-window defect; everything else was green before and
  after, and the whole grid is green now

## 3. Stop it coming back

- [x] 3.1 `test/fixtures/clock-shift.mjs` — the `node --import` shim: pin (or shift) the clock the
  process sees by replacing the global `Date` with a subclass whose no-argument constructor and
  `now()` are the only difference; everything else stays the real `Date`, and a
  `t.mock.timers` pin installs over the top of it
  — done: read through both variables, with the reason a frozen clock is a constraint spelled out
- [x] 3.2 `test/clock-shift.test.js` — the guard: re-run every other suite file with the clock
  pinned to `2026-09-30T02:58:30Z` in UTC and `2026-10-03T07:30:00Z` in `America/New_York`, and
  fail on any non-zero exit. The first run reproduces the first three defects; the second is a
  different weekday, an off-peak tariff, a mid-hour instant and a host zone whose day is not the
  Beijing day, which is what the fourth defect needed
  — done, and see 3.3 for the two ways it could have been a guard that never runs
- [x] 3.3 Make the guard fail loudly instead of passing quietly: drop `NODE_TEST_CONTEXT` from the
  child's environment (inherited, it makes the child exit at once, print nothing and report
  success) and assert `child.stdout` is non-empty; give each run its own `TZ`, since a clock hour
  is an hour of the host's zone
  — done: the empty-stdout assertion is what caught it, and the guard now runs the whole suite in
  each of its two children
- [x] 3.4 Prove the guard fails on the defects it exists for: run it against scratch copies that
  have the pre-fix `test/session-cost.test.js`, `test/plugin-host.test.js` and `test/phase.test.js`
  with the branch's guard and shim, and confirm the guard reports a failure for each
  — done: all three pre-fix files fail the guard, each reported through it, which is the only proof
  that it is armed and not merely green
- [x] 3.5 Gates: `npm test` green, the suite green at each of the pinned instants and in each
  swept zone, `nix flake check` green, `knip` and `jscpd` clean in a scratch copy, and
  `openspec validate --all` with no failures
  — done
