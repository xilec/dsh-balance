import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BJT_OFFSET_MS, OFF_PEAK_RATIO, PUBLIC_HOLIDAYS_2026,
  bjtFields, costOfTokens, isPeakInstant, modelClass, peakState, priceAt, ratesAt,
} from '../src/pricing.js'

/** Epoch ms of a Beijing-time wall-clock instant. */
const bjt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - BJT_OFFSET_MS

test('peak windows are Beijing-time 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 9, 0)), true) // Thursday
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 11, 59)), true)
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 12, 0)), false)
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 14, 0)), true)
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 17, 59)), true)
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 18, 0)), false)
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 8, 59)), false)
})

test('weekends are off-peak all day', () => {
  assert.equal(isPeakInstant(bjt(2026, 9, 26, 10, 0)), false) // Saturday
  assert.equal(isPeakInstant(bjt(2026, 9, 27, 15, 0)), false) // Sunday
  assert.equal(peakState(bjt(2026, 9, 26, 10, 0)).reason, 'weekend')
  // A weekend that is a make-up working day (调休) is still billed off-peak.
  assert.equal(isPeakInstant(bjt(2026, 10, 10, 10, 0)), false)
})

test('Chinese public holidays are off-peak on weekdays', () => {
  assert.equal(isPeakInstant(bjt(2026, 10, 1, 10, 0)), false) // National Day, Thursday
  assert.equal(peakState(bjt(2026, 10, 1, 10, 0)).reason, 'holiday')
  assert.equal(isPeakInstant(bjt(2026, 9, 25, 10, 0)), false) // Mid-Autumn, Friday
  assert.equal(isPeakInstant(bjt(2026, 2, 17, 15, 0)), false) // Spring Festival, Tuesday
  // The working days around a holiday window stay on the normal rule.
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 10, 0)), true) // Thursday before Mid-Autumn
  assert.equal(isPeakInstant(bjt(2026, 10, 8, 10, 0)), true) // Thursday after National Day
})

test('a holiday list can be overridden', () => {
  const custom = new Set(['2026-09-24'])
  assert.equal(isPeakInstant(bjt(2026, 9, 24, 10, 0), custom), false)
  assert.equal(peakState(bjt(2026, 9, 24, 10, 0), custom).reason, 'holiday')
  assert.equal(isPeakInstant(bjt(2026, 10, 1, 10, 0), custom), true)
})

test('Beijing fields come from the UTC+8 calendar, not the host zone', () => {
  const fields = bjtFields(bjt(2026, 9, 24, 0, 30)) // Thursday 00:30 BJT
  assert.equal(fields.dateKey, '2026-09-24')
  assert.equal(fields.weekday, 4)
  assert.equal(fields.minuteOfDay, 30)
  // 22:30Z is already the next Beijing day.
  assert.equal(bjtFields(Date.UTC(2026, 8, 23, 22, 30)).dateKey, '2026-09-24')
})

