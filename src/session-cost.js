/**
 * Per-session cost projection: tokens reported by the provider, priced by the
 * rates in force at the instant each sample was taken, kept as a per-Step series.
 *
 * Pricing at the *event's* time (not at read time) is the point of this unit:
 * a session that started during a peak window and finished off-peak, or one that
 * ran on a weekend, must not be priced wholesale by whatever tariff happens to be
 * current when the chip is rendered.
 *
 * The fold mirrors the harness's own `tokenUsage` unit: the last usage sample of
 * a `(turn, step)` replaces the earlier one instead of accumulating, and
 * `llm/retry-started` closes that replacement slot so a retried attempt counts
 * once. Unlike `tokenUsage`, the evicted attempt is *not* kept in the money total
 * — it is retained on the node as a retry, for the tooltip and the export.
 *
 * On top of that fold the unit keeps `dshBalanceCost`'s **per-Step series**: one
 * node per `(turn, step)` holding its usage reports, its tool calls and its flags.
 * The running aggregates the client view needs stay incremental, so a usage event
 * produces the next view in O(1); the series itself is an append-only chunked list
 * (the current node is kept aside until the next Step opens), which is what the
 * Cost view's route reads.
 *
 * @module dsh-balance/session-cost
 */
import { z } from 'zod'
import { appendChunkedList, chunkedListSchema, iterateChunkedList } from '@deepseek-ai/dsh-chunked-list'
import { costOfTokens, modelClass, priceAt } from './pricing.js'

/** Client-visible projection key carrying this session's estimated cost. */
export const SESSION_COST_KEY = 'dshBalanceCost'

const bucketsSchema = z.object({
  uncachedInput: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
})

/** One usage report: the raw material a Step's cost is computed from. */
const reportSchema = z.object({
  model: z.string(),
  time: z.number(),
  buckets: bucketsSchema,
})

/** One tool call inside a Step, with the short argument preview the view shows. */
const callSchema = z.object({
  name: z.string(),
  callId: z.string(),
  preview: z.string(),
})

/**
 * One `(turn, step)` node: every usage report of the Step, the reports a retry
 * evicted, the calls of the Step and its flags. `slotOpen` is the replacement
 * slot: `true` means the newest report may still be restated, `false` means a
 * retry closed it and the next report accumulates.
 */
const nodeSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  tStart: z.number(),
  tEnd: z.number().nullable(),
  ended: z.boolean(),
  hasUsage: z.boolean(),
  interrupted: z.boolean(),
  retries: z.number().int().nonnegative(),
  slotOpen: z.boolean(),
  reports: z.array(reportSchema),
  evicted: z.array(reportSchema),
  calls: z.array(callSchema),
})

const stateSchema = z.object({
  model: z.string().nullable(),
  series: chunkedListSchema(nodeSchema).optional(),
  pending: nodeSchema.nullable(),
  committed: z.number().int().nonnegative(),
  totals: bucketsSchema,
  cost: z.number(),
  byModel: z.record(z.string(), z.object({ buckets: bucketsSchema, cost: z.number() })),
  order: z.array(z.string()),
  unpriced: z.array(z.string()),
  seq: z.number().int().nonnegative(),
})

const viewSchema = z.object({
  cost: z.number(),
  currency: z.string(),
  models: z.array(z.string()),
  costByModel: z.record(z.string(), z.number()),
  tokens: bucketsSchema,
  unpriced: z.array(z.string()),
  /** Tariff in force right now, for the tooltip's time-aware hint. */
  peakNow: z.boolean(),
  /** Sequence of the last event that changed this projection, for live tails. */
  seq: z.number().int().nonnegative(),
  /** Steps in the series, the in-progress one included. */
  steps: z.number().int().nonnegative(),
}).strict()

const zero = () => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** The four token buckets, in the order the Cost view reads them. */
const BUCKET_KEYS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']

const add = (a, b) => ({
  uncachedInput: a.uncachedInput + b.uncachedInput,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
})

const sub = (a, b) => ({
  uncachedInput: a.uncachedInput - b.uncachedInput,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  output: a.output - b.output,
})

