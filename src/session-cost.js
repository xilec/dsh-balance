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
 * Every Step is priced under the three **Tariff projections**: `fact` (each report
 * at the tariff in force at its own instant), `offPeak` and `peak` (every report at
 * the off-peak or peak rate of the table in force then). The projections are derived
 * from the stored buckets on every read rather than stored, so entering a fallback
 * rate reprices the whole history — including the running aggregates, which carry the
 * rule they were priced with and are rebuilt from the series when that rule changes.
 *
 * @module dsh-balance/session-cost
 */
import { z } from 'zod'
import { appendChunkedList, chunkedListSchema, iterateChunkedList } from '@deepseek-ai/dsh-chunked-list'
import { costOfTokens, modelClass, priceAt } from './pricing.js'

/** Client-visible projection key carrying this session's estimated cost. */
export const SESSION_COST_KEY = 'dshBalanceCost'

/** The three Tariff projections every Step is priced under, `fact` first. */
export const TARIFF_PROJECTIONS = Object.freeze(['fact', 'offPeak', 'peak'])

/**
 * The peak rate of one model, from the config.
 *
 * A rate the reader entered for a model wins, whatever the model is; otherwise the
 * global `fallbackPrices` applies, which the Host hands over already gated by
 * `priceUnknownModels` (`undefined` when unknown models must stay unpriced).
 *
 * @param config - the live plugin config.
 * @returns `(model) => rate | undefined`, in peak rates per 1M tokens.
 */
export function makeFallbackResolver(config = {}) {
  const table = new Map()
  for (const [model, rate] of Object.entries(config.fallbackRates ?? {})) {
    if (rate !== null && typeof rate === 'object') table.set(String(model).toLowerCase(), rate)
  }
  return (model) => {
    const own = table.get(typeof model === 'string' ? model.toLowerCase() : '')
    if (own !== undefined) return own
    return config.fallbackPrices
  }
}

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
  /** Log sequence of the event that reported it; the export orders and cites by it. */
  seq: z.number().int().nonnegative().optional(),
})

/** One tool call inside a Step, with the short argument preview the view shows. */
const callSchema = z.object({
  name: z.string(),
  callId: z.string(),
  preview: z.string(),
  /** Instant and log sequence of the call event; the export cites both. */
  time: z.number().optional(),
  seq: z.number().int().nonnegative().optional(),
})

/**
 * One subagent spawn seen on this session: the catalog fact the harness appends
 * to the *parent* log, with the child's creation instant and the instant the fact
 * itself was written. The Step is derived from these times when the series is
 * read (D41), because a background child is catalogued after its Step ended.
 */
