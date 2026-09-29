import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionCostProjection, makeFallbackResolver, seriesPayload, subtreeSummary, SESSION_COST_KEY, TARIFF_PROJECTIONS } from '../src/session-cost.js'
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
  assert.equal(unit.stateVersion, 6)
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
  assert.deepEqual(nodes[0].calls, [{
    name: 'bash',
    callId: 'call-1',
    preview: '{"command":"ls -la\n--all"}',
    time: time + 1000,
    seq: 4,
  }], 'the export can cite the call by instant and log sequence')
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
  // The export shows what the lost attempt would have cost, priced by the Host like
  // any other attempt, and never adds it to a total (D28).
  assert.equal(node.reports[0].seq, 4, 'every report keeps the sequence and instant it came from')
  assert.equal(node.reports[0].cost, 4, "the surviving attempt is the one that is billed")
  assert.equal(node.evicted[0].cost, 2, 'the peak rate that was in force')
  assert.equal(node.evicted[0].offPeak.cost, 1, 'and the off-peak counterfactual')
  assert.equal(node.evicted[0].peak.cost, 2)
  assert.ok(Number.isInteger(node.evicted[0].seq))
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
  // Unpriced tokens are counted and shown even though no rate applies to them: the
  // session's token figures must not shrink to the priced part (D18).
  assert.deepEqual(nodes[2].buckets, { uncachedInput: 4e5, cacheRead: 0, cacheWrite: 0, output: 4e5 }, 'the unpriced Step carries its tokens')
  assert.deepEqual(
    unit.wire.view(state).tokens,
    { uncachedInput: 3e6 + 1e6 + 4e5, cacheRead: 0, cacheWrite: 0, output: 1e6 + 2e6 + 4e5 },
    'and they are in the wire totals, while the tokens of the evicted attempt stay out',
  )
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
  assert.deepEqual(unpricedNode.buckets, { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 }, 'but its tokens are still its own')
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

test('a spawn is attributed to the Step that created the child, and its money stays out of the session', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    { type: 'step/start', time, data: { turn: 4, step: 2 } },
    ...message(time + 1_000, 4, 2, 1e6, 0, 0).map((event) => ({ ...event, time: time + 1_000 })),
    { type: 'subagent/catalog', time: time + 2_000, data: { version: 1, childId: 'child-1', childCreatedAt: time + 1_500, mode: 'continuable', label: 'Survey the client' } },
    { type: 'step/end', time: time + 3_000, data: { turn: 4, step: 2 } },
    { type: 'step/start', time: time + 4_000, data: { turn: 4, step: 3 } },
    ...message(time + 5_000, 4, 3, 0, 0, 1e6).map((event, index) => ({ ...event, time: time + 5_000, seq: index + 6 })),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes[0].children.map((child) => child.id), ['child-1'], 'the spawning Step carries the marker')
  assert.equal(nodes[0].children[0].label, 'Survey the client')
  assert.equal(nodes[0].children[0].mode, 'continuable', 'and the mode the catalog reported')
  assert.equal(nodes[0].children[0].createdAt, time + 1_500, 'with the child’s own creation instant')
  assert.deepEqual(nodes[1].children, [], 'and no other Step does')
  // 1M miss at 2 CNY + 1M output at 8 CNY: the child contributes nothing.
  assert.equal(state.cost, 10)
  assert.equal(state.spawns.length, 1)

  const again = unit.apply(state, { type: 'subagent/catalog', seq: 99, time: time + 6_000, data: { childId: 'child-1', childCreatedAt: time + 1_500, mode: 'continuable', label: 'Survey the client' } })
  assert.equal(again.spawns.length, 1, 'the same child is catalogued once')

  // A background child is catalogued after its Step ended, and the next Step has
  // already started: the creation instant still names the Step that spawned it.
  const background = fold(unit, sequenced([
    { type: 'step/start', time, data: { turn: 4, step: 2 } },
    ...message(time + 1_000, 4, 2, 1e6, 0, 0).map((event) => ({ ...event, time: time + 1_000 })),
    { type: 'step/end', time: time + 2_000, data: { turn: 4, step: 2 } },
    { type: 'step/start', time: time + 5_000, data: { turn: 4, step: 3 } },
    { type: 'subagent/catalog', time: time + 6_000, data: { childId: 'child-bg', childCreatedAt: time + 1_500, mode: 'one-shot' } },
  ]))
  const [first, second] = seriesPayload(background, { currency: 'CNY' })
  assert.deepEqual(first.children.map((child) => child.id), ['child-bg'], 'the spawn belongs to the Step that ran the call')
  assert.deepEqual(second.children, [], 'not to the Step that happened to be open when the fact was written')

  // A spawn catalogued outside any Step at all is still kept, and the export will
  // see it even though no Step of this session can carry the marker.
  const loose = fold(unit, sequenced([
    { type: 'subagent/catalog', time, data: { childId: 'child-2', childCreatedAt: time, mode: 'one-shot' } },
  ]))
  assert.equal(loose.spawns.length, 1)
  assert.equal(loose.spawns[0].label, '')
  assert.equal(loose.spawns[0].createdAt, time, 'the event time stands in when there is no creation instant')
})

