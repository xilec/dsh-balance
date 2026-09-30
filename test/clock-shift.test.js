import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The suite must pass whatever the wall clock says.
 *
 * Five cases made it otherwise, and none of them was a bug in the plugin: assertions read fields
 * priced at *now* (`peakNow`, `prices.current`, and `prices.peak` behind an effective-dated rate
 * table), a fixture anchored at `now` landed across a clock-hour boundary the log thinning buckets
 * on, a case counted the host's trading windows, and a case wrote a calendar day into a rolling
 * window. All five pass at some instants and fail at others, which is the worst way for a test to
 * be wrong — the suite goes red on a colleague's machine and green on yours.
 *
 * The rule the suite now follows: a test may build a fixture relative to now, but its
 * assertions may not depend on where now sits, and a test that genuinely needs "now"
 * pins it (`t.mock.timers` with `apis: ['Date']`) instead of inheriting it.
 *
 * A note cannot hold that rule, so this test does: it re-runs the whole suite with the
 * clock pinned to instants chosen to be hostile in the ways the defects were, and fails on
 * any difference. The instants run one at a time, deliberately: run concurrently they
 * oversubscribe the machine, and the suite has a case with a wall-clock budget by design
 * (`detection over ten thousand Steps stays inside the Host budget`) that a loaded CPU
 * turns red. A guard that makes a different flake is not a guard. It is the only test here
 * that runs other tests.
 */
const here = dirname(fileURLToPath(import.meta.url))
const shim = join(here, 'fixtures', 'clock-shift.mjs')
/** Every suite file but this one: the child must not run the guard again. */
const suite = readdirSync(here)
  .filter((name) => name.endsWith('.test.js') && name !== 'clock-shift.test.js')
  .map((name) => join(here, name))

/**
 * The clocks the suite is re-run under, each with what it is here to catch.
 *
 * A set of instants only guards the shapes it contains, so these are chosen to cover the
 * shapes the suite actually has rather than to multiply near-duplicates: a peak window and
 * an off-peak one, a weekday and a weekend, a plain day and two public-holiday ones, both
 * rate tables, a clock-hour boundary and a mid-hour instant, zones east and west of UTC
 * including a half-hour one, a year boundary, and a date years past the table's own.
 *
 * `2026-09-30T02:58:30Z` in UTC is a Wednesday at 10:58 Beijing time: inside the morning
 * peak window, so every "off-peak" assertion is wrong, and two minutes short of a UTC hour,
 * so an hour-anchored fixture is split across a thinning bucket. That one instant
 * reproduces the first three defects. `2026-10-03T07:30:00Z` in New York is a Saturday
 * afternoon, a different weekday, an off-peak tariff, a mid-hour instant, a zone west of
 * UTC where the host's own day is not the Beijing day, and — being past 2026-10-01 — a
 * rolling day window that no longer holds the days an earlier suite wrote into it, which is
 * the day-key defect on its own. The third and
 * fourth are there for what the first two cannot see: a calendar year boundary, a public
 * holiday, and the *older* rate table, which no instant after 2026-09-10 can reach; then a
 * date years past every table and holiday list the plugin ships, at a half-hour offset east
 * of UTC.
 */
const CLOCKS = [
  { at: '2026-09-30T02:58:30Z', zone: 'UTC', catches: 'a peak window and an hour boundary at once' },
  { at: '2026-10-03T07:30:00Z', zone: 'America/New_York', catches: 'a weekend, a public holiday, an off-peak tariff, a mid-hour instant, a zone west of UTC and a day past a written-out day key' },
  { at: '2026-01-01T00:00:00Z', zone: 'America/Los_Angeles', catches: 'a year boundary and the rate table in force before the 2026-09-10 cut' },
  { at: '2030-06-15T18:45:00Z', zone: 'Asia/Kolkata', catches: 'a date past every shipped rate table and holiday list, at a half-hour offset east of UTC' },
]

test('the suite is green with the clock pinned', { timeout: 300_000 }, () => {
  // `NODE_TEST_CONTEXT` is how a node --test process tells its own children that they are
  // test files. Inherited here it makes the child exit at once, printing nothing and
  // reporting success: a guard that passes without running anything. The variable is
  // dropped, and `child.stdout` is checked to be non-empty below for the same reason.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  for (const { at, zone, catches } of CLOCKS) {
    const child = spawnSync(
      process.execPath,
      ['--import', shim, '--test', ...suite],
      {
        cwd: join(here, '..'),
        encoding: 'utf8',
        // The zone is named rather than inherited: a clock hour is an hour of the *host's*
        // zone, so the guard has to know which one it is exercising.
        env: { ...env, TZ: zone, DSH_BALANCE_CLOCK_NOW_MS: String(Date.parse(at)) },
      },
    )
    assert.notEqual(child.stdout.trim(), '', `the child has to have run the suite, at ${at}`)
    assert.equal(
      child.status,
      0,
      `the suite with the clock pinned to ${at} in ${zone} (${catches}) has to pass as well:\n${child.stdout}${child.stderr}`,
    )
  }
})
