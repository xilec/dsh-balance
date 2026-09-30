# Design

## Context

See `proposal.md` — Why. The shape of the problem is that this suite has three different kinds of
"now", and the defects are three different mistakes about which one a given expression means.

| what | read from | may a test assert on it? |
|---|---|---|
| the instant of an event | the event's own `time` | yes — that is what the test is about |
| the instant a payload is built | `Date.now()` inside `pricePayload` / `view` | only with the clock pinned |
| the day a ledger row belongs to | `Date.now()` inside `buildLedger` | no — a rolling window, so a date written into a test expires |

Two more things shape the approach. The plugin is right in all four cases: `peakNow` and
`prices.current` are documented as "the tariff in force right now", and the payload is built per
read, so a field priced at *now* is correct behaviour and a test that pins it to a number is the
defect. And the suite already owns the two tools this needs: `t.mock.timers` (with `apis: ['Date']`,
which leaves `setTimeout` real so the fs-race cases keep working) and a module-load safety net in
`test/plugin-host.test.js` that gives a missing `$DSH_HOME` a throwaway directory.

## Goals / Non-Goals

**Goals:**

- The suite's result is a function of the code, not of the instant or the zone it runs at.
- A regression of this class is caught by the suite, not by whoever runs it next.
- No plugin behaviour changes and no existing case loses coverage.

**Non-Goals:**

- Making the whole suite run on a frozen clock. A frozen `Date` breaks the sampling loop's
  own cadence (`now - lastSample.t` never grows, so a refresh can be throttled into doing
  nothing), so a global pin is not available even in principle.
- Proving the suite is green at *every* instant. The guard samples four hostile instants; the
  rest is what the audit in `tasks.md` bought by reading, and what a sweep bought by running.

## Decisions

- **D1 — The weekend case asserts the session, and `peakNow` gets a case of its own with the clock
  pinned.** `peakNow` answers "is it peak right now", so asserting it inside a test about a
  Saturday session was never going to say anything about the session: the fold already priced the
  session off-peak (`state.cost === 5`), and the series carries both projections, which is the
  idiom three neighbouring cases use. `peakNow` had no coverage at all — the only two mentions
  were this assertion and a key list — so the field is now covered by its own case, with
  `t.mock.timers.enable({ apis: ['Date'] })` and a `tick` from a Beijing peak window to the
  off-peak hour after it, which is also what shows that the field follows the clock while the
  session keeps its own price.

  The alternative — deleting the line — was rejected: the field is client-visible (the chip's
  tooltip) and would go back to being uncovered.

- **D2 — The currency case pins the clock, and a second case walks the two phases.** The case is
  about currency (`prices.currency === 'USD'`, the ledger and the balance following the account),
  and the rate assertion rode along. Both columns of the price table are priced at `Date.now()`
  *and* the table behind them is effective-dated — `RATE_SCHEDULE` holds the 2026-08-23 era and
  the 2026-09-10 Flash cut as two entries, so a USD peak rate of `0.44` becomes `0.3` partway
  through September 2026. A literal in this case is therefore a claim about a tariff era, not
  about the currency, and the case pins the clock to 2026-09-24 10:00 BJT so the literals are
  exact and keep proving that the USD table answered rather than the CNY one.

  What `current` promises is checked as a relation, and read off the payload's own peak column:
  `current.cacheMiss === payload.prices.peak[...].cacheMiss * (current.peak ? 1 : OFF_PEAK_RATIO)`.
  The two columns are built into one payload and shown side by side, so this is a real
  cross-field invariant — it fails if the two are priced at different instants. Stating the same
  relation against a literal instead only re-derives the formula the payload was built by, and
  holds for any rate table at all; that form was tried first and rejected.

  A second case pins the clock to the same peak window, asserts the four numbers exactly, `tick`s
  three hours to the off-peak hour after it, and asserts that `current` has halved while the `peak`
  column has not moved. Both columns are user-visible, so they want the exact numbers and not only
  the relation.

- **D3 — Fixtures are anchored, not offset.** The thinning case wants "three samples of one
  clock hour, older than the retention window", and `compactSamples` buckets on the ledger zone's
  clock hour since PR #10. `Date.now() - 30d` starts the three samples at whatever minute the suite
  happens to begin at, so within two minutes of an hour boundary the samples straddle two buckets
  and the case counts two survivors. The fixture is now floored to the hour and moved ten minutes
  in, which is the same instant for every run of the day. The alternative — a count assertion that
  tolerates one or two survivors — was rejected: it would have kept the test from saying what it
  is about.

- **D4 — Day keys come from the ledger, not from the test file.** `buildLedger` returns a rolling
  window of 30 days ending today, so a test that names `2026-09-02` and then looks that row up
  stops finding it on 2026-10-03 and stays broken forever after. The blocked-write case now reads
  the ledger through the read route first and takes `rows.at(-2)` and `rows.at(-3)`, which is
  inside the window on any date. This is the same idiom `two corrections written at the same time`
  already used for `todayKey`.

  The alternative — passing a `nowMs` into the Host — does not exist: the Host reads the clock
  itself, and making it injectable to suit a test would be a plugin change for a test's sake.