test('a child summary sums the same priced Steps the parent uses', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const child = fold(unit, sequenced([
    { type: 'step/start', time, data: { turn: 1, step: 1 } },
    ...message(time + 1_000, 1, 1, 1e6, 0, 1e6).map((event) => ({ ...event, time: time + 1_000 })),
    { type: 'step/end', time: time + 2_000, data: { turn: 1, step: 1 } },
    { type: 'step/start', time: time + 3_000, data: { turn: 1, step: 2 } },
    ...message(time + 4_000, 1, 2, 0, 2e6, 0).map((event, index) => ({ ...event, time: time + 4_000, seq: 10 + index })),
  ]))
  const summary = subtreeSummary(seriesPayload(child, { currency: 'CNY' }))
  assert.equal(summary.steps, 2)
  assert.equal(summary.cost, 10.08, 'the two Steps, priced as the parent prices its own')
  assert.equal(summary.costByBucket.uncachedInput, 2)
  assert.equal(summary.costByBucket.cacheRead, 0.08)
  assert.equal(summary.costByBucket.output, 8)
  assert.deepEqual(summary.models, ['deepseek-flash'])
  assert.equal(summary.tStart, time)
  assert.equal(summary.tEnd, time + 4_000)
  assert.equal(summary.offPeak.cost, 5.04, 'and every projection comes along')
  assert.deepEqual(subtreeSummary([]), {
    steps: 0,
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    models: [],
    unpriced: false,
    tStart: 0,
    tEnd: 0,
    cost: 0,
    costByBucket: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    offPeak: { cost: 0, costByBucket: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
    peak: { cost: 0, costByBucket: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
  })
})

test('a forked child does not inherit its parent’s work or spawns', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const events = sequenced([
    { type: 'step/start', time, data: { turn: 1, step: 1 } },
    ...message(time + 1_000, 1, 1, 1e6, 0, 1e6).map((event) => ({ ...event, time: time + 1_000 })),
    { type: 'step/end', time: time + 2_000, data: { turn: 1, step: 1 } },
    { type: 'subagent/catalog', time: time + 2_500, data: { childId: 'child-1', childCreatedAt: time + 2_500, mode: 'one-shot' } },
    { type: 'step/start', time: time + 3_000, data: { turn: 2, step: 1 } },
    ...message(time + 4_000, 2, 1, 1e6, 0, 0).map((event, index) => ({ ...event, time: time + 4_000, seq: 10 + index })),
  ])
  // The child's log is its own events after the inherited prefix (seeded with the
  // parent's completed turn, sequences 1..4).
  const inherited = { session: { id: 'child' }, inheritedEventCount: 6, events }
  const child = inherited.events.reduce((state, event) => unit.apply(state, event), unit.init(undefined, inherited.inheritedEventCount))
  assert.equal(child.cost, 2, 'only the child’s own Step is billed: 1M miss at 2 CNY')
  assert.equal(child.spawns.length, 0, 'and the parent’s catalog fact is not the child’s spawn')
  const [node] = seriesPayload(child, { currency: 'CNY' })
  assert.equal(node.turn, 2, 'the inherited Step is not part of the child’s series')
  assert.equal(node.cost, 2)

  // Without the count the same log would report the parent's turn too.
  const whole = events.reduce((state, event) => unit.apply(state, event), unit.init())
  assert.equal(whole.cost, 12)
  assert.equal(whole.spawns.length, 1)
})

test('a report for a Step the loop already left lands in that Step, not in a second one', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 2e6, 0, 0),
    { type: 'assistant/message', time: time + 1, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    { type: 'step/start', time: time + 2, data: { turn: 1, step: 2 } },
    ...message(time + 3, 1, 1, 3e6, 0, 0),
  ]))
  const nodes = seriesPayload(unit.wire ? state : state, { currency: 'CNY' })
  assert.deepEqual(nodes.map((node) => [node.turn, node.step]), [[1, 1], [1, 2]], 'the Step keeps one node, in its place')
  assert.equal(nodes[0].cost, 6, 'and it counts the restated report only: 3M miss at 2 CNY')
  assert.equal(nodes[0].reports.length, 1)
  assert.equal(unit.wire.view(state).tokens.uncachedInput, 3e6, 'the restated tokens are not counted twice')
  assert.equal(unit.wire.view(state).cost, 6)
})

