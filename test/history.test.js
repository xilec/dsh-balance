import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLedger, calibrationOf, compactSamples, dayKeyOf, daySpan, medianGapMs, monthStartKey,
  movements, parseSamples, recentDayKeys, serializeSamples, weekStartKey,
} from '../src/history.js'

const at = (iso) => Date.parse(iso)
const sample = (iso, total, currency = 'CNY') => ({ t: at(iso), total, currency })

test('a falling balance is spend, a rising one is a credit', () => {
  const series = [
    sample('2026-09-24T00:00:00Z', 10),
    sample('2026-09-24T06:00:00Z', 8.5),
    sample('2026-09-24T12:00:00Z', 58.5),
  ]
  const { intervals, credits } = movements(series)
  assert.equal(intervals[0].spend, 1.5)
  assert.equal(intervals[1].spend, 0)
  assert.equal(credits.length, 1)
  assert.equal(credits[0].amount, 50)
})

test('rounding noise below the credit floor is not a top-up', () => {
  const { credits } = movements([sample('2026-09-24T00:00:00Z', 10.00), sample('2026-09-24T01:00:00Z', 10.01)])
  assert.equal(credits.length, 0)
})

test('spend is attributed to the day of the later sample', () => {
  const ledger = buildLedger({
    samples: [
      sample('2026-09-23T20:00:00Z', 10),
      sample('2026-09-23T22:00:00Z', 7),
      sample('2026-09-24T02:00:00Z', 6),
    ],
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 3,
  })
  assert.deepEqual(ledger.rows.map((r) => [r.key, r.spend]), [
    ['2026-09-22', 0],
    ['2026-09-23', 3],
    ['2026-09-24', 1],
  ])
  assert.equal(ledger.rows[2].open, true)
})

test('an interval spanning days is marked coarse', () => {
  const ledger = buildLedger({
    samples: [sample('2026-09-22T08:00:00Z', 10), sample('2026-09-24T08:00:00Z', 4)],
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 3,
  })
  assert.equal(ledger.rows[2].spend, 6)
  assert.equal(ledger.rows[2].coarse, true)
})

test('a manual override replaces the sampled value for its day', () => {
  const ledger = buildLedger({
    samples: [sample('2026-09-23T20:00:00Z', 10), sample('2026-09-23T22:00:00Z', 7)],
    overrides: { '2026-09-23': 2.5 },
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 2,
  })
  const row = ledger.rows.find((r) => r.key === '2026-09-23')
  assert.equal(row.spend, 2.5)
  assert.equal(row.computed, 3)
  assert.equal(row.override, 2.5)
})

test('a manual base keeps filling from the balance it was anchored to', () => {
  const samples = [
    sample('2026-09-24T08:00:00Z', 10),
    sample('2026-09-24T09:00:00Z', 9.6),
    sample('2026-09-24T10:00:00Z', 9.1),
    sample('2026-09-24T11:00:00Z', 8.9),
  ]
  // The user corrects the day at 09:30 with the balance they saw (9.5) and a base of
  // 1.25: what counts is the drop from that anchor to the newest sample.
  const ledger = buildLedger({
    samples,
    overrides: { '2026-09-24': { amount: 1.25, at: at('2026-09-24T09:30:00Z'), balance: 9.5 } },
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 1,
  })
  const row = ledger.rows[0]
  assert.equal(row.override, 1.25)
  assert.equal(row.measuredAfter, 0.6, '9.5 − 8.9, one subtraction')
  assert.equal(row.spend, 1.85)
  assert.equal(row.computed, 1.1, 'the sampled value is still reported as it stands')
  assert.equal(ledger.totals.d1.amount, 1.85, 'the day total carries the corrected value')
})

