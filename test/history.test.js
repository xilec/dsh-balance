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