test('a model switch inside one Step keeps both reports and both prices', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0, 'deepseek-flash'),
    ...message(time + 1, 1, 1, 1e6, 0, 0, 'deepseek-pro'),
  ]))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.deepEqual(node.reports.map((report) => report.model), ['deepseek-flash', 'deepseek-pro'], 'both models are kept')
  assert.deepEqual(node.buckets, { uncachedInput: 2e6, cacheRead: 0, cacheWrite: 0, output: 0 }, 'and both sets of tokens')
  assert.equal(node.cost, 11, '2 CNY for flash plus 9 CNY for pro, each at its own rate')
  assert.deepEqual(Object.keys(unit.wire.view(state).costByModel).sort(), ['deepseek-flash', 'deepseek-pro'])
})

test('a call for a Step the loop already left joins that Step', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    { type: 'step/start', time: time + 1, data: { turn: 1, step: 2 } },
    ...message(time + 2, 1, 2, 1e6, 0, 0),
    { type: 'tool/call', time: time + 3, data: { turn: 1, step: 1, callId: 'call-late', name: 'bash', arguments: '{"command":"ls"}' } },
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  assert.deepEqual(nodes.map((node) => [node.turn, node.step]), [[1, 1], [1, 2]])
  assert.deepEqual(nodes[0].calls.map((call) => call.callId), ['call-late'], 'the late call joined its own Step')
  assert.equal(unit.wire.view(state).steps, 2, 'and no extra Step appeared')
})

test('an evicted attempt leaves no stale model in the wire view', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    { type: 'step/start', time, data: { turn: 1, step: 1 } },
    { type: 'request/header', time, data: { header: { config: { model: 'reseller-model' } } } },
    { type: 'assistant/message', time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    { type: 'llm/retry-started', time: time + 1, data: { turn: 1, step: 1 } },
  ]))
  const view = unit.wire.view(state)
  assert.deepEqual(view.tokens, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, 'the evicted tokens are gone')
  assert.deepEqual(view.models, [], 'so the model that only ever had that attempt is gone too')
  assert.deepEqual(view.unpriced, [], 'and it is not still announced as unpriced')
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.equal(node.unpriced, false, 'the series agrees: there is nothing left to price')
  assert.deepEqual(node.evicted.map((report) => report.model), ['reseller-model'], 'while the evicted attempt stays retrievable')
})

/** A compaction's three events: only the summary carries the bill. */
const compaction = (time, id, turn, shadowedTokenCount = 1e5, model = 'deepseek-flash') => ([
  { type: 'compaction/start', time, data: { compactionId: id, turn } },
  {
    type: 'compaction/summary',
    time: time + 500,
    data: {
      compactionId: id,
      turn,
      model,
      shadowedTokenCount,
      usage: { inputTokens: 2e5, cacheReadTokens: 0, outputTokens: 1e5 },
    },
  },
  { type: 'compaction/end', time: time + 900, data: { compactionId: id, turn } },
])

test('a compaction is a node of its own, billed once and counted in the estimate', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    ...compaction(time + 1000, 'cmp-1', null),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].kind, 'step')
  assert.equal(nodes[1].kind, 'compaction')
  assert.equal(nodes[1].compaction.id, 'cmp-1')
  assert.equal(nodes[1].compaction.shadowedTokenCount, 1e5)
  assert.equal(nodes[1].step, null, 'a Compaction step is nobody\'s Step')
  assert.equal(nodes[1].cost, 1.2, '2e5 miss at 2 CNY plus 1e5 output at 8 CNY')
  assert.equal(nodes[1].ended, true)
  const view = unit.wire.view(state)
  assert.equal(view.cost, 2 + 1.2)
  assert.equal(view.steps, 1, 'a Compaction step is not a Step the reader can walk through')
  assert.equal(view.costByModel['deepseek-flash'], 3.2, 'and its money lands in the model it was written with')
  const sum = nodes.reduce((total, node) => total + node.cost, 0)
  assert.ok(Math.abs(sum - view.cost) < 1e-9, 'Σ nodes equals the session estimate with the compaction in it')
})