test('a top-up after the correction does not eat into the corrected day', () => {
  const samples = [
    sample('2026-09-24T08:00:00Z', 10),
    sample('2026-09-24T10:00:00Z', 9),   // 1.0 spent
    sample('2026-09-24T11:00:00Z', 59),  // 50 topped up
    sample('2026-09-24T12:00:00Z', 58.8), // 0.2 spent
  ]
  const ledger = buildLedger({
    samples,
    overrides: { '2026-09-24': { amount: 2, at: at('2026-09-24T09:00:00Z'), balance: 9.5 } },
    zone: 'UTC',
    nowMs: at('2026-09-24T13:00:00Z'),
    days: 1,
  })
  // drop = 9.5 − 58.8 = −49.3, credits since = 50 → 0.7 added to the base.
  assert.equal(ledger.rows[0].measuredAfter, 0.7)
  assert.equal(ledger.rows[0].spend, 2.7)
})

test('a correction made after the day closed leaves the base alone', () => {
  const ledger = buildLedger({
    samples: [sample('2026-09-24T08:00:00Z', 10), sample('2026-09-24T09:00:00Z', 9)],
    // Edited the next morning: the balance of that moment says nothing about the day.
    overrides: { '2026-09-24': { amount: 3, at: at('2026-09-25T08:00:00Z'), balance: 7 } },
    zone: 'UTC',
    nowMs: at('2026-09-25T09:00:00Z'),
    days: 2,
  })
  assert.equal(ledger.rows.find((row) => row.key === '2026-09-24').spend, 3)
  assert.equal(ledger.rows.find((row) => row.key === '2026-09-24').measuredAfter, 0)
})

test('an anchor is measured only from inside the day it corrects', () => {
  // All four positions of an anchor against the day's own span of samples, which is the rule the
  // arithmetic turns on: the added part is the drop from the anchor to that day's newest sample,
  // so it measures one day only while both of its ends are on that day. The day's samples run
  // 08:00 at a balance of 10 and 09:00 at 9, so the sampled value of the day is 1.
  const samples = [sample('2026-09-24T08:00:00Z', 10), sample('2026-09-24T09:00:00Z', 9)]
  const measured = (anchor, balance) => buildLedger({
    samples,
    overrides: { '2026-09-24': { amount: 3, at: anchor, balance } },
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 1,
  }).rows[0]
  const inside = measured(at('2026-09-24T08:30:00Z'), 9.5)
  assert.equal(inside.measuredAfter, 0.5, 'an anchor between two samples of the day measures the drop from there')
  assert.equal(inside.spend, 3.5)
  // The anchor *is* that sample's own reading, so the drop is zero and no credit can be later:
  // the base is the reader's final word for the day.
  const exact = measured(at('2026-09-24T09:00:00Z'), 9)
  assert.equal(exact.measuredAfter, 0)
  assert.equal(exact.spend, 3)
  // Past the last sample there is nothing left to measure — and subtracting a balance read *after*
  // the day's end from the day's own last reading would add money to a figure that is final, so
  // refusing to add is the only answer that cannot move the number the wrong way.
  const after = measured(at('2026-09-24T23:50:00Z'), 1)
  assert.equal(after.measuredAfter, 0, 'a correction made after the day closed adds nothing')
  assert.equal(after.spend, 3)
  // Before the day's first sample the window reaches over midnight, so the 9.5 it is anchored to
  // is a balance of the *previous* day and the drop it would add (0.5) is that day's spend.
  const before = measured(at('2026-09-23T23:50:00Z'), 9.5)
  assert.equal(before.measuredAfter, 0, 'the window would start on another day, so nothing is added')
  assert.equal(before.spend, 3, "and the base is the reader's own figure")
  assert.equal(before.computed, 1, 'while the sampled value is still reported as it stands')
})

test('a bare override from an older state file stays frozen', () => {
  const ledger = buildLedger({
    samples: [sample('2026-09-24T08:00:00Z', 10), sample('2026-09-24T10:00:00Z', 9)],
    overrides: { '2026-09-24': 1.25 },
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 1,
  })
  assert.equal(ledger.rows[0].spend, 1.25)
  assert.equal(ledger.rows[0].measuredAfter, 0)
})