test('peak rates are the published ones and off-peak is exactly half', () => {
  const peak = priceAt('deepseek-flash', bjt(2026, 9, 24, 10, 0), { currency: 'CNY' })
  assert.deepEqual({ ...peak, peak: undefined, reason: undefined, currency: undefined, class: undefined }, { peak: undefined, reason: undefined, currency: undefined, class: undefined, cacheHit: 0.04, cacheMiss: 2, output: 8 })
  const off = priceAt('deepseek-flash', bjt(2026, 9, 26, 10, 0), { currency: 'CNY' })
  assert.equal(off.cacheMiss, 2 * OFF_PEAK_RATIO)
  assert.equal(off.cacheHit, 0.04 * OFF_PEAK_RATIO)
  assert.equal(off.output, 8 * OFF_PEAK_RATIO)
  const pro = priceAt('deepseek-v4-pro', bjt(2026, 9, 24, 10, 0), { currency: 'CNY' })
  assert.deepEqual(
    { cacheHit: pro.cacheHit, cacheMiss: pro.cacheMiss, output: pro.output },
    { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  )
  const usd = priceAt('deepseek-v4-pro', bjt(2026, 9, 24, 10, 0), { currency: 'USD' })
  assert.deepEqual(
    { cacheHit: usd.cacheHit, cacheMiss: usd.cacheMiss, output: usd.output },
    { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  )
})

test('the 2026-09-10 Flash price cut is applied per event time', () => {
  const before = priceAt('deepseek-flash', bjt(2026, 9, 1, 10, 0), { currency: 'CNY' })
  assert.equal(before.cacheMiss, 3)
  const after = priceAt('deepseek-flash', bjt(2026, 9, 11, 10, 0), { currency: 'CNY' })
  assert.equal(after.cacheMiss, 2)
  assert.equal(ratesAt(bjt(2026, 9, 1, 10, 0)).CNY.pro.cacheMiss, 9)
})

test('model ids map to their rate class', () => {
  assert.equal(modelClass('deepseek-flash'), 'flash')
  assert.equal(modelClass('deepseek-v4-flash'), 'flash')
  assert.equal(modelClass('deepseek-v4-flash-vision-exp'), 'flash')
  assert.equal(modelClass('deepseek-v4.1-flash'), 'flash')
  assert.equal(modelClass('deepseek-v4-pro'), 'pro')
  assert.equal(modelClass('deepseek-v4-pro-0813'), 'pro')
  assert.equal(modelClass('some-reseller-model'), null)
  assert.equal(priceAt('some-reseller-model', Date.now(), { currency: 'CNY' }), null)
})

test('a fallback rate can price an unknown model', () => {
  const rate = priceAt('unknown-model', bjt(2026, 9, 26, 10, 0), {
    currency: 'CNY',
    fallback: { cacheHit: 0.1, cacheMiss: 1, output: 2 },
  })
  assert.equal(rate.cacheMiss, 0.5)
  assert.equal(rate.class, 'fallback')
})

test('a Tariff projection forces the phase without changing the rate table', () => {
  const peak = bjt(2026, 9, 24, 10, 0)
  const off = bjt(2026, 9, 24, 13, 0)
  const factPeak = priceAt('deepseek-flash', peak, { currency: 'CNY' })
  const factOff = priceAt('deepseek-flash', off, { currency: 'CNY' })
  assert.equal(factPeak.cacheMiss, 2)
  assert.equal(factOff.cacheMiss, 1)
  // Off-peak is half of the peak rate, in both directions and at either instant.
  assert.equal(priceAt('deepseek-flash', off, { currency: 'CNY', phase: 'peak' }).cacheMiss, 2)
  assert.equal(priceAt('deepseek-flash', peak, { currency: 'CNY', phase: 'offPeak' }).cacheMiss, 1)
  assert.equal(priceAt('deepseek-flash', off, { currency: 'CNY', phase: 'peak' }).peak, true)
  assert.equal(priceAt('deepseek-flash', peak, { currency: 'CNY', phase: 'offPeak' }).peak, false)
  // The projection still reads the table in force at the event, not the current one.
  const oldPeak = priceAt('deepseek-flash', bjt(2026, 9, 1, 10, 0), { currency: 'CNY', phase: 'offPeak' })
  assert.equal(oldPeak.cacheMiss, 1.5)
})

test('token cost adds cache writes to the miss bucket', () => {
  const rate = { cacheHit: 0.02, cacheMiss: 1, output: 4 }
  const cost = costOfTokens({ uncachedInput: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, rate)
  assert.equal(cost, 0.02 + 1 + 1 + 4)
})

test('the shipped holiday list covers the published 2026 windows', () => {
  assert.equal(PUBLIC_HOLIDAYS_2026.includes('2026-09-25'), true)
  assert.equal(PUBLIC_HOLIDAYS_2026.includes('2026-10-07'), true)
  assert.equal(PUBLIC_HOLIDAYS_2026.length, 3 + 9 + 3 + 5 + 3 + 3 + 7)
})