const sameBuckets = (a, b) =>
  a.uncachedInput === b.uncachedInput && a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite && a.output === b.output

/** Token buckets of one usage report. */
const bucketsOf = (usage) => ({
  uncachedInput: usage.inputTokens ?? 0,
  cacheRead: usage.cacheReadTokens ?? 0,
  cacheWrite: usage.cacheWriteTokens ?? 0,
  output: usage.outputTokens ?? 0,
})

const round6 = (n) => Math.round(n * 1e6) / 1e6

/** The last `usage` chunk of a streamed assistant settlement, if any. */
function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return null
}

/** The usage a durable assistant settlement reports for its attempt, if any. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  return lastUsageChunk(event.data.stream)
}

/**
 * The preview the view shows for a call: up to `maxLines` lines of a command or
 * argument list, at most `limit` characters, with the long whitespace collapsed.
 *
 * @param text - the raw arguments string.
 * @param limit - characters kept before the ellipsis.
 * @param maxLines - line breaks kept; further lines are dropped.
 */
function previewOf(text, limit = 200, maxLines = 3) {
  if (typeof text !== 'string') return ''
  // Tool arguments arrive as JSON, where a newline is the two characters `\n`:
  // decode the escaped ones so a command's lines really are lines in the view.
  const decoded = text.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '  ')
  const lines = decoded.replace(/\r/g, '').split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
  const kept = lines.slice(0, maxLines).join('\n').replace(/^\n+/, '')
  return kept.length <= limit ? kept : `${kept.slice(0, limit - 1)}…`
}

/**
 * Build the session-cost projection definition.
 *
 * @param getConfig - reads the live plugin config (currency, holidays, fallbacks).
 * @returns a projection unit ready for `ctx.sessionProjections.register`.
 */