test('an override without an anchor stays frozen too', () => {
  const ledger = buildLedger({
    samples: [sample('2026-09-24T08:00:00Z', 10), sample('2026-09-24T10:00:00Z', 9)],
    overrides: { '2026-09-24': { amount: 1.25, at: at('2026-09-24T09:00:00Z') } },
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 1,
  })
  assert.equal(ledger.rows[0].spend, 1.25)
  assert.equal(ledger.rows[0].measuredAfter, 0)
})

test('an override on another day does not leak into this one', () => {
  const ledger = buildLedger({
    samples: [
      sample('2026-09-23T20:00:00Z', 10),
      sample('2026-09-24T08:00:00Z', 9),
      sample('2026-09-24T12:00:00Z', 8),
    ],
    overrides: { '2026-09-24': { amount: 0.5, at: at('2026-09-24T10:00:00Z'), balance: 8.5 } },
    zone: 'UTC',
    nowMs: at('2026-09-24T13:00:00Z'),
    days: 2,
  })
  assert.equal(ledger.rows[1].spend, 1, '0.5 base + the 0.5 drop from the anchor to the last sample')
  // The interval that closed at 08:00 straddles midnight and belongs to the later
  // day (which is why that row is marked coarse), so the earlier day stays empty.
  assert.equal(ledger.rows[0].spend, 0)
  assert.equal(ledger.rows[1].coarse, true)
})

test('window totals follow the day rows, and coverage reports partial history', () => {
  const ledger = buildLedger({
    samples: [
      sample('2026-09-20T00:00:00Z', 100),
      sample('2026-09-21T00:00:00Z', 99),
      sample('2026-09-22T00:00:00Z', 97),
      sample('2026-09-24T00:00:00Z', 95),
    ],
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 30,
  })
  assert.equal(ledger.totals.d1.amount, 2)
  // Thursday: the week runs from the Monday, the month from the 1st.
  assert.deepEqual(ledger.totals.w1, { amount: 5, covered: true, days: 4, measured: 4 })
  assert.deepEqual(ledger.totals.m1, { amount: 5, covered: false, days: 24, measured: 5 })
  assert.equal(ledger.rows.length, 30)
})

/** The samples of the window tests: 0.5 spent a day, `span` days back from `nowMs`. */
const dailySamples = (nowMs, span) => Array.from({ length: span + 1 }, (_, i) => ({
  t: nowMs - (span - i) * 86_400_000,
  total: 100 - i * 0.5,
  currency: 'CNY',
}))

/**
 * An instant whose calendar day in `zone` is `dayKey`, at noon local.
 *
 * Fixtures are built from a day rather than from an instant, so the same calendar day can be
 * handed to a zone whose offset is a whole number of hours, a fractional one, or neither
 * because its clocks just moved — without the test choosing a different weekday for each.
 */
const noonIn = (dayKey, zone) => {
  const noonUtc = Date.parse(`${dayKey}T12:00:00Z`)
  for (let hours = -14; hours <= 14; hours += 1) {
    const candidate = noonUtc + hours * 3_600_000
    if (dayKeyOf(candidate, zone) === dayKey) return candidate
  }
  throw new Error(`no local noon for ${dayKey} in ${zone}`)
}

test('a window starts on the Monday of its week and on the 1st of its month', () => {
  // [today, the Monday of its week, the days of that week, the 1st, the days of that month]
  const anchors = [
    ['2026-09-21', '2026-09-21', 1, '2026-09-01', 21], // a Monday is a one-day week
    ['2026-09-22', '2026-09-21', 2, '2026-09-01', 22],
    ['2026-09-23', '2026-09-21', 3, '2026-09-01', 23], // a Wednesday
    ['2026-09-24', '2026-09-21', 4, '2026-09-01', 24],
    ['2026-09-27', '2026-09-21', 7, '2026-09-01', 27], // a Sunday ends the ISO week
    ['2026-09-28', '2026-09-28', 1, '2026-09-01', 28], // and the next Monday starts a new one
    ['2026-10-01', '2026-09-28', 4, '2026-10-01', 1], // the 1st of a month
    ['2026-10-31', '2026-10-26', 6, '2026-10-01', 31], // a 31-day month, whole
    ['2026-11-01', '2026-10-26', 7, '2026-11-01', 1], // a Sunday that is also the 1st
    ['2026-02-28', '2026-02-23', 6, '2026-02-01', 28], // February outside a leap year
    ['2024-02-29', '2024-02-26', 4, '2024-02-01', 29], // February in one
    ['2026-12-31', '2026-12-28', 4, '2026-12-01', 31], // the year boundary, before
    ['2027-01-01', '2026-12-28', 5, '2027-01-01', 1], // and after: a January week started in December
  ]
  for (const [today, week, weekDays, month, monthDays] of anchors) {
    assert.equal(weekStartKey(today), week, `${today}: the week starts on its Monday`)
    assert.equal(daySpan(weekStartKey(today), today), weekDays, `${today}: the length of that week`)
    assert.equal(monthStartKey(today), month, `${today}: the month starts on its 1st`)
    assert.equal(daySpan(monthStartKey(today), today), monthDays, `${today}: the length of that month`)
  }
})