- **D5 — The `local` zone case compares names, not counts.** `windowsOfLocalDay(instant, _, 'local')`
  resolves the *host's* zone, and 2026-09-18T06:54Z is still Thursday in any zone at or west of
  UTC-7 — so in New York the host's day holds one of the two Beijing windows, and the old
  assertion of "both windows" failed there. The case now compares `local` against
  `Intl.DateTimeFormat().resolvedOptions().timeZone` (which is the same thing by another name) and
  asserts only that the host's day is a trading day, which is guaranteed: that instant is a
  Thursday or a Friday in every zone that exists.

- **D6 — The guard re-runs the suite under a pinned clock, rather than scanning the sources.** A
  static check cannot catch the first defect: `peakNow` comes from `Date.now()` two frames inside
  the unit, and nothing in the test file's text says so. A behavioural check can, and the cost is
  one extra suite run per instant (~2 s each) with no new dependency.
  `test/fixtures/clock-shift.mjs` is
  loaded with `node --import` and replaces the global `Date` with a subclass whose only difference
  is that no-argument `new Date()` and `Date.now()` read the pinned clock; `new Date(instant)`,
  `Date.UTC` and `Date.parse` stay real, and a test that pins its own clock through
  `t.mock.timers` installs over the top of it and is unaffected.

  Two details are load-bearing and both are in the code with a comment saying so. The child must
  not inherit `NODE_TEST_CONTEXT`: node's test runner sets it to tell *its own* children that they
  are tests, and a child that inherits it exits immediately, prints nothing and reports success —
  a guard that passes without running anything. And `child.stdout` is asserted non-empty for the
  same reason, so a silent child fails loudly if that ever changes. Each run names its own `TZ`,
  because a clock hour is an hour of the *host's* zone and the guard has to know which zone it
  exercised.

  The four runs are `2026-09-30T02:58:30Z` in UTC (Wednesday 10:58 BJT: inside a peak window *and*
  two minutes short of a UTC hour — this one instant reproduces the first three defects),
  `2026-10-03T07:30:00Z` in `America/New_York` (Saturday afternoon, off-peak, mid-hour, a host zone
  west of UTC-7 where the host's own day is not the Beijing day, and — being past 2026-10-01 — a
  rolling day window that no longer holds the days an earlier suite wrote into it, which is the
  fourth and fifth defects on their own), `2026-01-01T00:00:00Z` in `America/Los_Angeles` (a year
  boundary, a public holiday, and the *older* rate table — the only shapes no instant after
  2026-09-10 can reach, and the third was added after this instant caught a live defect the first
  two could not see) and `2030-06-15T18:45:00Z` in `Asia/Kolkata` (a date past every rate table and
  holiday list the plugin ships, at a half-hour offset east of UTC, which is the offset
  `compactSamples` calls out as the one that straddles a day boundary). Four runs rather than a
  grid, because each one is a whole suite and these four between them cover both rate tables, a
  peak and an off-peak tariff, a weekday, a weekend and two public holidays, a minute inside and a
  minute outside an hour boundary, zones east and west of UTC including a half-hour one, and a year
  boundary.

  The runs are sequential, and that is not an oversight. Running them concurrently is faster and
  was measured: four at once put the suite's own `detection over ten thousand Steps stays inside
  the Host budget` case over its 150 ms limit (16 ms of work on an idle machine, 175 ms under four
  nested suites), which turned the guard into a load flake. A guard that manufactures a different
  flake is not a guard, so the parallelism was given up and the wall-clock budget case is left for
  the change that deals with the load-sensitive cases on their own terms.

  Rejected: freezing the clock for the suite (D — non-goal), a lint rule against `Date.now()` in
  `test/` (it cannot see the first defect and it would fire on every legitimate fixture), and a
  note in `CONTRIBUTING.md` alone (a note cannot fail, and this class of defect is invisible in
  review because the test reads as reasonable).

## Risks / Trade-offs

- **The suite now runs about four times as long, and `nix flake check` pays for it too** → the guard
  runs the suite four times rather than sweeping a grid, and the four runs are plain `spawnSync`
  calls with no parallelism (see D6 for why). The honest cheaper version is fewer instants, and
  dropping the pre-2026-09-10 one is the only cut that does not give back a shape nothing else
  covers — the rest were each checked against a defect the guard then caught.
- **The guard is itself a test that can flake** → it asserts an exit status, not output text, and
  a failing child prints its own failure, so a real regression is legible. The child runs the same
  suite the parent does, so anything that makes the suite flaky makes the guard flaky too — that
  is a true signal, not a false one, and the reason the guard runs its children one at a time.
- **A frozen clock is a real constraint, and one test could in principle depend on the wall clock
  moving** → the audit in `tasks.md` walked every `Date.now()` / `new Date()` / `mkdtemp` /
  `setTimeout` / `mock.timers` in the suite, and the pinned instants were chosen after that
  walk; the timing-sensitive cases all use real `setTimeout` and real `stat().mtimeMs`, which a
  pinned `Date` does not touch.
