import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionCostProjection, makeFallbackResolver, seriesPayload, SESSION_COST_KEY, TARIFF_PROJECTIONS } from '../src/session-cost.js'
import { BJT_OFFSET_MS } from '../src/pricing.js'

const bjt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - BJT_OFFSET_MS

const config = { currency: 'CNY', holidays: undefined, fallbackPrices: undefined }
const projection = () => makeSessionCostProjection(() => config)

const message = (time, turn, step, inputTokens, cacheReadTokens, outputTokens, model = 'deepseek-flash') => ([
  { type: 'request/header', seq: 1, time, data: { header: { config: { model } } } },
  { type: 'assistant/message', seq: 2, time, data: { turn, step, usage: { inputTokens, cacheReadTokens, outputTokens } } },
])

const fold = (unit, events) => events.reduce((state, event) => unit.apply(state, event), unit.init())

/** Give a hand-written event list the sequence numbers the projection stamps. */
const sequenced = (events) => events.map((event, index) => ({ ...event, seq: index + 1 }))

test('the projection is registered under its own key with client-visible fields', () => {
  const unit = projection()
  assert.equal(unit.key, SESSION_COST_KEY)
  assert.equal(typeof unit.stateSchema.parse, 'function')
  assert.equal(typeof unit.wire.viewSchema.parse, 'function')
  assert.equal(unit.stateVersion, 3)
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

test('the series keeps one node per step, with its calls and its interval', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    { type: 'step/start', time, data: { turn: 1, step: 1 } },
    { type: 'request/header', time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'tool/call', time: time + 1000, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la\n  --all"}' } },
    { type: 'step/end', time: time + 2000, data: { turn: 1, step: 1 } },
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  assert.equal(nodes.length, 1)
  assert.deepEqual(
    { turn: nodes[0].turn, step: nodes[0].step, tStart: nodes[0].tStart, tEnd: nodes[0].tEnd, ended: nodes[0].ended },
    { turn: 1, step: 1, tStart: time, tEnd: time + 2000, ended: true },
  )
  assert.equal(nodes[0].cost, 10)
  assert.deepEqual(nodes[0].calls, [{ name: 'bash', callId: 'call-1', preview: '{"command":"ls -la\n--all"}' }])
  assert.equal(unit.wire.view(state).steps, 1)
})

test('a retry keeps the evicted attempt on the node but out of the money', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    { type: 'llm/retry-started', time, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time, data: { turn: 1, step: 1, usage: { inputTokens: 2e6, cacheReadTokens: 0, outputTokens: 0 } } },
  ]))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.equal(node.retries, 1)
  assert.deepEqual(node.evicted.map((report) => report.buckets.uncachedInput), [1e6])
  assert.equal(node.cost, 4, 'the surviving attempt only')
  assert.equal(unit.wire.view(state).cost, 4)
  assert.equal(node.unpriced, false)
})

test('an in-progress step is already part of the series and the totals', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced(message(time, 1, 1, 1e6, 0, 0)))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.equal(node.ended, false)
  assert.equal(node.hasUsage, true)
  assert.equal(node.tEnd, time, 'the newest report times the open interval')
  assert.equal(unit.wire.view(state).cost, 2)
})