test('the windows are the ledger zone calendar, whatever its offset and its clocks', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    for (const [day, weekDays, monthDays] of [
      ['2026-09-21', 1, 21], ['2026-09-23', 3, 23], ['2026-10-01', 4, 1], ['2026-10-31', 6, 31],
      ['2026-11-01', 7, 1], ['2024-02-29', 4, 29], ['2027-01-01', 5, 1],
    ]) {
      // No samples: the lengths are the calendar's, and nothing is measured or covered.
      const { totals, todayKey } = buildLedger({ samples: [], zone, nowMs: noonIn(day, zone), days: 30 })
      assert.equal(todayKey, day, `${zone} ${day}: the ledger's own today`)
      assert.deepEqual(totals.d1, { amount: 0, covered: false, days: 1, measured: 0 }, `${zone} ${day}`)
      assert.deepEqual(totals.w1, { amount: 0, covered: false, days: weekDays, measured: 0 }, `${zone} ${day}`)
      assert.deepEqual(totals.m1, { amount: 0, covered: false, days: monthDays, measured: 0 }, `${zone} ${day}`)
    }
  }
})

test('a week that spans a daylight-saving change still has one key per day', () => {
  // America/Los_Angeles leaves DST on 2026-11-01, the last day of that ISO week, and
  // Europe/Berlin leaves it a week earlier. A day is a day either way: the window is a range of
  // day keys, so the shorter one is a fact about the clock and not about the spend.
  for (const [zone, day, monthDays] of [
    ['America/Los_Angeles', '2026-11-01', 1], // the clocks go back, and November is a day old
    ['Europe/Berlin', '2026-10-25', 25],
  ]) {
    const keys = recentDayKeys(day, 12)
    const samples = keys.map((key, i) => ({ t: noonIn(key, zone), total: 100 - i * 0.5, currency: 'CNY' }))
    const { totals, rows } = buildLedger({ samples, zone, nowMs: noonIn(day, zone), days: 30 })
    const week = rows.filter((row) => row.key >= weekStartKey(day))
    assert.deepEqual(week.map((row) => row.key), recentDayKeys(day, 7), `${zone}: the week is seven day keys`)
    assert.equal(totals.w1.days, 7, zone)
    assert.equal(totals.w1.amount, 3.5, `${zone}: 0.5 a day over the seven days of that week`)
    assert.equal(totals.w1.covered, true, zone)
    // The month is its own length; the samples only reach as far back as this fixture goes, and
    // the amount is the rows inside the month however few of them carry spend.
    const month = rows.filter((row) => row.key >= monthStartKey(day))
    const measured = Math.min(monthDays, keys.length)
    assert.equal(totals.m1.days, monthDays, zone)
    assert.equal(totals.m1.measured, measured, zone)
    assert.equal(totals.m1.amount, month.reduce((acc, row) => acc + row.spend, 0), zone)
    assert.equal(totals.m1.covered, measured === monthDays, zone)
  }
})

