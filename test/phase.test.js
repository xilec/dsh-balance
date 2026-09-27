import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PHASE, RULE_SOURCE_URL, WARN_LEAD_MS,
  formatRemaining, nextChange, peakSchedule, phaseAt, peakIntervalsBetween, timeLabelInZone,
  transitionsBetween, windowsOfLocalDay,
} from '../src/pricing.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 2026-09-18 is a Friday; 19/20 the weekend; 21 a Monday. The Mid-Autumn window
 * (25-27 September) and National Day (1-7 October) sit outside these instants, so
 * the rule can be checked against the plain weekday/weekend case first.
 */
const at = (iso) => Date.parse(iso)

test('the rule is stated on the English page and warns half an hour ahead', () => {
  assert.match(RULE_SOURCE_URL, /deepseek\.com\/quick_start\/pricing$/)
  assert.equal(WARN_LEAD_MS, 30 * MINUTE)
})

test('phase around the first window of a weekday', () => {
  assert.equal(phaseAt(at('2026-09-18T00:29:00Z')).phase, PHASE.OFF_PEAK)
  assert.equal(phaseAt(at('2026-09-18T00:30:00Z')).phase, PHASE.SOON, 'the warning lead is inclusive')
  assert.equal(phaseAt(at('2026-09-18T00:59:59Z')).phase, PHASE.SOON)
  assert.equal(phaseAt(at('2026-09-18T01:00:00Z')).phase, PHASE.PEAK)
  assert.equal(phaseAt(at('2026-09-18T03:59:59Z')).phase, PHASE.PEAK)
  assert.equal(phaseAt(at('2026-09-18T04:00:00Z')).phase, PHASE.OFF_PEAK, 'the window end is exclusive')
})

test('phaseAt reports the window end while peaking, and the next start while not', () => {
  const peak = phaseAt(at('2026-09-18T02:00:00Z'))
  assert.equal(peak.untilMs, 2 * HOUR)
  assert.equal(peak.changeAtMs, at('2026-09-18T04:00:00Z'))
  assert.equal(peak.changeToPeak, false)
  assert.equal(peak.reason, 'peak')

  const off = phaseAt(at('2026-09-18T04:00:00Z'))
  assert.equal(off.untilMs, 2 * HOUR, 'the next peak is the same day at 06:00 UTC')
  assert.equal(off.changeToPeak, true)
  assert.equal(off.reason, 'off-peak')
})

test('the gap between the two windows is off-peak and warns before the second', () => {
  assert.equal(phaseAt(at('2026-09-18T05:29:59Z')).phase, PHASE.OFF_PEAK)
  assert.equal(phaseAt(at('2026-09-18T05:30:00Z')).phase, PHASE.SOON)
  assert.equal(phaseAt(at('2026-09-18T06:00:00Z')).phase, PHASE.PEAK)
})

test('the second window ends the week and Friday afternoon waits for Monday', () => {
  assert.equal(phaseAt(at('2026-09-18T09:59:59Z')).phase, PHASE.PEAK)
  const after = phaseAt(at('2026-09-18T10:00:00Z'))
  assert.equal(after.phase, PHASE.OFF_PEAK)
  assert.equal(after.nextPeakAtMs, at('2026-09-21T01:00:00Z'))
  assert.equal(after.untilMs, 2 * 24 * HOUR + 15 * HOUR)
  assert.equal(after.reason, 'off-peak')
})

test('weekends carry no peak window at all', () => {
  assert.equal(phaseAt(at('2026-09-19T01:00:00Z')).phase, PHASE.OFF_PEAK, 'Saturday 01:00 UTC would peak on a weekday')
  assert.equal(phaseAt(at('2026-09-19T06:00:00Z')).phase, PHASE.OFF_PEAK)
  assert.equal(phaseAt(at('2026-09-20T23:00:00Z')).phase, PHASE.OFF_PEAK)
  assert.equal(phaseAt(at('2026-09-19T02:00:00Z')).reason, 'weekend', 'Saturday midday Beijing time')
  assert.equal(phaseAt(at('2026-09-21T00:29:00Z')).phase, PHASE.OFF_PEAK, 'the weekend runs into the warning lead')
  assert.equal(phaseAt(at('2026-09-21T00:30:00Z')).phase, PHASE.SOON)
  assert.equal(phaseAt(at('2026-09-21T01:00:00Z')).phase, PHASE.PEAK)
})

test('a public holiday carries no peak window and reports why', () => {
  // 2026-10-01 is a Thursday inside the National Day window.
  assert.equal(phaseAt(at('2026-10-01T02:00:00Z')).peak, false)
  assert.equal(phaseAt(at('2026-10-01T02:00:00Z')).reason, 'holiday')
  assert.equal(phaseAt(at('2026-10-01T06:30:00Z')).phase, PHASE.OFF_PEAK, 'no warning lead either')
  assert.equal(phaseAt(at('2026-10-01T02:00:00Z')).nextPeakAtMs, at('2026-10-08T01:00:00Z'), 'the next window is after the holiday')
  assert.deepEqual(windowsOfLocalDay(at('2026-10-01T02:00:00Z'), undefined, 'UTC', 0), [])
})

test('a holiday list can be narrowed to re-open a peak window', () => {
  const noHolidays = []
  assert.equal(phaseAt(at('2026-10-01T02:00:00Z'), noHolidays).phase, PHASE.PEAK)
  assert.equal(phaseAt(at('2026-10-01T02:00:00Z'), noHolidays).reason, 'peak')
})