export function makeSessionCostProjection(getConfig) {
  const priceOf = (model, timeMs) => {
    const config = getConfig()
    return priceAt(model, timeMs, {
      currency: config.currency,
      holidays: config.holidays,
      fallback: config.fallbackPrices,
    })
  }

  const init = () => ({
    model: null,
    series: undefined,
    pending: null,
    committed: 0,
    totals: zero(),
    cost: 0,
    byModel: {},
    order: [],
    unpriced: [],
    seq: 0,
  })

  /** Add or subtract one report's attribution in the client-visible aggregates. */
  const shift = (state, report, sign) => {
    const rate = priceOf(report.model, report.time)
    const cost = rate === null ? 0 : costOfTokens(report.buckets, rate)
    const entry = state.byModel[report.model]
    let byModel = state.byModel
    if (sign > 0) {
      const previous = entry ?? { buckets: zero(), cost: 0 }
      byModel = {
        ...state.byModel,
        [report.model]: { buckets: add(previous.buckets, report.buckets), cost: round6(previous.cost + cost) },
      }
    } else if (entry !== undefined) {
      const buckets = sub(entry.buckets, report.buckets)
      const next = round6(entry.cost - cost)
      if (next <= 0 && sameBuckets(buckets, zero())) {
        const { [report.model]: _dropped, ...rest } = state.byModel
        byModel = rest
      } else {
        byModel = { ...state.byModel, [report.model]: { buckets, cost: next } }
      }
    }
    const isNew = sign > 0 && entry === undefined && !state.order.includes(report.model)
    const unpriced = rate === null && !state.unpriced.includes(report.model)
    return {
      ...state,
      totals: sign > 0 ? add(state.totals, report.buckets) : sub(state.totals, report.buckets),
      cost: round6(state.cost + sign * cost),
      byModel,
      order: isNew ? [...state.order, report.model] : state.order,
      unpriced: unpriced ? [...state.unpriced, report.model] : state.unpriced,
    }
  }

  const blankNode = (turn, step, time) => ({
    turn,
    step,
    tStart: time,
    tEnd: null,
    ended: false,
    hasUsage: false,
    interrupted: false,
    retries: 0,
    slotOpen: true,
    reports: [],
    evicted: [],
    calls: [],
  })

  /**
   * Park a node for `(turn, step)`, committing the previous one to the series.
   * The pending node is what lets a restated report or a late tool call land on
   * the right Step without rewriting an immutable chunked list.
   */
  const openNode = (state, turn, step, time) => {
    const pending = state.pending
    if (pending !== null && pending.turn === turn && pending.step === step) return state
    const committed = pending === null
      ? {}
      : { series: appendChunkedList(state.series, pending), committed: state.committed + 1 }
    return { ...state, ...committed, pending: blankNode(turn, step, time) }
  }

  /** Fold one usage report into its node and the aggregates. */
  const withReport = (state, event, usage, turn, step, model) => {
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const buckets = bucketsOf(usage)
    const priced = model ?? 'unknown'
    const opened = openNode(state, turn, step, time)
    const node = opened.pending
    const last = node.slotOpen && node.reports.length > 0 ? node.reports[node.reports.length - 1] : null
    if (last !== null && last.model === priced && sameBuckets(last.buckets, buckets)) return state

    const report = { model: priced, time, buckets }
    let next = opened
    let reports = node.reports
    if (last !== null) {
      next = shift(next, last, -1)
      reports = [...node.reports.slice(0, -1), report]
    } else {
      reports = [...node.reports, report]
    }
    next = shift(next, report, 1)
    return {
      ...next,
      pending: { ...next.pending, tEnd: time, hasUsage: true, slotOpen: true, reports },
    }
  }

  /** Close the replacement slot of a node, moving its newest report to the retries. */
  const withRetry = (state, turn, step) => {
    const node = state.pending
    if (node === null || node.turn !== turn || node.step !== step) return state
    if (!node.slotOpen || node.reports.length === 0) {
      return { ...state, pending: { ...node, retries: node.retries + 1, slotOpen: false } }
    }
    const report = node.reports[node.reports.length - 1]
    const shifted = shift(state, report, -1)
    return {
      ...shifted,
      pending: {
        ...node,
        retries: node.retries + 1,
        slotOpen: false,
        reports: node.reports.slice(0, -1),
        evicted: [...node.evicted, report],
      },
    }
  }

  /** Attach a tool call to its Step, opening the node if nothing else has. */
  const withCall = (state, event) => {
    const { turn, step, callId, name, arguments: args } = event.data
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const opened = openNode(state, turn, step, time)
    const node = opened.pending
    if (node.calls.some((call) => call.callId === callId)) return state
    return {
      ...opened,
      pending: {
        ...node,
        calls: [...node.calls, { name: String(name ?? ''), callId: String(callId ?? ''), preview: previewOf(args) }],
      },
    }
  }

  /** Close the pending node: its Step cannot receive anything else. */
  const withStepEnd = (state, turn, step, time) => {
    const node = state.pending
    if (node === null || node.turn !== turn || node.step !== step) return state
    return { ...state, pending: { ...node, tEnd: time, ended: true } }
  }

  /** Commit the pending node without ending it (a new Turn starts). */
  const flush = (state) => {
    if (state.pending === null) return state
    return {
      ...state,
      series: appendChunkedList(state.series, state.pending),
      pending: null,
      committed: state.committed + 1,
    }
  }

  /** The fold proper; `apply` stamps `seq` on every state it actually changes. */
  const reduce = (state, event) => {
    if (event.type === 'request/header') {
      const selected = event.data.header?.config?.model
      if (typeof selected !== 'string' || selected === '' || selected === state.model) return state
      return { ...state, model: selected }
    }
    if (event.type === 'request/context') {
      const selected = event.data.model
      if (typeof selected !== 'string' || selected === '' || selected === state.model) return state
      return { ...state, model: selected }
    }
    if (event.type === 'step/start') {
      const { turn, step } = event.data
      const time = typeof event.time === 'number' ? event.time : Date.now()
      return openNode(state, turn, step, time)
    }
    if (event.type === 'step/end') {
      const { turn, step } = event.data
      return withStepEnd(state, turn, step, typeof event.time === 'number' ? event.time : Date.now())
    }
    if (event.type === 'turn/end') return flush(state)
    if (event.type === 'llm/retry-started') return withRetry(state, event.data.turn, event.data.step)
    if (event.type === 'tool/call') return withCall(state, event)
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const { turn, step } = event.data
      const usage = usageOf(event)
      let next = state
      if (event.type === 'assistant/message' && event.data.interrupted === true) {
        const node = next.pending
        if (node !== null && node.turn === turn && node.step === step && !node.interrupted) {
          next = { ...next, pending: { ...node, interrupted: true } }
        }
      }
      if (usage === null || usage === undefined) return next
      return withReport(next, event, usage, turn, step, next.model)
    }
    return state
  }

  const apply = (state, event) => {
    const next = reduce(state, event)
    if (next === state) return state
    return { ...next, seq: typeof event.seq === 'number' ? event.seq : next.seq }
  }

  const view = (state) => {
    const config = getConfig()
    const costByModel = {}
    for (const [model, entry] of Object.entries(state.byModel)) {
      if (entry.cost > 0) costByModel[model] = round6(entry.cost)
    }
    return {
      cost: round6(Math.max(0, state.cost)),
      currency: config.currency,
      models: state.order,
      costByModel,
      tokens: state.totals,
      unpriced: state.unpriced,
      peakNow: priceOf('deepseek-flash', Date.now())?.peak ?? false,
      seq: state.seq,
      steps: state.committed + (state.pending === null ? 0 : 1),
    }
  }

  return {
    key: SESSION_COST_KEY,
    stateVersion: 2,
    stateSchema,
    init,
    apply,
    wire: { viewSchema, view },
  }
}