test('a ledger shorter than a window sums what it has and names the shortfall', () => {
  const nowMs = at('2026-09-24T12:00:00Z')
  const samples = dailySamples(nowMs, 45)
  const totalsAt = (days, zone = 'UTC') => buildLedger({ samples, zone, nowMs, days }).totals

  // Thursday: the week is four days and the month 24, and `historyDays: 3` reaches back to
  // Tuesday — a week the ledger cannot have covered, and a month it barely holds.
  for (const zone of ['UTC', 'Europe/Berlin', 'Asia/Kolkata']) {
    const short = totalsAt(3, zone)
    assert.deepEqual(short.d1, { amount: 0.5, covered: true, days: 1, measured: 1 }, zone)
    assert.deepEqual(short.w1, { amount: 1.5, covered: false, days: 4, measured: 3 }, zone)
    assert.deepEqual(short.m1, { amount: 1.5, covered: false, days: 24, measured: 3 }, zone)
  }

  // On a Wednesday the week is three days, so the same three rows do cover it: a short window
  // that is short only by the calendar is not a shortfall and must not be flagged as one.
  const wednesday = buildLedger({ samples, zone: 'UTC', nowMs: at('2026-09-23T12:00:00Z'), days: 3 }).totals
  assert.deepEqual(wednesday.w1, { amount: 1.5, covered: true, days: 3, measured: 3 })
  assert.deepEqual(wednesday.m1, { amount: 1.5, covered: false, days: 23, measured: 3 })

  // Four rows reach back to Monday, and the month is then whole.
  const four = totalsAt(4)
  assert.deepEqual(four.w1, { amount: 2, covered: true, days: 4, measured: 4 })
  assert.deepEqual(four.m1, { amount: 2, covered: false, days: 24, measured: 4 })
})

test('the day rows are the ones the rolling windows summed, and a window sums the rows inside it', () => {
  const nowMs = at('2026-09-24T12:00:00Z')
  // 45 days of history and one day the reader corrected by hand, so the sums are over the rows'
  // own values rather than over the raw deltas.
  const samples = dailySamples(nowMs, 45)
  const overrides = { '2026-09-10': 3.25 }

  // What `main` answered for these inputs before the windows moved: 0.5 a day with 3.25 on the
  // corrected day, and 17.75 over 30 rows. The rows are a property of the samples, not of the
  // windows, so this is the check that the money arithmetic did not move.
  for (const zone of ['UTC', 'Europe/Berlin', 'Asia/Kolkata']) {
    const { rows, todayKey } = buildLedger({ samples, overrides, zone, nowMs, days: 30 })
    assert.equal(todayKey, '2026-09-24', zone)
    assert.equal(rows[0].key, '2026-08-26', zone)
    assert.deepEqual(
      rows.filter((row) => row.spend !== 0.5).map((row) => [row.key, row.spend]),
      [['2026-09-10', 3.25]],
      `${zone}: the corrected day is the only row that is not half a unit`,
    )
    assert.equal(rows.reduce((acc, row) => acc + row.spend, 0), 17.75, `${zone}: the 30 rows of that ledger`)
  }

  // Each window is the sum of the rows whose key falls inside it, whichever way the range is
  // worked out: the assertion below rebuilds the sum from the keys, the ledger from the length.
  const inWindow = (ledger, startKey) => ledger.rows
    .filter((row) => row.key >= startKey)
    .reduce((acc, row) => acc + row.spend, 0)
  for (const days of [3, 4, 24, 30, 400]) {
    const ledger = buildLedger({ samples, overrides, zone: 'UTC', nowMs, days })
    assert.equal(ledger.totals.w1.amount, inWindow(ledger, '2026-09-21'), `historyDays ${days}: the week`)
    assert.equal(ledger.totals.m1.amount, inWindow(ledger, '2026-09-01'), `historyDays ${days}: the month`)
  }

  // The worked figures on Thursday 2026-09-24 with a ledger that reaches back 45 days: a
  // four-day week and a 24-day month, against the rolling 7 and 30 the same rows used to give.
  const { totals } = buildLedger({ samples, overrides, zone: 'UTC', nowMs, days: 400 })
  assert.deepEqual(totals.d1, { amount: 0.5, covered: true, days: 1, measured: 1 })
  assert.deepEqual(totals.w1, { amount: 2, covered: true, days: 4, measured: 4 })
  assert.deepEqual(totals.m1, { amount: 14.75, covered: true, days: 24, measured: 24 })
  // A rolling seven days would have added 2026-09-18..20 and a rolling thirty would have
  // reached back into August, so the calendar week is 1.5 smaller than the rolling one and the
  // calendar month 3.0.
  const ledger = buildLedger({ samples, overrides, zone: 'UTC', nowMs, days: 400 })
  assert.equal(inWindow(ledger, '2026-09-18'), 3.5, 'a rolling week: seven days of half a unit')
  assert.equal(ledger.totals.w1.amount, 2, 'the calendar week is the four of them that are this week')
  assert.equal(ledger.totals.m1.amount, 14.75)
  assert.equal(inWindow(ledger, '2026-08-26'), 17.75, 'a rolling month: thirty rows, four of them in August')
})