test('a compaction that wrote no summary bills nothing, and a prune only shadows', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const withoutSummary = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    { type: 'compaction/start', time: time + 1000, data: { compactionId: 'cmp-1', turn: null } },
    { type: 'compaction/end', time: time + 1200, data: { compactionId: 'cmp-1', turn: null } },
  ]))
  assert.equal(seriesPayload(withoutSummary, { currency: 'CNY' }).length, 1, 'no summary, no node')
  assert.equal(unit.wire.view(withoutSummary).cost, 2)

  const pruned = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    { type: 'compaction/prune', time: time + 1000, data: { shadowedSeqs: [1], shadowedTokenCount: 5e5 } },
  ]))
  assert.equal(seriesPayload(pruned, { currency: 'CNY' }).length, 1, 'a prune shadows tokens the summary already accounted for')
  assert.equal(unit.wire.view(pruned).cost, 2)
})

test('a compaction joins the Turn that rewrote its context, ahead of the Step it serves', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const insideTurn = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    ...compaction(time + 1000, 'cmp-1', 1),
    ...message(time + 2000, 1, 2, 1e6, 0, 0),
  ]))
  const inside = seriesPayload(insideTurn, { currency: 'CNY' })
  assert.deepEqual(
    inside.map((node) => [node.kind, node.turn, node.step]),
    [['step', 1, 1], ['compaction', 1, null], ['step', 1, 2]],
    'the bill sits between the Step that caused the compaction and the one it serves',
  )

  const betweenTurns = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    { type: 'turn/end', time: time + 10, data: { turn: 1, reason: 'stop' } },
    ...compaction(time + 1000, 'cmp-1', null),
    ...message(time + 2000, 2, 1, 1e6, 0, 0),
  ]))
  const between = seriesPayload(betweenTurns, { currency: 'CNY' })
  assert.deepEqual(
    between.map((node) => [node.kind, node.turn, node.step]),
    [['step', 1, 1], ['compaction', 1, null], ['step', 2, 1]],
    'a compaction naming no Turn belongs to the Turn it rewrote',
  )
})

test('a compaction before the first Turn stays turn-less and still counts', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...compaction(time, 'cmp-1', null),
    ...message(time + 2000, 1, 1, 1e6, 0, 0),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  assert.deepEqual(nodes.map((node) => node.kind), ['compaction', 'step'])
  assert.equal(nodes[0].turn, null, 'there is no Turn to anchor it to')
  assert.equal(nodes[0].cost, 1.2)
  assert.equal(unit.wire.view(state).cost, 3.2, 'and its money is in the estimate like any other node')
})

test('a replayed compaction summary is not billed twice', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const events = sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    ...compaction(time + 1000, 'cmp-1', null),
  ])
  const once = fold(unit, events)
  const twice = fold(unit, [...events, ...sequenced(compaction(time + 1000, 'cmp-1', null))])
  assert.equal(unit.wire.view(twice).cost, unit.wire.view(once).cost)
  assert.equal(seriesPayload(twice, { currency: 'CNY' }).length, 2)
})

test('a Compaction step holds no call, no retry and no spawn, and survives a checkpoint', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...message(time, 1, 1, 1e6, 0, 0),
    ...compaction(time + 1000, 'cmp-1', null),
    { type: 'subagent/catalog', time: time + 1500, data: { childId: 'child-1', childCreatedAt: time + 1000, mode: 'sync', label: 'scout' } },
    { type: 'tool/call', time: time + 1600, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' } },
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  const [step, bill] = nodes
  assert.deepEqual(bill.calls, [])
  assert.equal(bill.retries, 0)
  assert.equal(bill.interrupted, false)
  assert.equal(bill.unpriced, false)
  assert.deepEqual(bill.children, [], 'a spawn belongs to a Step, never to a compaction')
  assert.deepEqual(step.children.map((child) => child.id), ['child-1'], 'the Step that ran the call keeps it')
  assert.deepEqual(step.calls.map((call) => call.callId), ['call-1'])

  const parsed = unit.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.equal(parsed.lastTurn, 1)
  assert.equal(parsed.compactions.length, 1)
  assert.equal(seriesPayload(parsed, { currency: 'CNY' }).length, 2, 'the node survives a JSON checkpoint')
  const broken = structuredClone(state)
  broken.pendingCompactions[0].compaction = { model: 'deepseek-flash', shadowedTokenCount: 1 }
  assert.throws(() => unit.stateSchema.parse(JSON.parse(JSON.stringify(broken))), 'a compaction node needs its id')
})

/** One priced Step, so a case can assert the rest of the series survived. */
const pricedStep = (time, turn, step) => message(time, turn, step, 1e6, 0, 0)

