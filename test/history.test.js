import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLedger, calibrationOf, compactSamples, dayKeyOf, medianGapMs, movements, parseSamples,
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

test('an anchor is measured only from inside the day it corrects', () => {
  // The three positions of an anchor against the day's newest sample, which is the rule the
  // arithmetic turns on: the added part is the drop from the anchor to that sample, so it is a
  // measurement of one day only while both of its ends are on that day.
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