test('a rolling month used to reach past the 1st of a 31-day month, and does not now', () => {
  const nowMs = at('2026-10-31T12:00:00Z')
  const samples = dailySamples(nowMs, 45)
  const { totals } = buildLedger({ samples, zone: 'UTC', nowMs, days: 400 })
  // The calendar month is the whole of October: 31 days, 15.5 spent over them.
  assert.deepEqual(totals.m1, { amount: 15.5, covered: true, days: 31, measured: 31 })
  // A rolling thirty days on that date started on the 2nd, so it dropped 2026-10-01 and, being
  // one day shorter, could not have carried the whole month however many rows it held.
  const first = buildLedger({ samples, zone: 'UTC', nowMs, days: 400 }).rows.find((row) => row.key === '2026-10-01')
  assert.equal(first.spend, 0.5, 'the day a rolling 30-day window left out on the 31st')
  assert.equal(totals.m1.amount, 15.5, 'and the calendar month keeps it')
})


test('credits are listed newest first with a total', () => {
  const ledger = buildLedger({
    samples: [
      sample('2026-09-23T00:00:00Z', 5),
      sample('2026-09-23T06:00:00Z', 25),
      sample('2026-09-23T12:00:00Z', 20),
      sample('2026-09-24T00:00:00Z', 60),
    ],
    zone: 'UTC',
    nowMs: at('2026-09-24T12:00:00Z'),
    days: 2,
  })
  assert.deepEqual(ledger.credits.map((c) => c.amount), [40, 20])
  assert.equal(ledger.creditTotal, 60)
  assert.equal(ledger.totals.d1.amount, 0)
})

test('only the requested currency is folded', () => {
  const ledger = buildLedger({
    samples: [
      sample('2026-09-23T00:00:00Z', 10, 'CNY'),
      sample('2026-09-23T06:00:00Z', 9, 'CNY'),
      sample('2026-09-23T06:00:00Z', 4, 'USD'),
      sample('2026-09-23T12:00:00Z', 3, 'USD'),
    ],
    currency: 'USD',
    zone: 'UTC',
    nowMs: at('2026-09-23T20:00:00Z'),
    days: 1,
  })
  assert.equal(ledger.totals.d1.amount, 1)
  assert.equal(ledger.sampleCount, 2)
})

test('day keys roll back across a month boundary', () => {
  assert.deepEqual(recentDayKeys('2026-03-02', 3), ['2026-02-28', '2026-03-01', '2026-03-02'])
})

test('day boundaries can follow a named zone', () => {
  // 2026-09-23T22:30Z is already 2026-09-24 in Beijing.
  assert.equal(dayKeyOf(at('2026-09-23T22:30:00Z'), 'Asia/Shanghai'), '2026-09-24')
  assert.equal(dayKeyOf(at('2026-09-23T22:30:00Z'), 'UTC'), '2026-09-23')
})