const spawnSchema = z.object({
  id: z.string(),
  mode: z.string(),
  label: z.string(),
  createdAt: z.number(),
  time: z.number(),
  /** Log sequence of the catalog fact; the export cites the spawn by it. */
  seq: z.number().int().nonnegative().optional(),
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
  /**
   * The Tariff rule the aggregates below were priced with. When the live rule no
   * longer matches, the aggregates are rebuilt from the series before they are
   * read or advanced, which is how a fallback rate reprices the whole history.
   */
  ruleKey: z.string(),
  totals: bucketsSchema,
  cost: z.number(),
  byModel: z.record(z.string(), z.object({ buckets: bucketsSchema, cost: z.number() })),
  order: z.array(z.string()),
  unpriced: z.array(z.string()),
  /**
   * Subagents this session spawned, in the order the catalog facts arrived. The
   * child's own money never enters `totals` or `cost` (D25): this is the record
   * of the spawn, and the child's series is a separate, explicit read (D26).
   */
  spawns: z.array(spawnSchema).optional(),
  /**
   * Events below this sequence belong to the parent a forked child was seeded
   * with. They are folded into nothing here: a child's line is its own work.
   */
  inheritedEventCount: z.number().int().nonnegative().optional(),
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

/**
 * The money of one usage report, split per bucket and rounded once per bucket.
 *
 * Both the running aggregates and the series describe a Step through this helper,
 * so the chip's total, a node's total and a node's per-bucket rows are sums of the
 * very same six-decimal terms and agree exactly instead of to within a rounding
 * of a rounding (the invariant the Cost view's table relies on).
 *
 * @returns `{ buckets, cost }`, or null when no rate prices the report.
 */
function pricedReport(report, rate) {
  if (rate === null) return null
  const buckets = zero()
  for (const key of BUCKET_KEYS) {
    buckets[key] = round6(costOfTokens({ ...zero(), [key]: report.buckets[key] ?? 0 }, rate))
  }
  return { buckets, cost: round6(BUCKET_KEYS.reduce((total, key) => total + buckets[key], 0)) }
}

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
  const fallbackFor = () => makeFallbackResolver(getConfig())
  const priceOf = (model, timeMs, phase = 'fact') => {
    const config = getConfig()
    return priceAt(model, timeMs, {
      currency: config.currency,
      holidays: config.holidays,
      fallback: fallbackFor()(model),
      phase,
    })
  }

  /** Everything a price depends on, as one comparable value. */
  const ruleKeyOf = () => {
    const config = getConfig()
    return JSON.stringify([
      config.currency ?? null,
      config.holidays ?? null,
      config.fallbackPrices ?? null,
      config.fallbackRates ?? null,
    ])
  }

  /**
   * The empty state, carrying the count of events this session inherited.
   *
   * A forked child is seeded with its parent's completed turns, and those events
   * are in the child's log with the parent's sequence numbers: folding them would
   * bill the child for the parent's work and read the parent's spawns as its own.
   *
   * @param _header - the session header, unused: the count is what matters.
   * @param inheritedEventCount - events below this sequence belong to the parent.
   */
  const init = (_header, inheritedEventCount = 0) => ({
    model: null,
    series: undefined,
    pending: null,
    committed: 0,
    ruleKey: ruleKeyOf(),
    totals: zero(),
    cost: 0,
    byModel: {},
    order: [],
    unpriced: [],
    spawns: [],
    inheritedEventCount: Number.isInteger(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0,
    seq: 0,
  })

  /** Add or subtract one report's attribution in the client-visible aggregates. */
  const shift = (state, report, sign) => {
    const priced = pricedReport(report, priceOf(report.model, report.time))
    const cost = priced === null ? 0 : priced.cost
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
    const unpriced = priced === null && !state.unpriced.includes(report.model)
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

    const report = { model: priced, time, buckets, seq: typeof event.seq === 'number' ? event.seq : 0 }
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
        calls: [...node.calls, {
          name: String(name ?? ''),
          callId: String(callId ?? ''),
          preview: previewOf(args),
          time,
          seq: typeof event.seq === 'number' ? event.seq : 0,
        }],
      },
    }
  }

  /**
   * Record one subagent spawn as the parent's own catalog fact.
   *
   * The event names the child and its creation instant, not the Step that caused
   * it, and a background child is catalogued after its Step has ended — so the
   * Step is derived when the series is read rather than at fold time (D41). A
   * child catalogued twice is kept once, and one established outside any Step is
   * still kept, because the export needs the spawn even when no Step owns it.
   */
  const withSpawn = (state, event) => {
    const { childId, childCreatedAt, mode, label } = event.data ?? {}
    if (typeof childId !== 'string' || childId === '') return state
    const spawns = state.spawns ?? []
    if (spawns.some((spawn) => spawn.id === childId)) return state
    const time = typeof event.time === 'number' ? event.time : 0
    return {
      ...state,
      spawns: [...spawns, {
        id: childId,
        mode: typeof mode === 'string' ? mode : 'unknown',
        label: typeof label === 'string' ? label : '',
        createdAt: typeof childCreatedAt === 'number' && Number.isFinite(childCreatedAt) ? childCreatedAt : time,
        time,
        seq: typeof event.seq === 'number' ? event.seq : 0,
      }],
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

  /**
   * Rebuild the running aggregates from the stored reports under the live rule.
   *
   * The state keeps raw buckets and event times (decision D8), so repricing after
   * a fallback-rate change is exact rather than approximate: only the aggregates
   * are rewritten, the series itself is untouched.
   */
  const reprice = (state) => {
    const fresh = {
      ...state, ruleKey: ruleKeyOf(), totals: zero(), cost: 0, byModel: {}, order: [], unpriced: [],
    }
    return seriesNodes(state).reduce(
      (carried, node) => node.reports.reduce((inner, report) => shift(inner, report, 1), carried),
      fresh,
    )
  }

  /** The state priced with the live rule; the aggregates are rebuilt when it moved. */
  const current = (state) => (state.ruleKey === ruleKeyOf() ? state : reprice(state))

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
    if (event.type === 'subagent/catalog') return withSpawn(state, event)
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
    // A forked child carries its parent's completed turns as inherited events:
    // they are the parent's work, already billed there, and reading them here
    // would double-count the child's line (and adopt the parent's spawns).
    if (typeof event.seq === 'number' && event.seq < (state.inheritedEventCount ?? 0)) return state
    const base = current(state)
    const next = reduce(base, event)
    if (next === base) return base
    return { ...next, seq: typeof event.seq === 'number' ? event.seq : next.seq }
  }

  const view = (state) => {
    const config = getConfig()
    const priced = current(state)
    const costByModel = {}
    for (const [model, entry] of Object.entries(priced.byModel)) {
      if (entry.cost > 0) costByModel[model] = round6(entry.cost)
    }
    return {
      cost: round6(Math.max(0, priced.cost)),
      currency: config.currency,
      models: priced.order,
      costByModel,
      tokens: priced.totals,
      unpriced: priced.unpriced,
      peakNow: priceOf('deepseek-flash', Date.now())?.peak ?? false,
      seq: priced.seq,
      steps: priced.committed + (priced.pending === null ? 0 : 1),
    }
  }

  return {
    key: SESSION_COST_KEY,
    stateVersion: 5,
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
 * Attach every spawn to the Step that caused it.
 *
 * The catalog fact names the child and its creation instant but not the Step, and
 * a background child is catalogued after its Step has ended, so the Step is chosen
 * by time: the one whose interval holds the creation instant, else the last Step
 * that had already started, else the first. That keeps a background spawn on the
 * Step that ran the tool call instead of on whatever Step happened to be open
 * while the fact was written.
 *
 * @param nodes - every node of the series, oldest first.
 * @param spawns - the spawns the state recorded (`{ id, createdAt, time, ... }`).
 * @returns one array of spawns per node, in the same order.
 */
function attachSpawns(nodes, spawns) {
  const attached = nodes.map(() => [])
  if (nodes.length === 0) return attached
  for (const spawn of spawns) {
    const at = Number.isFinite(spawn.createdAt) && spawn.createdAt > 0 ? spawn.createdAt : spawn.time
    let chosen = -1
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      // An interval holds the instant; an open Step holds everything after its start.
      if (node.tStart <= at && (node.tEnd === null || node.tEnd === undefined || at <= node.tEnd)) {
        chosen = index
        break
      }
      if (node.tStart <= at) chosen = index
    }
    if (chosen < 0) chosen = 0
    attached[chosen].push(spawn)
  }
  return attached
}

/**
 * The per-Step series as the Cost view consumes it: every node priced under the
 * live rule and under the two other Tariff projections, with its buckets, its
 * calls, its subagent spawns and its flags.
 *
 * @param state - the projection state (`sessionProjections.stateOf`).
 * @param options - `currency`, `holidays` of the Tariff rule and `fallback`:
 * either a `(model) => peak rates | undefined` resolver or one rate object.
 * @returns an array of step records, oldest first.
 */
export function seriesPayload(state, options = {}) {
  const nodes = seriesNodes(state)
  const spawns = attachSpawns(nodes, state.spawns ?? [])
  return nodes.map((node, index) => describeNode(node, { ...options, children: spawns[index] }))
}

/**
 * Round the money of one priced report, the way a printed row is rounded (D5).
 *
 * @param buckets - the priced buckets of one report.
 * @returns the same keys, each rounded.
 */
function roundBuckets(buckets) {
  const rounded = {}
  for (const key of BUCKET_KEYS) rounded[key] = round6(buckets[key])
  return rounded
}

/**
 * Round the per-bucket money of every projection and sum each one.
 *
 * One Step and one child session go through this same chain, which is what makes
 * their figures comparable: the per-report figures are already rounded, so a
 * printed row sums exactly into the total that prints above it (D5).
 *
 * @param bucketCost - `{ fact, offPeak, peak }` of raw bucket sums.
 * @returns `{ rounded, costs }`, each keyed by projection.
 */
function roundProjections(bucketCost) {
  const rounded = {}
  const costs = {}
  for (const projection of TARIFF_PROJECTIONS) {
    rounded[projection] = BUCKET_KEYS.reduce(
      (acc, key) => ({ ...acc, [key]: round6(bucketCost[projection][key]) }),
      zero(),
    )
    costs[projection] = round6(BUCKET_KEYS.reduce((total, key) => total + rounded[projection][key], 0))
  }
  return { rounded, costs }
}

/**
 * One session's own figures, summed from its already-priced Steps.
 *
 * Used for a subagent's line: the child is priced by the very same rule and the
 * very same rounding as the parent, so its total is comparable with the Step
 * that spawned it — and it is added to nothing (D25).
 *
 * @param nodes - step records from `seriesPayload`.
 * @returns the totals, the bucket sums per projection and the span of the Steps.
 */
export function subtreeSummary(nodes) {
  const totals = zero()
  const bucketCost = { fact: zero(), offPeak: zero(), peak: zero() }
  const models = new Set()
  let unpriced = false
  let tStart = null
  let tEnd = null
  for (const node of nodes ?? []) {
    for (const key of BUCKET_KEYS) totals[key] += node.buckets?.[key] ?? 0
    for (const model of Object.keys(node.byModel ?? {})) models.add(model)
    if (node.unpriced === true) unpriced = true
    if (tStart === null || node.tStart < tStart) tStart = node.tStart
    if (tEnd === null || node.tEnd > tEnd) tEnd = node.tEnd
    for (const projection of TARIFF_PROJECTIONS) {
      const money = projectionOfNode(node, projection)
      for (const key of BUCKET_KEYS) bucketCost[projection][key] += money.costByBucket[key] ?? 0
    }
  }
  const { rounded, costs } = roundProjections(bucketCost)
  return {
    steps: Array.isArray(nodes) ? nodes.length : 0,
    tokens: BUCKET_KEYS.reduce((acc, key) => ({ ...acc, [key]: totals[key] }), zero()),
    models: [...models],
    unpriced,
    tStart: tStart ?? 0,
    tEnd: tEnd ?? 0,
    cost: costs.fact,
    costByBucket: rounded.fact,
    offPeak: { cost: costs.offPeak, costByBucket: rounded.offPeak },
    peak: { cost: costs.peak, costByBucket: rounded.peak },
  }
}

/** The money of one node under a projection, `fact` included. */
function projectionOfNode(node, projection) {
  if (projection === 'fact') {
    return { cost: node.cost ?? 0, costByBucket: node.costByBucket ?? zero() }
  }
  const entry = node[projection]
  return entry ?? { cost: 0, costByBucket: zero() }
}

/** One report's rate under a projection, with the fallback already resolved. */
function rateFor(report, options, fallback, phase) {
  return priceAt(report.model, report.time, {
    currency: options.currency,
    holidays: options.holidays,
    fallback,
    phase,
  })
}

function describeNode(node, options) {
  const resolve = typeof options.fallback === 'function' ? options.fallback : () => options.fallback
  /**
   * Price one report under the three projections.
   *
   * A live report and an attempt a retry evicted are priced the same way, so the
   * export can show what the lost attempt would have cost without the client ever
   * touching a rate (D28, D45).
   */
  const projectionsOf = (report) => {
    const fallback = resolve(report.model)
    const rate = rateFor(report, options, fallback, 'fact')
    const costs = {}
    for (const projection of TARIFF_PROJECTIONS) {
      const priced = pricedReport(report, rateFor(report, options, fallback, projection))
      costs[projection] = {
        cost: round6(priced?.cost ?? 0),
        costByBucket: priced === null ? zero() : roundBuckets(priced.buckets),
      }
    }
    return { rate, costs }
  }
  /** One report as the export reads it: its own instant, sequence and money (D45). */
  const pricedReportRecord = (report) => {
    const { costs } = projectionsOf(report)
    return {
      model: report.model,
      time: report.time,
      buckets: report.buckets,
      seq: report.seq ?? 0,
      cost: costs.fact.cost,
      costByBucket: costs.fact.costByBucket,
      offPeak: { cost: costs.offPeak.cost, costByBucket: costs.offPeak.costByBucket },
      peak: { cost: costs.peak.cost, costByBucket: costs.peak.costByBucket },
    }
  }
  const byModel = {}
  let buckets = zero()
  let unpriced = false
  let unknownModel = false
  const bucketCost = { fact: zero(), offPeak: zero(), peak: zero() }
  for (const report of node.reports) {
    const fallback = resolve(report.model)
    const rate = rateFor(report, options, fallback, 'fact')
    if (rate === null) unpriced = true
    if (modelClass(report.model) === null) unknownModel = true
    buckets = add(buckets, report.buckets)
    // The table in the Cost view shows where the money went per bucket, and the
    // rate that priced the Step is the host's: the client never splits it itself.
    // Every projection is priced here for the same reason — the client only draws.
    for (const projection of TARIFF_PROJECTIONS) {
      const projected = pricedReport(report, projection === 'fact' ? rate : rateFor(report, options, fallback, projection))
      if (projected === null) continue
      bucketCost[projection] = add(bucketCost[projection], projected.buckets)
    }
    const previous = byModel[report.model] ?? { buckets: zero(), cost: 0 }
    byModel[report.model] = {
      buckets: add(previous.buckets, report.buckets),
      cost: round6(previous.cost + (pricedReport(report, rate)?.cost ?? 0)),
    }
  }
  const last = node.reports[node.reports.length - 1]
  // The per-report figures are already rounded, so summing them and rounding the
  // result changes nothing: a Step's cost is exactly the sum of its printed rows,
  // and the session total is exactly the sum of its Steps.
  const { rounded, costs } = roundProjections(bucketCost)
  return {
    turn: node.turn,
    step: node.step,
    tStart: node.tStart,
    tEnd: node.tEnd ?? (last === undefined ? node.tStart : last.time),
    ended: node.ended,
    hasUsage: node.hasUsage,
    interrupted: node.interrupted,
    retries: node.retries,
    evicted: node.evicted.map(pricedReportRecord),
    reports: node.reports.map(pricedReportRecord),
    calls: node.calls,
    /** Subagents spawned by this Step; empty on every other Step. */
    children: options.children ?? [],
    buckets,
    byModel,
    cost: costs.fact,
    costByBucket: rounded.fact,
    offPeak: { cost: costs.offPeak, costByBucket: rounded.offPeak },
    peak: { cost: costs.peak, costByBucket: rounded.peak },
    unpriced,
    unknownModel,
  }
}
