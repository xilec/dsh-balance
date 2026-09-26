/**
 * Per-session cost projection: tokens reported by the provider, priced by the
 * rates in force at the instant each sample was taken.
 *
 * Pricing at the *event's* time (not at read time) is the point of this unit:
 * a session that started during a peak window and finished off-peak, or one that
 * ran on a weekend, must not be priced wholesale by whatever tariff happens to be
 * current when the chip is rendered.
 *
 * The fold mirrors the harness's own `tokenUsage` unit: the last usage sample of
 * a `(turn, step)` replaces the earlier one instead of accumulating, and
 * `llm/retry-started` closes that slot so a retried attempt counts once.
 *
 * @module dsh-balance/session-cost
 */
import { z } from 'zod'
import { costOfTokens, priceAt } from './pricing.js'

/** Client-visible projection key carrying this session's estimated cost. */
export const SESSION_COST_KEY = 'dshBalanceCost'

const bucketsSchema = z.object({
  uncachedInput: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
})

const lastSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  model: z.string(),
  buckets: bucketsSchema,
  cost: z.number(),
  time: z.number(),
})

const stateSchema = z.object({
  model: z.string().nullable(),
  last: lastSchema.nullable(),
  totals: bucketsSchema,
  cost: z.number(),
  byModel: z.record(z.string(), z.object({ buckets: bucketsSchema, cost: z.number() })),
  order: z.array(z.string()),
  unpriced: z.array(z.string()),
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
}).strict()

const zero = () => ({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

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
 * Build the session-cost projection definition.
 *
 * @param getConfig - reads the live plugin config (currency, holidays, fallbacks).
 * @returns a projection unit ready for `ctx.sessionProjections.register`.
 */
export function makeSessionCostProjection(getConfig) {
  const price = (model, timeMs) => {
    const config = getConfig()
    return priceAt(model, timeMs, {
      currency: config.currency,
      holidays: config.holidays,
      fallback: config.fallbackPrices,
    })
  }

  const init = () => ({
    model: null,
    last: null,
    totals: zero(),
    cost: 0,
    byModel: {},
    order: [],
    unpriced: [],
  })

  const apply = (state, event) => {
    let model = state.model
    if (event.type === 'request/header') {
      const selected = event.data.header?.config?.model
      if (typeof selected === 'string' && selected !== '') model = selected
    } else if (event.type === 'request/context') {
      const selected = event.data.model
      if (typeof selected === 'string' && selected !== '') model = selected
    }

    if (event.type === 'llm/retry-started') {
      const { turn, step } = event.data
      if (state.last === null || state.last.turn !== turn || state.last.step !== step) {
        return model === state.model ? state : { ...state, model }
      }
      // The retried attempt replaces the failed one: drop its attribution.
      return {
        ...state,
        model,
        last: null,
        totals: sub(state.totals, state.last.buckets),
        cost: round6(state.cost - state.last.cost),
        byModel: replaceModel(state.byModel, state.last.model, state.last.buckets, state.last.cost),
      }
    }

    let usage = null
    let turn = 0
    let step = 0
    if (event.type === 'assistant/chunk' && event.data.chunk?.type === 'usage') {
      ({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      ({ turn, step, usage } = event.data)
    }
    if (usage === null || usage === undefined) {
      return model === state.model ? state : { ...state, model }
    }

    const priced = model ?? 'unknown'
    const buckets = bucketsOf(usage)
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const replaced = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
    if (replaced !== null && replaced.model === priced && sameBuckets(replaced.buckets, buckets)) {
      return model === state.model ? state : { ...state, model }
    }

    const rate = price(priced, time)
    const cost = rate === null ? 0 : costOfTokens(buckets, rate)
    const unpriced = rate === null && !state.unpriced.includes(priced)
      ? [...state.unpriced, priced]
      : state.unpriced

    let totals = state.totals
    let byModel = state.byModel
    let total = state.cost
    if (replaced !== null) {
      totals = sub(totals, replaced.buckets)
      total -= replaced.cost
      byModel = replaceModel(byModel, replaced.model, replaced.buckets, replaced.cost)
    }
    totals = add(totals, buckets)
    total += cost
    const previous = byModel[priced] ?? { buckets: zero(), cost: 0 }
    byModel = {
      ...byModel,
      [priced]: { buckets: add(previous.buckets, buckets), cost: previous.cost + cost },
    }
    const order = priced in state.byModel || state.order.includes(priced) ? state.order : [...state.order, priced]

    return {
      model,
      last: { turn, step, model: priced, buckets, cost, time },
      totals,
      cost: round6(total),
      byModel,
      order,
      unpriced,
    }
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
      peakNow: price('deepseek-flash', Date.now())?.peak ?? false,
    }
  }

  return {
    key: SESSION_COST_KEY,
    stateVersion: 1,
    stateSchema,
    init,
    apply,
    wire: { viewSchema, view },
  }
}

/** Subtract one sample's attribution for a model, dropping the entry at zero. */
function replaceModel(byModel, model, buckets, cost) {
  const previous = byModel[model]
  if (previous === undefined) return byModel
  const nextBuckets = sub(previous.buckets, buckets)
  const nextCost = round6(previous.cost - cost)
  if (nextCost <= 0 && sameBuckets(nextBuckets, zero())) {
    const { [model]: _dropped, ...rest } = byModel
    return rest
  }
  return { ...byModel, [model]: { buckets: nextBuckets, cost: nextCost } }
}