test('a calendar lookup hands back the one field its caller reads', () => {
  // The ledger asks a million times for a day and the retention pass for a day and an hour, so
  // the lookup is split per caller rather than answering with a pair each of them has to take
  // apart: what a caller gets is a bare `YYYY-MM-DD`, with no hour or minute field hanging off
  // it for a caller that never wanted one.
  const instant = at('2026-09-23T22:30:00Z')
  for (const zone of ['UTC', 'Asia/Kolkata', 'local', undefined]) {
    const key = dayKeyOf(instant, zone)
    assert.equal(typeof key, 'string', `${zone} answers with a string`)
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/, `${zone} answers with a bare day key`)
  }
  assert.equal(dayKeyOf(instant, 'local'), dayKeyOf(instant, undefined), 'no zone is the host\'s own')
  assert.equal(dayKeyOf(instant, 'local'), dayKeyOf(instant, 'Nowhere/Special'), 'and so is a zone the runtime cannot use')
})

test('the median sampling gap reports the cadence actually achieved', () => {
  assert.equal(medianGapMs([{ t: 0 }, { t: 100 }, { t: 200 }, { t: 1000 }]), 100)
})

test('samples survive a torn trailing line', () => {
  const text = `${JSON.stringify({ t: 1, total: 5 })}\n{"t":2,"total":`
  assert.deepEqual(parseSamples(text).map((s) => s.total), [5])
})

test('serialize/parse round-trips', () => {
  const samples = [sample('2026-09-24T00:00:00Z', 3.5)]
  assert.deepEqual(parseSamples(serializeSamples(samples)), samples)
})

test('a limit keeps the newest lines of the log', () => {
  // The log is append-only, so its tail is its present. Reading a log nobody thinned
  // used to materialise every line — a million objects for a file the caller throws
  // almost all of away — before the cap that was meant to bound it could fire.
  const many = []
  for (let i = 0; i < 5000; i += 1) many.push({ t: 1000 + i, total: i })
  const text = serializeSamples(many)
  assert.deepEqual(parseSamples(text, { limit: 3 }).map((s) => s.total), [4997, 4998, 4999])
  assert.equal(parseSamples(text, { limit: many.length }).length, many.length)
  assert.deepEqual(parseSamples(text).map((s) => s.total), many.map((s) => s.total))
})

test('compaction keeps every recent sample and one per hour before that', () => {
  const now = at('2026-09-24T12:00:00Z')
  const hour = 3600_000
  const old = []
  for (let i = 0; i < 10; i += 1) old.push({ t: at('2026-09-10T00:00:00Z') + i * 60_000, total: i })
  const recent = [{ t: now - hour, total: 100 }, { t: now - 60_000, total: 101 }]
  const kept = compactSamples([...old, ...recent], { nowMs: now, keepDays: 7 })
  assert.equal(kept.filter((s) => s.t >= now - 7 * 24 * hour).length, 2)
  assert.equal(kept.filter((s) => s.t < now - 7 * 24 * hour).length, 1) // all ten fall in one hour
})

test('thinned hours are the clock hours of the ledger\'s zone, not UTC ones', () => {
  // Kolkata is +05:30, so a UTC hour covers 23:30 of one local day and 00:30 of the next:
  // bucketing by UTC hour hands the bucket's last sample (00:25 local) to the next day and
  // leaves the day before it without its own last half hour.
  const zone = 'Asia/Kolkata'
  const now = at('2026-09-30T12:00:00Z')
  const samples = []
  for (let i = 0; i < 288 * 2; i += 1) samples.push({ t: at('2026-09-20T00:00:00Z') + i * 5 * 60_000, total: i })
  const kept = compactSamples(samples, { nowMs: now, keepDays: 7, zone })
  const newestOfDay = new Map()
  for (const one of kept) newestOfDay.set(dayKeyOf(one.t, zone), one)
  const lastOfDay = new Map()
  for (const one of samples) lastOfDay.set(dayKeyOf(one.t, zone), one)
  assert.deepEqual([...newestOfDay.keys()], [...lastOfDay.keys()], 'every sampled day is still there')
  for (const [key, newest] of newestOfDay) {
    // One sample per clock hour, last of the hour: the newest sample of a day is therefore
    // the newest sample that day ever had, and the day boundary survives the thinning.
    assert.equal(newest.t, lastOfDay.get(key).t, `${key} keeps the last sample of its own last hour`)
  }
})

