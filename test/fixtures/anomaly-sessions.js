/**
 * Anomaly scenarios for the Indicator tests.
 *
 * Every scenario is an event list folded through the *real* projection, so the
 * prices, the buckets and the node fields the detectors read are the ones the Host
 * would produce: a fixture cannot drift from the model it is supposed to exercise.
 *
 * The peak instant is a Thursday inside the Beijing peak window, where a Flash Step
 * costs 2 CNY per 1M uncached input tokens and 8 CNY per 1M output tokens; the
 * weekend instant prices the same tokens at half, which is what the
 * `tariff-attributable` scenario turns on.
 */
import { makeSessionCostProjection, seriesPayload } from '../../src/session-cost.js'
import { BJT_OFFSET_MS } from '../../src/pricing.js'

export const bjt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - BJT_OFFSET_MS

/** Thursday 10:00 Beijing: inside the peak window, so Flash is at its peak rate. */
export const PEAK = bjt(2026, 9, 24, 10, 0)
/** Saturday 10:00 Beijing: off-peak all day, whatever the hour. */
export const WEEKEND = bjt(2026, 9, 26, 10, 0)

const config = () => ({ currency: 'CNY', holidays: undefined, fallbackPrices: undefined })

/** One Step: its start, its usage report, its calls and its retries, in log order. */
export function step({
  at, turn, step: index, model = 'deepseek-flash',
  input = 0, cacheRead = 0, cacheWrite = 0, output = 0,
  calls = [], retries = 0,
}) {
  const events = [
    { type: 'step/start', time: at, data: { turn, step: index } },
    { type: 'request/header', time: at, data: { header: { config: { model } } } },
  ]
  for (let n = 0; n < retries; n += 1) {
    events.push({ type: 'llm/retry-started', time: at, data: { turn, step: index } })
  }
  events.push({
    type: 'assistant/message',
    time: at + 1,
    data: {
      turn,
      step: index,
      usage: { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output },
    },
  })
  for (const call of calls) {
    events.push({
      type: 'tool/call',
      time: at + 2,
      data: { turn, step: index, callId: call.id, name: call.name, arguments: call.arguments },
    })
  }
  events.push({ type: 'step/end', time: at + 3, data: { turn, step: index } })
  return events
}

/** One compaction: the summarizing call is what carries the bill. */
export function compaction({ at, id, turn = null, model = 'deepseek-flash', input = 2e5, output = 1e5, shadowedTokenCount = 5e5 }) {
  return [
    { type: 'compaction/start', time: at, data: { compactionId: id, turn } },
    {
      type: 'compaction/summary',
      time: at + 500,
      data: {
        compactionId: id,
        turn,
        model,
        shadowedTokenCount,
        usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output },
      },
    },
    { type: 'compaction/end', time: at + 900, data: { compactionId: id, turn } },
  ]
}

/** Fold an event list through the real projection and read the series it produces. */
export function seriesOf(events) {
  const projection = makeSessionCostProjection(() => config())
  // The scenario builders hand over the events of several Steps at once, so the list
  // is flattened here rather than at every call site.
  const flat = events.flat(Infinity)
  const state = flat.reduce(
    (carried, event, index) => projection.apply(carried, { ...event, seq: index + 1 }),
    projection.init(),
  )
  return { nodes: seriesPayload(state, { currency: 'CNY' }), view: projection.wire.view(state), state, projection }
}

/** `count` Steps of nearly equal cost: a stable median with a non-zero MAD. */
export const steadyRun = (count, { at = PEAK, turn = 1, from = 0 } = {}) => Array.from({ length: count }, (_, index) => {
  const input = [1e6, 1.05e6, 1.1e6][index % 3]
  return step({ at: at + (from + index) * 1000, turn, step: from + index + 1, input })
})

/**
 * The scenarios the Indicator tests read. Each returns the series of one session;
 * scenarios that need a subtree cost supply it separately in the test.
 */
export const scenarios = {
  /** Nine Steps around a median of 2.1 CNY, then one Step twenty times that. */
  spike: () => seriesOf([
    ...steadyRun(9),
    ...step({ at: PEAK + 20000, turn: 2, step: 1, input: 2e7 }),
  ]),
  /** Nine short answers, then one enormous one. */
  'verbose-output': () => seriesOf([
    ...Array.from({ length: 9 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, output: 1000 })),
    ...step({ at: PEAK + 12000, turn: 2, step: 1, input: 1e5, output: 200000 }),
  ]),
  /** Twelve Steps whose cost climbs by half a CNY each. */
  'context-growth': () => seriesOf(Array.from({ length: 12 }, (_, index) => step({
    at: PEAK + index * 1000, turn: 1, step: index + 1, input: 3e5 + index * 3e5,
  }))),
  /** One Step that was retried twice. */
  'retry-storm': () => seriesOf([
    ...steadyRun(8),
    ...step({ at: PEAK + 20000, turn: 2, step: 1, input: 1e6, retries: 2 }),
  ]),
  /** Eight steady Steps, a compaction, then a Step whose cache had to be rebuilt. */
  'post-compaction-spike': () => seriesOf([
    ...steadyRun(8),
    ...compaction({ at: PEAK + 12000, id: 'cmp-1' }),
    ...step({ at: PEAK + 13000, turn: 2, step: 1, input: 1e6, cacheWrite: 4e6 }),
  ]),
  /** Three Steps in a row that resend their context instead of reading a cache. */
  'cache-miss': () => seriesOf([
    ...Array.from({ length: 6 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, cacheRead: 9e5 })),
    ...Array.from({ length: 3 }, (_, index) => step({ at: PEAK + (index + 6) * 1000, turn: 1, step: index + 7, input: 1e6, cacheRead: 0 })),
  ]),
  /** A tool result that the next Step pays for as input. */
  'tool-output-inflation': () => seriesOf([
    ...steadyRun(6),
    ...step({ at: PEAK + 10000, turn: 2, step: 1, input: 1e5, calls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"big.log"}' }] }),
    ...step({ at: PEAK + 11000, turn: 2, step: 2, input: 1e6 }),
    ...steadyRun(3, { at: PEAK + 12000, turn: 2, from: 2 }),
  ]),
  /** A session that lives entirely inside the peak window. */
  'tariff-attributable': () => seriesOf(steadyRun(8)),
  /** The same shape on a Saturday: nothing disappears off-peak. */
  'off-peak': () => seriesOf(steadyRun(8, { at: WEEKEND })),
  /** One model the Tariff rule cannot price. */
  'pricing-gap': () => seriesOf([
    ...steadyRun(6),
    ...step({ at: PEAK + 10000, turn: 2, step: 1, model: 'reseller-model', input: 1e6, output: 1e6 }),
    ...steadyRun(2, { at: PEAK + 11000, turn: 2, from: 1 }),
  ]),
  /** Five Steps only: an order statistic over them is not a norm. */
  'short-session': () => seriesOf([
    ...steadyRun(4),
    ...step({ at: PEAK + 20000, turn: 2, step: 1, input: 2e7 }),
  ]),
  /** A quiet session: nothing in it should be reported. */
  calm: () => seriesOf(steadyRun(10)),
}