test('the series sums to the session total exactly', () => {
  const unit = projection()
  const peak = bjt(2026, 9, 24, 10, 0)
  const off = bjt(2026, 9, 24, 13, 0)
  const state = fold(unit, sequenced([
    ...message(peak, 1, 1, 3e6, 0, 1e6),
    ...message(off, 1, 2, 1e6, 2e6, 5e5),
    { type: 'llm/retry-started', time: off, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: off, data: { turn: 1, step: 2, usage: { inputTokens: 1e6, outputTokens: 2e6 } } },
    ...message(peak, 2, 1, 4e5, 0, 4e5, 'reseller-model'),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  const total = nodes.reduce((sum, node) => sum + node.cost, 0)
  assert.equal(nodes.length, 3)
  assert.equal(unit.wire.view(state).steps, 3)
  assert.ok(Math.abs(total - unit.wire.view(state).cost) < 1e-9, 'Σ nodes equals the session estimate')
  assert.deepEqual(nodes[2].unpriced, true)
  assert.deepEqual(unit.wire.view(state).unpriced, ['reseller-model'])
})

test('the wire view carries the sequence and the step count, and no series', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const events = sequenced([...message(time, 1, 1, 1e6, 0, 0), ...message(time, 1, 2, 1e6, 0, 0)])
  const state = fold(unit, events)
  const view = unit.wire.view(state)
  assert.equal(view.seq, events.length)
  assert.equal(view.steps, 2)
  assert.deepEqual(Object.keys(view).sort(), [
    'cost', 'costByModel', 'currency', 'models', 'peakNow', 'seq', 'steps', 'tokens', 'unpriced',
  ])
})

test('the projection state survives a JSON checkpoint with its series', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([...message(time, 1, 1, 1e6, 0, 0), ...message(time, 1, 2, 1e6, 0, 0)]))
  const parsed = unit.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.equal(unit.stateSchema.parse(JSON.parse(JSON.stringify(unit.init()))).committed, 0)
  assert.equal(parsed.committed, 1, 'the first step is committed to the chunked list')
  assert.equal(parsed.pending.step, 2)
  assert.equal(seriesPayload(parsed, { currency: 'CNY' }).length, 2)
})

test('a node prices each token bucket, and the buckets add up to the Step', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced(message(time, 1, 1, 1e6, 1e6, 1e6)))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.deepEqual(node.costByBucket, { uncachedInput: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  const sum = Object.values(node.costByBucket).reduce((total, value) => total + value, 0)
  assert.ok(Math.abs(sum - node.cost) < 1e-9, 'the per-bucket costs add up to the Step cost')

  const unpriced = fold(projection(), sequenced(message(time, 1, 1, 1e6, 0, 1e6, 'reseller-model')))
  const [unpricedNode] = seriesPayload(unpriced, { currency: 'CNY' })
  assert.deepEqual(unpricedNode.costByBucket, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, 'an unpriced Step splits no money')
})

test('every Step carries the three Tariff projections', () => {
  assert.deepEqual([...TARIFF_PROJECTIONS], ['fact', 'offPeak', 'peak'])
  const unit = projection()
  const peak = bjt(2026, 9, 24, 10, 0)
  const off = bjt(2026, 9, 24, 13, 0)
  const state = fold(unit, sequenced([
    ...message(peak, 1, 1, 1e6, 0, 1e6),
    ...message(off, 1, 2, 1e6, 0, 1e6),
  ]))
  const [step1, step2] = seriesPayload(state, { currency: 'CNY' })
  // The peak Step: 2 + 8 at peak, half of that off-peak, and `fact` is what it was.
  assert.equal(step1.cost, 10)
  assert.equal(step1.peak.cost, 10)
  assert.equal(step1.offPeak.cost, 5)
  assert.deepEqual(step1.peak.costByBucket, { uncachedInput: 2, cacheRead: 0, cacheWrite: 0, output: 8 })
  assert.deepEqual(step1.offPeak.costByBucket, { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 4 })
  // The off-peak Step is the mirror image of it.
  assert.equal(step2.cost, 5)
  assert.equal(step2.offPeak.cost, 5)
  assert.equal(step2.peak.cost, 10)
  // A Step's own projections add up line by line too.
  for (const projection of ['fact', 'offPeak', 'peak']) {
    const money = projection === 'fact' ? step1 : step1[projection]
    const sum = Object.values(money.costByBucket).reduce((total, value) => total + value, 0)
    assert.ok(Math.abs(sum - money.cost) < 1e-9, `${projection} buckets add up`)
  }
})

