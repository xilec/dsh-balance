import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The suite must pass whatever the wall clock says.
 *
 * Three defects made it otherwise, and none of them was a bug in the plugin: an
 * assertion read a field priced at *now* (`peakNow`, `prices.current`), and a fixture
 * anchored at `now` landed across a clock-hour boundary the log thinning buckets on. All
 * three pass at some hours of the day and fail at others, which is the worst way for a
 * test to be wrong — the suite goes red on a colleague's machine and green on yours.
 *
 * The rule the suite now follows: a test may build a fixture relative to now, but its
 * assertions may not depend on where now sits, and a test that genuinely needs "now"
 * pins it (`t.mock.timers` with `apis: ['Date']`) instead of inheriting it.
 *
 * A note cannot hold that rule, so this test does: it re-runs the whole suite with the
 * clock pinned to instants chosen to be hostile in the ways the defects were, and fails
 * on any difference. It costs two extra suite runs, and it is the only test here that
 * runs other tests.
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
 * `2026-09-30T02:58:30Z` in UTC is a Wednesday at 10:58 Beijing time: inside the morning
 * peak window, so every "off-peak" assertion is wrong, and two minutes short of a UTC hour,
 * so an hour-anchored fixture is split across a thinning bucket. That one instant
 * reproduces the first three defects. The second is a Saturday afternoon run in a zone west
 * of UTC-7, where the host's own day is not the Beijing day — a different weekday, an
 * off-peak tariff, a mid-hour instant and a different host zone in one run, so the suite is
 * not only ever checked at one shape of day.
 */
const CLOCKS = [
  { at: '2026-09-30T02:58:30Z', zone: 'UTC', catches: 'a peak window and an hour boundary at once' },
  { at: '2026-10-03T07:30:00Z', zone: 'America/New_York', catches: 'a weekend, an off-peak tariff, a mid-hour instant and a zone west of UTC' },
]

test('the suite is green with the clock pinned', { timeout: 300_000 }, () => {
  for (const { at, zone, catches } of CLOCKS) {
    // `NODE_TEST_CONTEXT` is how a node --test process tells its own children that they
    // are test files. Inherited here it makes the child exit at once, printing nothing and
    // reporting success: a guard that passes without running anything. The variable is
    // dropped, and `child.stdout` is checked to be non-empty below for the same reason.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env
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
