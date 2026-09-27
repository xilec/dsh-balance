import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLedger, compactSamples, dayKeyOf, medianGapMs, movements, parseSamples,
  recentDayKeys, serializeSamples,
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
  assert.equal(ledger.totals.w1.amount, 5)
  assert.equal(ledger.totals.m1.amount, 5)
  assert.equal(ledger.totals.m1.covered, false) // sampling starts after 2026-08-26
  assert.equal(ledger.rows.length, 30)
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