test('a Step spanning the boundary sits between its own two projections', () => {
  const unit = projection()
  const state = fold(unit, sequenced([
    ...message(bjt(2026, 9, 24, 11, 0), 1, 1, 1e6, 0, 0),
    ...message(bjt(2026, 9, 24, 13, 0), 2, 1, 1e6, 0, 0),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  const money = (projection) => nodes.reduce(
    (total, node) => total + (projection === 'fact' ? node.cost : node[projection].cost),
    0,
  )
  assert.equal(money('fact'), 3)
  assert.equal(money('offPeak'), 2, '1 for the peak Step halved, 1 for the one already off peak')
  assert.equal(money('peak'), 4, '2 for each, whatever the instant')
})

test('a rate entered for one model reprices the whole history', () => {
  let config = { currency: 'CNY', holidays: undefined, fallbackPrices: undefined }
  const unit = makeSessionCostProjection(() => config)
  const time = bjt(2026, 9, 24, 10, 0)
  const events = sequenced([
    ...message(time, 1, 1, 1e6, 0, 0, 'reseller-model'),
    ...message(time, 1, 2, 1e6, 0, 0),
  ])
  const before = fold(unit, events)
  assert.equal(before.cost, 2, 'the unknown model adds nothing to the money')
  assert.deepEqual(unit.wire.view(before).unpriced, ['reseller-model'])

  config = { ...config, fallbackRates: { 'reseller-model': { cacheHit: 0.1, cacheMiss: 1, output: 2 } } }
  // A rate change is picked up on the next read, without a new event: the
  // aggregates are rebuilt from the stored reports, the series is untouched.
  const view = unit.wire.view(before)
  assert.equal(view.cost, 3, '2 from the flash Step plus 1 for the repriced one')
  assert.deepEqual(view.unpriced, [])
  assert.deepEqual(seriesPayload(before, { currency: 'CNY', fallback: makeFallbackResolver(config) })[0]
    .costByBucket, { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 0 })

  // And the next event keeps folding on the repriced aggregates.
  const after = unit.apply(before, { type: 'assistant/message', seq: 9, time, data: { turn: 1, step: 3, usage: { inputTokens: 1e6, outputTokens: 0 } } })
  assert.equal(unit.wire.view(after).cost, 5)
  assert.equal(seriesPayload(after, { currency: 'CNY' }).length, 3)
})

test('a per-model rate wins over the global fallback and respects a price phase', () => {
  const config = {
    currency: 'CNY',
    priceUnknownModels: true,
    fallbackPrices: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    fallbackRates: { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } },
  }
  const resolve = makeFallbackResolver(config)
  assert.deepEqual(resolve('reseller-model'), { cacheHit: 0.1, cacheMiss: 2, output: 8 })
  assert.deepEqual(resolve('other-model'), config.fallbackPrices)

  const unit = makeSessionCostProjection(() => config)
  const state = fold(unit, sequenced(message(bjt(2026, 9, 24, 13, 0), 1, 1, 1e6, 0, 1e6, 'reseller-model')))
  const [node] = seriesPayload(state, { currency: 'CNY', fallback: resolve })
  assert.equal(node.cost, 5, 'off-peak: 1 + 4')
  assert.equal(node.peak.cost, 10, 'the entered rates are peak rates')
  assert.equal(node.unpriced, false)
})

test('a call preview keeps three lines of a long command', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const args = JSON.stringify({ command: 'cd /home/evgen/work\ngit fetch origin\ngit log --oneline -5\nmore' })
  const state = fold(unit, sequenced([
    { type: 'tool/call', time, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: args } },
  ]))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  const preview = node.calls[0].preview
  assert.equal(preview.split('\n').length, 3, 'three lines survive')
  assert.ok(preview.length > 60, 'and the preview is no longer one short line')
  assert.ok(preview.startsWith('{"command":"cd /home/evgen/work\ngit fetch origin\ngit log --oneline -5'), 'the first three lines survive verbatim')
  assert.ok(!preview.includes('more'), 'the fourth line is dropped')

  const long = 'x'.repeat(500)
  const truncated = fold(projection(), sequenced([
    { type: 'tool/call', time, data: { turn: 1, step: 1, callId: 'call-2', name: 'bash', arguments: long } },
  ]))
  const [other] = seriesPayload(truncated, { currency: 'CNY' })
  assert.equal(other.calls[0].preview.length, 200, 'the character budget still applies')
  assert.match(other.calls[0].preview, /…$/)
})