test('the transitions of a holiday week skip the holiday days', () => {
  const transitions = transitionsBetween(at('2026-09-30T12:00:00Z'), at('2026-10-09T00:00:00Z'))
  const starts = transitions.filter((transition) => transition.toPeak).map((transition) => new Date(transition.atMs).toISOString())
  // 30 September is a Wednesday whose windows are already past by 12:00 UTC, and the
  // National Day block (1-7 October) removes every window until 8 October.
  assert.deepEqual(starts, ['2026-10-08T01:00:00.000Z', '2026-10-08T06:00:00.000Z'])
  assert.equal(transitions.every((transition, index, all) => index === 0 || all[index - 1].atMs <= transition.atMs), true)
})

test('peakSchedule is bounded and ordered for the chip countdown', () => {
  const schedule = peakSchedule(at('2026-09-18T10:00:00Z'), undefined, 4, 4)
  assert.deepEqual(schedule.map((entry) => entry.toPeak), [true, false, true, false])
  assert.equal(schedule[0].atMs, at('2026-09-21T01:00:00Z'))
  assert.equal(schedule.length, 4)
  assert.equal(peakSchedule(at('2026-09-18T10:00:00Z'), undefined, 4, 0).length > 4, true, 'no limit means every transition in range')
})

test('nextChange keeps its shape for callers that only need the instant', () => {
  const change = nextChange(at('2026-09-18T10:00:00Z'))
  assert.deepEqual(change, {
    atMs: at('2026-09-21T01:00:00Z'),
    toPeak: true,
    reason: 'peak',
    inMs: 2 * 24 * HOUR + 15 * HOUR,
  })
})

test('peakIntervalsBetween clips to the range and never spans a weekend', () => {
  const intervals = peakIntervalsBetween(at('2026-09-18T00:00:00Z'), at('2026-09-22T00:00:00Z'))
  assert.deepEqual(intervals.map((interval) => [new Date(interval.startMs).toISOString(), new Date(interval.endMs).toISOString()]), [
    ['2026-09-18T01:00:00.000Z', '2026-09-18T04:00:00.000Z'],
    ['2026-09-18T06:00:00.000Z', '2026-09-18T10:00:00.000Z'],
    ['2026-09-21T01:00:00.000Z', '2026-09-21T04:00:00.000Z'],
    ['2026-09-21T06:00:00.000Z', '2026-09-21T10:00:00.000Z'],
  ])
  const clipped = peakIntervalsBetween(at('2026-09-18T02:00:00Z'), at('2026-09-18T03:00:00Z'))
  assert.deepEqual(clipped, [{ startMs: at('2026-09-18T01:00:00Z'), endMs: at('2026-09-18T04:00:00Z') }])
})

test('formatRemaining walks seconds, minutes, hours and days', () => {
  assert.equal(formatRemaining(0), '0s')
  assert.equal(formatRemaining(999), '0s')
  assert.equal(formatRemaining(45_000), '45s')
  assert.equal(formatRemaining(MINUTE), '1m')
  assert.equal(formatRemaining(12 * MINUTE + 30_000), '12m 30s')
  assert.equal(formatRemaining(45 * MINUTE + 12_000), '45m 12s')
  assert.equal(formatRemaining(HOUR), '1h')
  assert.equal(formatRemaining(HOUR + MINUTE), '1h 1m')
  assert.equal(formatRemaining(2 * 24 * HOUR + 15 * HOUR), '2d 15h')
  assert.equal(formatRemaining(25 * HOUR), '1d 1h')
  assert.equal(formatRemaining(-5000), '0s', 'a negative wait never renders as negative')
})

test('local windows convert the Beijing windows into the display zone', () => {
  const friday = at('2026-09-18T06:54:00Z')
  assert.deepEqual(windowsOfLocalDay(friday, undefined, 'Europe/Moscow', 0), ['04:00–07:00', '09:00–13:00'])
  assert.deepEqual(windowsOfLocalDay(friday, undefined, 'Europe/Moscow', 1), [], 'Saturday has no window')
  assert.deepEqual(windowsOfLocalDay(friday, undefined, 'UTC', 0), ['01:00–04:00', '06:00–10:00'])
  assert.deepEqual(windowsOfLocalDay(friday, undefined, 'Asia/Tokyo', 0), ['10:00–13:00', '15:00–19:00'])
  assert.deepEqual(
    windowsOfLocalDay(friday, undefined, 'America/Los_Angeles', 0),
    ['18:00–21:00', '23:00–03:00'],
    'a window may cross local midnight',
  )
  assert.deepEqual(windowsOfLocalDay(friday, undefined, 'local', 0).length, 2, 'the host zone still yields both windows')
})

test('local windows follow the zone across a daylight-saving change', () => {
  // US DST ends on 2026-11-01. The same Beijing window labels an hour earlier after
  // the switch, because the labels come from the window's own absolute instants.
  const before = at('2026-10-30T12:00:00Z') // Friday, still on daylight time
  assert.deepEqual(windowsOfLocalDay(before, undefined, 'America/New_York', 0), ['02:00–06:00'])
  const after = at('2026-11-06T12:00:00Z') // Friday, back on standard time
  assert.deepEqual(windowsOfLocalDay(after, undefined, 'America/New_York', 0), ['01:00–05:00'])
  // Zones east of Beijing reach a window a day earlier than UTC does.
  assert.deepEqual(windowsOfLocalDay(at('2026-09-17T22:00:00Z'), undefined, 'Asia/Tokyo', 0), ['10:00–13:00', '15:00–19:00'])
})

test('a time label falls back to UTC for an unknown zone', () => {
  const instant = at('2026-09-18T06:54:00Z')
  assert.equal(timeLabelInZone(instant, 'Europe/Moscow'), '09:54')
  assert.equal(timeLabelInZone(instant, 'UTC'), '06:54')
  assert.equal(timeLabelInZone(instant, 'Not/AZone'), '06:54')
})
