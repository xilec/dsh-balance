/**
 * Pin or shift the clock a test process sees, for the suite's own clock guard.
 *
 * Loaded with `node --import`, before any other module: it replaces the global `Date`
 * with a subclass whose no-argument constructor and whose `now()` read a clock of the
 * test's own. Everything else — `new Date(instant)`, `Date.UTC`, `Date.parse` — is the
 * real one, so a test that pins its own clock through `t.mock.timers` is unaffected:
 * the mock installs over the top of this one.
 *
 * Two variables, read at load:
 *
 * - `DSH_BALANCE_CLOCK_NOW_MS`  freeze "now" at this epoch millisecond value. This is
 *   what the guard uses: a suite that passes at a pinned instant and fails at the
 *   ambient one is reading the clock in an assertion, which is the defect the guard
 *   exists to catch.
 * - `DSH_BALANCE_CLOCK_SHIFT_MS`  move "now" by this many milliseconds instead, keeping
 *   it running. Useful by hand when a single run is wanted at another hour of the day.
 *
 * A frozen clock is a real constraint on the suite — a test that waits for a wall-clock
 * window to open would hang — so the guard pins instants the suite does not depend on,
 * and both of them are stated in `test/clock-shift.test.js`.
 */
const RealDate = globalThis.Date
const frozenAt = process.env.DSH_BALANCE_CLOCK_NOW_MS
const offsetMs = frozenAt === undefined
  ? Number(process.env.DSH_BALANCE_CLOCK_SHIFT_MS ?? 0)
  : Number(frozenAt) - RealDate.now()

/** `Date` as the process under test must see it, with only "now" moved. */
class PinnedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offsetMs)
    else super(...args)
  }

  static now() {
    return RealDate.now() + offsetMs
  }
}

globalThis.Date = PinnedDate