/** Every node of the series, oldest first, the in-progress one last. */
function seriesNodes(state) {
  const nodes = []
  for (const node of iterateChunkedList(state.series)) nodes.push(node)
  if (state.pending !== null) nodes.push(state.pending)
  return nodes
}

/**
 * The per-Step series as the Cost view consumes it: every node priced under the
 * live rule, with its buckets, its calls and its flags.
 *
 * @param state - the projection state (`sessionProjections.stateOf`).
 * @param options - `currency`, `holidays` and `fallback` of the Tariff rule.
 * @returns an array of step records, oldest first.
 */
export function seriesPayload(state, options = {}) {
  return seriesNodes(state).map((node) => describeNode(node, options))
}

function describeNode(node, options) {
  const byModel = {}
  let buckets = zero()
  let cost = 0
  let unpriced = false
  let unknownModel = false
  const costByBucket = zero()
  for (const report of node.reports) {
    const rate = priceAt(report.model, report.time, options)
    const reportCost = rate === null ? 0 : costOfTokens(report.buckets, rate)
    if (rate === null) unpriced = true
    if (modelClass(report.model) === null) unknownModel = true
    cost += reportCost
    buckets = add(buckets, report.buckets)
    // The table in the Cost view shows where the money went per bucket, and the
    // rate that priced the Step is the host's: the client never splits it itself.
    for (const key of BUCKET_KEYS) {
      costByBucket[key] += rate === null ? 0 : costOfTokens({ ...zero(), [key]: report.buckets[key] ?? 0 }, rate)
    }
    const previous = byModel[report.model] ?? { buckets: zero(), cost: 0 }
    byModel[report.model] = { buckets: add(previous.buckets, report.buckets), cost: round6(previous.cost + reportCost) }
  }
  const last = node.reports[node.reports.length - 1]
  // The per-bucket figures are rounded once, and the Step's cost is their exact
  // sum: the table in the Cost view then adds up line by line instead of showing
  // a total that its own rows cannot reproduce.
  const roundedBuckets = BUCKET_KEYS.reduce((acc, key) => ({ ...acc, [key]: round6(costByBucket[key]) }), zero())
  return {
    turn: node.turn,
    step: node.step,
    tStart: node.tStart,
    tEnd: node.tEnd ?? (last === undefined ? node.tStart : last.time),
    ended: node.ended,
    hasUsage: node.hasUsage,
    interrupted: node.interrupted,
    retries: node.retries,
    evicted: node.evicted.map((report) => ({ model: report.model, time: report.time, buckets: report.buckets })),
    calls: node.calls,
    buckets,
    byModel,
    cost: round6(BUCKET_KEYS.reduce((total, key) => total + roundedBuckets[key], 0)),
    costByBucket: roundedBuckets,
    unpriced,
    unknownModel,
  }
}