test('a ledger over a full history builds no formatter per sample', () => {
  const zone = 'Europe/Berlin'
  const now = at('2026-09-30T12:00:00Z')
  const count = 35_000 // 120 days at the 5-minute cadence of the default keepDays
  const samples = []
  for (let i = 0; i < count; i += 1) {
    samples.push({ t: now - (count - i) * 5 * 60_000, total: 100 - (i % 97) * 0.01, currency: 'CNY' })
  }
  // What this protects against is the per-call `new Intl.DateTimeFormat(...)`: the same build
  // spent 2.8 s here before the formatters were cached, and 15 s at the sample cap, and the
  // 15 s browser poll runs it in the dsh process that every pane shares. The count is read
  // rather than the clock, because a wall-clock budget is a statement about the runner and
  // not about the code: this build costs tens of milliseconds here and would be several
  // times that on a loaded machine, while the counts below are the two shapes the fix
  // removed — one formatter for the whole build, and one calendar lookup per sample rather
  // than two per interval plus one per override row.
  const real = Intl.DateTimeFormat
  let built = 0
  let formatted = 0
  Intl.DateTimeFormat = class extends real {
    constructor(...args) {
      super(...args)
      built += 1
    }

    format(...args) {
      formatted += 1
      return super.format(...args)
    }
  }
  let ledger
  try {
    ledger = buildLedger({ samples, zone, nowMs: now, days: 30 })
  } finally {
    Intl.DateTimeFormat = real
  }
  assert.equal(ledger.rows.length, 30)
  // The zone is one panel setting, so the build may add the formatter the cache is missing
  // — at most one, and none at all when an earlier case already warmed the entry.
  assert.ok(built <= 1, `the build constructed ${built} formatters for one zone`)
  // One lookup per sample, plus today and the three window-coverage keys.
  assert.ok(formatted <= count + 8, `the build formatted ${formatted} instants for ${count} samples`)
})

test('calibration needs two samples inside the window and says what it covers', () => {
  const samples = [
    sample('2026-09-24T09:00:00Z', 100),
    sample('2026-09-24T09:30:00Z', 99.5),
    sample('2026-09-24T10:00:00Z', 99),
    sample('2026-09-24T10:30:00Z', 98),
    sample('2026-09-24T11:00:00Z', 97.75),
    sample('2026-09-24T12:00:00Z', 97),
  ]
  const window = { fromMs: at('2026-09-24T09:15:00Z'), toMs: at('2026-09-24T10:45:00Z') }
  const calibration = calibrationOf({ samples, ...window, currency: 'CNY' })
  assert.deepEqual(calibration, {
    currency: 'CNY',
    samples: 3,
    from: at('2026-09-24T09:30:00Z'),
    to: at('2026-09-24T10:30:00Z'),
    delta: 1.5,
  }, 'the delta is first-in-window minus last-in-window, and it says which samples')

  assert.equal(calibrationOf({ samples, ...window, currency: 'USD' }), null, 'another currency has no samples here')
  assert.equal(calibrationOf({ samples: samples.slice(0, 1), fromMs: 0, toMs: at('2026-09-25T00:00:00Z') }), null, 'one sample cannot express a delta')
  assert.equal(calibrationOf({ samples, fromMs: at('2026-09-24T10:45:00Z'), toMs: at('2026-09-24T09:15:00Z') }), null, 'a reversed window is refused')
  assert.equal(calibrationOf({}), null)

  // A top-up inside the window is a negative delta, not an error: the label says
  // the line is account-wide, so it must report what the account did.
  const toppedUp = calibrationOf({
    samples: [sample('2026-09-24T09:30:00Z', 10), sample('2026-09-24T10:30:00Z', 60)],
    fromMs: at('2026-09-24T09:00:00Z'),
    toMs: at('2026-09-24T11:00:00Z'),
  })
  assert.equal(toppedUp.delta, -50)
})
