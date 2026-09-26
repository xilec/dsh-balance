import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionCostProjection, SESSION_COST_KEY } from '../src/session-cost.js'
import { BJT_OFFSET_MS } from '../src/pricing.js'

const bjt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - BJT_OFFSET_MS

const config = { currency: 'CNY', holidays: undefined, fallbackPrices: undefined }
const projection = () => makeSessionCostProjection(() => config)

const message = (time, turn, step, inputTokens, cacheReadTokens, outputTokens, model = 'deepseek-flash') => ([
  { type: 'request/header', seq: 1, time, data: { header: { config: { model } } } },
  { type: 'assistant/message', seq: 2, time, data: { turn, step, usage: { inputTokens, cacheReadTokens, outputTokens } } },
])

const fold = (unit, events) => events.reduce((state, event) => unit.apply(state, event), unit.init())

test('the projection is registered under its own key with client-visible fields', () => {
  const unit = projection()
  assert.equal(unit.key, SESSION_COST_KEY)
  assert.equal(typeof unit.stateSchema.parse, 'function')
  assert.equal(typeof unit.wire.viewSchema.parse, 'function')
  assert.equal(unit.stateVersion, 1)
})

test('a peak-window session is priced at peak rates', () => {
  const unit = projection()
  const state = fold(unit, message(bjt(2026, 9, 24, 10, 0), 1, 1, 1e6, 0, 1e6))
  // 1M miss at 2 CNY + 1M output at 8 CNY
  assert.equal(state.cost, 10)
  assert.equal(unit.wire.view(state).cost, 10)
})

test('a weekend session is priced off-peak even inside peak hours', () => {
  const unit = projection()
  const state = fold(unit, message(bjt(2026, 9, 26, 10, 0), 1, 1, 1e6, 0, 1e6))
  assert.equal(state.cost, 5)
  assert.equal(unit.wire.view(state).peakNow, false)
})

test('a public-holiday session is priced off-peak', () => {
  const unit = projection()
  const state = fold(unit, message(bjt(2026, 10, 1, 10, 0), 1, 1, 1e6, 0, 1e6))
  assert.equal(state.cost, 5)
})

test('a session spanning the peak boundary mixes the two tariffs', () => {
  const unit = projection()
  const peak = message(bjt(2026, 9, 24, 11, 0), 1, 1, 1e6, 0, 0)
  const off = message(bjt(2026, 9, 24, 13, 0), 2, 1, 1e6, 0, 0)
  const state = fold(unit, [...peak, ...off])
  assert.equal(state.cost, 2 + 1)
  assert.equal(unit.wire.view(state).costByModel['deepseek-flash'], 3)
})

test('cache reads are billed at the hit rate', () => {
  const unit = projection()
  const state = fold(unit, message(bjt(2026, 9, 24, 10, 0), 1, 1, 0, 1e6, 0))
  assert.equal(state.cost, 0.04)
})

test('a repeated sample of one step replaces the earlier one', () => {
  const unit = projection()
  const events = message(bjt(2026, 9, 24, 10, 0), 1, 1, 1e6, 0, 0)
  const restated = [
    ...events,
    { type: 'assistant/message', seq: 3, time: bjt(2026, 9, 24, 10, 1), data: { turn: 1, step: 1, usage: { inputTokens: 3e6, cacheReadTokens: 0, outputTokens: 0 } } },
  ]
  const state = fold(unit, restated)
  assert.equal(state.cost, 6)
  assert.equal(unit.wire.view(state).tokens.uncachedInput, 3e6)
})

test('a retried attempt is not double-counted', () => {
  const unit = projection()
  const first = message(bjt(2026, 9, 24, 10, 0), 1, 1, 1e6, 0, 0)
  const retry = [
    ...first,
    { type: 'llm/retry-started', seq: 3, time: bjt(2026, 9, 24, 10, 0), data: { turn: 1, step: 1 } },
  ]
  const second = { type: 'assistant/message', seq: 4, time: bjt(2026, 9, 24, 10, 0), data: { turn: 1, step: 1, usage: { inputTokens: 2e6, cacheReadTokens: 0, outputTokens: 0 } } }
  const state = fold(unit, [...retry, second])
  assert.equal(state.cost, 4)
})

test('an unknown model is reported as unpriced instead of silently costing zero', () => {
  const unit = projection()
  const state = fold(unit, message(bjt(2026, 9, 24, 10, 0), 1, 1, 1e6, 0, 1e6, 'reseller-model'))
  assert.equal(state.cost, 0)
  assert.deepEqual(unit.wire.view(state).unpriced, ['reseller-model'])
})

test('a configured fallback prices an unknown model', () => {
  const unit = makeSessionCostProjection(() => ({ ...config, fallbackPrices: { cacheHit: 0.1, cacheMiss: 1, output: 2 } }))
  const state = fold(unit, message(bjt(2026, 9, 24, 10, 0), 1, 1, 1e6, 0, 1e6, 'reseller-model'))
  assert.equal(state.cost, 3)
})

test('events without usage leave the state reference untouched', () => {
  const unit = projection()
  const initial = unit.init()
  const afterHeader = unit.apply(initial, { type: 'request/header', seq: 1, time: 0, data: { header: { config: { model: 'deepseek-flash' } } } })
  assert.notEqual(afterHeader, initial)
  const afterNoise = unit.apply(afterHeader, { type: 'tool/result', seq: 2, time: 0, data: {} })
  assert.equal(afterNoise, afterHeader)
})