test('an event with no data contributes nothing and leaves the rest of the session priced', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  // Every family that reads `event.data`, with the field missing entirely: one of
  // these used to throw out of the fold, and the Host answers a throw from the fold
  // with `unknown-session` for the whole session.
  const headless = [
    { type: 'request/header', time },
    { type: 'request/context', time },
    { type: 'step/start', time },
    { type: 'step/end', time },
    { type: 'llm/retry-started', time },
    { type: 'tool/call', time },
    { type: 'assistant/message', time },
    { type: 'assistant/attempt', time },
    { type: 'subagent/catalog', time },
    { type: 'compaction/summary', time },
  ]
  const state = fold(unit, sequenced([
    ...pricedStep(time, 1, 1),
    ...headless,
    ...pricedStep(time + 2000, 1, 2),
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  const view = unit.wire.view(state)
  assert.deepEqual(nodes.map((node) => [node.turn, node.step, node.cost]), [
    [1, 1, 2],
    [1, 2, 2],
  ], 'only the two real Steps are in the series, each priced as before')
  assert.equal(view.cost, 4)
  assert.equal(view.steps, 2)
  assert.equal(nodes.reduce((sum, node) => sum + node.cost, 0), view.cost, 'the sum invariant still holds exactly')
  unit.stateSchema.parse(JSON.parse(JSON.stringify(state)), 'and the state is still one it can checkpoint')
})

test('a partially shaped event contributes nothing, and a located Step with no usage still opens its node', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const unlocatable = [
    { type: 'request/header', time, data: { header: {} } },
    { type: 'request/context', time, data: {} },
    { type: 'step/start', time, data: { turn: 1 } },
    { type: 'step/start', time, data: { turn: null, step: 1 } },
    { type: 'step/start', time, data: { turn: '1', step: 1 } },
    { type: 'step/start', time, data: { turn: 1, step: -1 } },
    { type: 'assistant/message', time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6 } } },
  ]
  const state = fold(unit, sequenced([
    ...pricedStep(time, 1, 1),
    ...unlocatable,
    // A Step that opened and was never priced is a node of the series all the same:
    // the series has one node per `(Turn, Step)`, not one per priced Step.
    { type: 'step/start', time: time + 1000, data: { turn: 1, step: 2 } },
    ...pricedStep(time + 2000, 2, 1),
    // A compaction is placed by its own id, not by a location, so it is still a node
    // when it names no usable Turn — and it lands on the Turn whose context it rewrote.
    { type: 'compaction/summary', time: time + 2500, data: { compactionId: 'cmp-1', turn: 'two' } },
  ]))
  const nodes = seriesPayload(state, { currency: 'CNY' })
  const view = unit.wire.view(state)
  assert.deepEqual(nodes.map((node) => [node.kind, node.turn, node.step, node.hasUsage, node.cost]), [
    ['step', 1, 1, true, 2],
    ['step', 1, 2, false, 0],
    ['step', 2, 1, true, 2],
    ['compaction', 2, null, false, 0],
  ], 'only the located Step opened a node, it is visible with no cost, and the compaction kept its own rule')
  assert.equal(view.cost, 4, 'the unlocatable report is not billed onto a Step that never made it')
  assert.equal(view.steps, 3, 'a Compaction step is not a Step the reader walks through')
  assert.equal(nodes.reduce((sum, node) => sum + node.cost, 0), view.cost, 'the sum invariant still holds exactly')
  unit.stateSchema.parse(JSON.parse(JSON.stringify(state)), 'and no node was written the schema would refuse')
})

test('a tool call whose own fields are missing is still the call the log recorded', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const state = fold(unit, sequenced([
    ...pricedStep(time, 1, 1),
    { type: 'tool/call', time: time + 500, data: { turn: 1, step: 1, name: null, callId: null, arguments: null } },
  ]))
  const [node] = seriesPayload(state, { currency: 'CNY' })
  assert.deepEqual(node.calls.map((call) => [call.name, call.callId, call.preview]), [['', '', '']])
  assert.equal(node.cost, 2, 'a call prices nothing, so the money is unchanged')
})

test('a fault in the fold is still a fault, not an empty series', () => {
  const unit = projection()
  const time = bjt(2026, 9, 24, 10, 0)
  const events = pricedStep(time, 1, 1)
  // A malformed event is skipped by a shape check; a state whose own internals are
  // broken is our bug, and must still throw rather than fold into an empty series.
  const broken = { ...unit.init(), byModel: null }
  assert.throws(() => fold(unit, events.reduce((state) => broken, unit.init())), TypeError)
  const throwingConfig = makeSessionCostProjection(() => { throw new Error('the rule is unreadable') })
  assert.throws(() => fold(throwingConfig, events), /the rule is unreadable/)
})
