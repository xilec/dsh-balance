/**
 * dsh-balance — Host half.
 *
 * Two jobs:
 *
 * 1. **Account balance history.** Polls `GET /user/balance`, keeps every sample
 *    on disk, and turns the differences between samples into a spend ledger
 *    (1 day / 1 week / 1 month) plus a per-day table the user can correct by
 *    hand. The balance is the only ground truth DeepSeek exposes, so this is the
 *    number the chip leads with; per-day rows exist to place those totals in time.
 * 2. **Session cost estimate.** Registers a `sessionProjections` unit that prices
 *    the token usage the provider reports, each sample at the instant it was
 *    taken, which is what keeps weekend and holiday sessions off peak.
 *
 * The browser half only reads the cached payload from `/dsh-balance`; it never
 * talks to DeepSeek itself.
 *
 * @module dsh-balance
 */
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { buildLedger, calibrationOf } from './history.js'
import { textRecordsOf } from './export-text.js'
import {
  OFF_PEAK_RATIO, PUBLIC_HOLIDAYS_2026, RULE_SOURCE_URL, RULE_VERIFIED_ON,
  nextChange, peakIntervalsBetween, peakSchedule, phaseAt, priceAt, rateSchedule,
  utcWindowsLabel, windowsOfLocalDay,
} from './pricing.js'
import { createFindingsMemo, detectFindings, normalizeAnomalies } from './indicators.js'
import { SESSION_COST_KEY, makeFallbackResolver, makeSessionCostProjection, seriesPayload, subtreeSummary } from './session-cost.js'
import { appendSample, readSamplesCompacting, readState, writeState } from './store.js'

export const name = 'dsh-balance'

/** How often a fetch is treated as sampled even when the balance did not move. */
const HEARTBEAT_MS = 30 * 60 * 1000

/** Upper bound on samples held in memory (roughly a year at a 5 minute cadence). */
const MAX_SAMPLES = 200_000

/** Plugin configuration; every field is overridable from the profile patch row. */
export const Config = Schema.object({
  /** Explicit DeepSeek API key. Empty falls back to {@link Config.apiKeyRef}. */
  apiKey: Schema.string().default(''),
  /** Credential (or environment variable) name holding the key. */
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY'),
  /** DeepSeek API base URL. */
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  /** Per-request timeout. */
  timeoutMs: Schema.number().min(1000).default(8000),
  /** How often the Host polls the balance endpoint. */
  refreshIntervalMs: Schema.number().min(15000).default(300000),
  /** How often the browser half re-reads the cached payload. */
  clientPollIntervalMs: Schema.number().min(2000).default(15000),
  /** Account currency the ledger is read in. */
  currency: Schema.string().default('USD'),
  /** Day boundary zone for the ledger: `local`, or an IANA zone name. */
  dayZone: Schema.string().default('local'),
  /** Day rows kept and shown (1 day / 1 week / 1 month roll up from them). */
  historyDays: Schema.number().min(3).max(400).default(30),
  /** Full-resolution sample retention before hourly thinning. */
  keepDays: Schema.number().min(7).max(3650).default(120),
  /** Balance below which the chip turns amber. */
  warningThreshold: Schema.number().min(0).default(10),
  /** Balance below which the chip turns red. */
  dangerThreshold: Schema.number().min(0).default(5),
  /**
   * Chinese public holidays (Beijing-time dates) billed off peak. Defaults to
   * the published 2026 list; a new year needs a new list.
   */
  holidays: Schema.array(Schema.string()).default([...PUBLIC_HOLIDAYS_2026]),
  /** Whether models outside the built-in rate table are priced by `fallbackPrices`. */
  priceUnknownModels: Schema.boolean().default(false),
  /** Rates per 1M tokens used for unknown models when pricing them is enabled. */
  fallbackPrices: Schema.object({
    cacheHit: Schema.number().min(0).default(0.02),
    cacheMiss: Schema.number().min(0).default(1),
    output: Schema.number().min(0).default(4),
  }).default({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
  /**
   * Peak rates per 1M tokens entered by the reader, keyed by model id. They win
   * over `fallbackPrices` and price the model even when `priceUnknownModels` is
   * off; the off-peak rate is half and cache write is billed as a cache miss.
   */
  fallbackRates: Schema.dict(Schema.object({
    cacheHit: Schema.number().min(0).default(0),
    cacheMiss: Schema.number().min(0).default(0),
    output: Schema.number().min(0).default(0),
  })).default({}),
  /**
   * Cost-anomaly Indicators: the Sensitivity preset and per-Indicator threshold
   * overrides. They are plugin configuration rather than a live panel setting,
   * and the effective values travel with the series so the view can explain a
   * Finding without deriving a threshold of its own.
   */
  anomalies: Schema.object({
    preset: Schema.string().default('balanced'),
    thresholds: Schema.dict(Schema.any()).default({}),
  }).default({ preset: 'balanced', thresholds: {} }),
})

/**
 * What one field of a rate entry is worth, or NaN when it is not a rate at all.
 *
 * A hand-written body can hold a blank string, a boolean or a list, and `Number`
 * calls all three zero: the reader would get a model priced by rates nobody typed.
 * Only a number, or a string that reads as one, is a rate.
 */
function rateOf(value) {
  if (typeof value === 'number') return value
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
}

/** A rate map is accepted only when every entry is a set of non-negative numbers. */
function isFallbackRates(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([model, rate]) => model !== '' && rate !== null && typeof rate === 'object' &&
    ['cacheHit', 'cacheMiss', 'output'].every((key) => Number.isFinite(rateOf(rate[key])) && rateOf(rate[key]) >= 0))
}

/** Drop the entries a hand-written settings body got wrong instead of storing them. */
function normalizeFallbackRates(value) {
  const next = {}
  for (const [model, rate] of Object.entries(value ?? {})) {
    if (!isFallbackRates({ [model]: rate })) continue
    next[model] = {
      cacheHit: Number(rate.cacheHit),
      cacheMiss: Number(rate.cacheMiss),
      output: Number(rate.output),
    }
  }
  return next
}

/** Keys a runtime settings write may change, with the check each value must pass. */
const MUTABLE_SETTINGS = {
  currency: (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value.toUpperCase()),
  dayZone: (value) => typeof value === 'string' && value !== '',
  refreshIntervalMs: (value) => Number.isFinite(value) && value >= 15000,
  clientPollIntervalMs: (value) => Number.isFinite(value) && value >= 2000,
  warningThreshold: (value) => Number.isFinite(value) && value >= 0,
  dangerThreshold: (value) => Number.isFinite(value) && value >= 0,
  historyDays: (value) => Number.isInteger(value) && value >= 3 && value <= 400,
  fallbackRates: isFallbackRates,
}

/** Settings whose stored value is folded into the runtime config, not kept verbatim. */
const SETTING_SHAPES = {
  currency: (value) => String(value).toUpperCase(),
  fallbackRates: normalizeFallbackRates,
}

/**
 * Browser-side choices that have no runtime counterpart: they are stored and
 * echoed back to the client, never applied to the Host config. The Cost view's
 * metric, X axis, Tariff projection, top-K mode and open tab live here — brush
 * and zoom deliberately do not, so reopening the view shows the whole range.
 */
const UI_SETTINGS = {
  costMetric: (value) => ['cost', 'output', 'cacheRead', 'cacheWrite', 'tokens'].includes(value),
  costAxis: (value) => value === 'time' || value === 'index',
  costProjection: (value) => ['fact', 'offPeak', 'peak'].includes(value),
  costTopK: (value) => value === 'steps' || value === 'turns',
  costTab: (value) => value === 'session' || value === 'subagents',
}
export function apply(ctx, config) {
  const runtime = {
    apiKey: config.apiKey ?? '',
    apiKeyRef: config.apiKeyRef ?? 'DEEPSEEK_API_KEY',
    baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
    timeoutMs: config.timeoutMs ?? 8000,
    refreshIntervalMs: config.refreshIntervalMs ?? 300000,
    clientPollIntervalMs: config.clientPollIntervalMs ?? 15000,
    currency: (config.currency ?? 'USD').toUpperCase(),
    dayZone: config.dayZone ?? 'local',
    historyDays: config.historyDays ?? 30,
    keepDays: config.keepDays ?? 120,
    warningThreshold: config.warningThreshold ?? 10,
    dangerThreshold: config.dangerThreshold ?? 5,
    holidays: Array.isArray(config.holidays) ? config.holidays : [...PUBLIC_HOLIDAYS_2026],
    priceUnknownModels: config.priceUnknownModels === true,
    fallbackPrices: { cacheHit: 0.02, cacheMiss: 1, output: 4, ...(config.fallbackPrices ?? {}) },
    fallbackRates: normalizeFallbackRates(config.fallbackRates ?? {}),
    anomalies: config.anomalies ?? { preset: 'balanced', thresholds: {} },
  }

  /** Fold one accepted settings value into the runtime config. */
  const assignSetting = (key, value) => {
    const shape = SETTING_SHAPES[key]
    runtime[key] = shape === undefined ? value : shape(value)
  }

  const log = (message) => {
    try {
      ctx.logger?.info?.(`[dsh-balance] ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-balance] ${message}`)
    } catch {
      /* see above */
    }
  }

  /**
   * The Indicator thresholds in force. A preset and per-Indicator overrides come
   * from the plugin configuration and are resolved once: an unknown id, field or
   * value is dropped with a warning instead of failing the plugin.
   */
  const anomalies = normalizeAnomalies(runtime.anomalies, warn)

  /**
   * Detection is a pure function of the priced series and the thresholds, so the
   * last verdict of one session is worth keeping: the view re-reads the series on
   * every live tail, and the same `seq` under the same rule must not be detected
   * twice. The pricing key is part of it because entering a fallback rate reprices
   * the history without moving `seq`.
   */
  const findingsMemo = createFindingsMemo()

  let dir
  try {
    dir = dshHomePath('dsh-balance')
  } catch (error) {
    warn(`cannot resolve the harness home, keeping history in memory: ${message(error)}`)
    dir = ''
  }

  /** Balance samples, ascending. */
  let samples = []
  /** Manual per-day corrections `{ [YYYY-MM-DD]: amount }`. */
  let overrides = {}
  /**
   * Last browser half that checked in, for the diagnostics line in the card.
   * `reads` counts payload reads, `mounts` counts chip renders — a nonzero
   * `mounts` is how a headless check proves the browser half really rendered.
   */
  let clientHello = { version: null, at: 0, count: 0, reads: 0, mounts: 0 }
  /** Cached balance payload; stays on the last good value when a fetch fails. */
  let cache = { ok: false, balances: [], isAvailable: false, error: null, fetchedAt: 0, stale: false }
  let inflight = null
  let loopTimer = null
  let loaded = false
  /**
   * Settings the user changed from the panel, and only those.
   *
   * The composition row stays the source of truth: a fresh start reads the row,
   * and a persisted value wins only for a key the panel actually wrote. Persisting
   * the whole runtime config instead (as the first draft did) silently shadowed
   * every later edit of the nix row.
   */
  let uiPrefs = {}

  const persist = async () => {
    if (dir === '') return
    try {
      await writeState(dir, {
        version: 1,
        overrides,
        // The last browser half that checked in. Kept on disk so a headless
        // diagnosis can tell whether the client half ever loaded.
        client: clientHello,
        prefs: uiPrefs,
        updatedAt: Date.now(),
      })
    } catch (error) {
      warn(`cannot write state: ${message(error)}`)
    }
  }

  const load = async () => {
    if (dir === '') return
    try {
      const [stored, state] = await Promise.all([
        readSamplesCompacting(dir, { keepDays: runtime.keepDays }),
        readState(dir),
      ])
      samples = stored
      if (state.overrides !== null && typeof state.overrides === 'object') overrides = state.overrides
      // Everything the file holds is taken into memory first: a write triggered
      // below must never put back an empty identity or empty view choices.
      if (state.client !== null && typeof state.client === 'object') clientHello = { ...clientHello, ...state.client }
      const prefs = state.prefs ?? {}
      for (const [key, check] of Object.entries(MUTABLE_SETTINGS)) {
        if (prefs[key] !== undefined && check(prefs[key])) {
          assignSetting(key, prefs[key])
          uiPrefs[key] = runtime[key]
        }
      }
      for (const [key, check] of Object.entries(UI_SETTINGS)) {
        if (prefs[key] !== undefined && check(prefs[key])) uiPrefs[key] = prefs[key]
      }
      if (anchorMissingOverrides()) {
        await persist()
        log('anchored the overrides that predate the balance anchor')
      }
      log(`loaded ${samples.length} samples, ${Object.keys(overrides).length} overrides, ${Object.keys(uiPrefs).length} panel settings`)
    } catch (error) {
      warn(`cannot read history: ${message(error)}`)
    } finally {
      loaded = true
    }
  }
  const ready = load()

  /**
   * Give an override written before anchoring existed the balance of its instant.
   *
   * The first anchored release stored `{ amount, at }` and measured the added spend
   * by summing the intervals that followed — which is why the entry has no balance.
   * The sample log still holds the balance of that moment, so filling it in keeps
   * the day filling instead of freezing it, and a later edit would do the same by
   * hand.
   *
   * @returns whether anything changed, so the caller can persist the upgrade.
   */
  const anchorMissingOverrides = () => {
    let changed = false
    const next = {}
    for (const [date, value] of Object.entries(overrides)) {
      if (value === null || typeof value !== 'object' || value.balance !== undefined) {
        next[date] = value
        continue
      }
      const at = Number(value.at)
      if (!Number.isFinite(at)) {
        next[date] = value
        continue
      }
      const sample = sampleAtOrBefore(at)
      if (sample === null) {
        next[date] = value
        continue
      }
      next[date] = { ...value, balance: sample.total }
      changed = true
    }
    if (changed) overrides = next
    return changed
  }

  /** The newest sample at or before an instant, preferring the account currency. */
  const sampleAtOrBefore = (at) => {
    let fallback = null
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const sample = samples[index]
      if (sample.t > at) continue
      if (fallback === null) fallback = sample
      if (sample.currency === runtime.currency) return sample
    }
    return fallback
  }

  const resolveKey = async () => {
    if (runtime.apiKey !== '') return runtime.apiKey
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(runtime.apiKeyRef)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') return hit.value
      } catch {
        /* an unresolved reference falls through to the environment */
      }
    }
    return process.env[runtime.apiKeyRef] ?? ''
  }

  /** Append one sample when it carries news (a new value, or the heartbeat). */
  const recordSample = async (balances, at) => {
    const info = balances.find((entry) => entry.currency === runtime.currency) ?? balances[0]
    if (info === undefined) return
    const previous = samples.length > 0 ? samples[samples.length - 1] : null
    const sameCurrency = previous !== null && previous.currency === info.currency
    const unchanged = sameCurrency && previous.total === info.total && previous.granted === info.granted && previous.toppedUp === info.toppedUp
    if (unchanged && at - previous.t < HEARTBEAT_MS) return
    const sample = {
      t: at,
      currency: info.currency,
      total: info.total,
      granted: info.granted,
      toppedUp: info.toppedUp,
    }
    samples.push(sample)
    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES)
    if (dir === '') return
    try {
      await appendSample(dir, sample)
    } catch (error) {
      warn(`cannot append a sample: ${message(error)}`)
    }
  }

  const refresh = () => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const key = await resolveKey()
      if (key === '') {
        cache = { ...cache, ok: false, error: 'api-key-missing', stale: cache.fetchedAt > 0 }
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), runtime.timeoutMs)
      try {
        const response = await fetch(`${runtime.baseUrl.replace(/\/+$/, '')}/user/balance`, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`DeepSeek API HTTP ${response.status}`)
        const data = await response.json()
        const balances = normalizeBalances(data)
        const at = Date.now()
        cache = {
          ok: true,
          balances,
          isAvailable: data?.is_available === true,
          error: null,
          fetchedAt: at,
          stale: false,
        }
        if (!loaded) await ready
        await recordSample(balances, at)
      } catch (error) {
        const message_ = message(error)
        if (cache.error !== message_) warn(`balance fetch failed: ${message_}`)
        cache = { ...cache, ok: cache.fetchedAt > 0, error: message_, stale: true }
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** Set once the plugin is disposed: a tick in flight must not schedule another. */
  let loopStopped = false

  const resetLoop = () => {
    if (loopTimer !== null) clearTimeout(loopTimer)
    const tick = () => {
      void refresh().then(() => {
        if (loopStopped) return
        const delay = cache.error === 'api-key-missing' ? 30000 : runtime.refreshIntervalMs
        loopTimer = setTimeout(tick, delay)
      })
    }
    loopTimer = setTimeout(tick, 500)
  }

  ctx.effect(() => {
    loopStopped = false
    resetLoop()
    return () => {
      loopStopped = true
      if (loopTimer !== null) clearTimeout(loopTimer)
    }
  }, 'dsh-balance: balance sampling loop')

  /**
   * Live tariff, the next transitions, and the panel's day labels.
   *
   * The browser half renders the countdown itself from `schedule` (absolute
   * instants, so a one-second tick needs no polling), and receives `windows` already
   * converted into the reader's zone — the rule and the zone arithmetic stay on the
   * Host, where the same module also prices the sessions.
   */
  const peakPayload = (zone) => {
    const now = Date.now()
    const state = phaseAt(now, runtime.holidays)
    return {
      peak: state.peak,
      phase: state.phase,
      reason: state.reason,
      untilMs: state.untilMs,
      changeAt: state.changeAtMs,
      changeToPeak: state.changeToPeak,
      nextPeakAt: state.nextPeakAtMs,
      schedule: peakSchedule(now, runtime.holidays),
      offPeakRatio: OFF_PEAK_RATIO,
      zone,
      windows: {
        today: windowsOfLocalDay(now, runtime.holidays, zone, 0),
        tomorrow: windowsOfLocalDay(now, runtime.holidays, zone, 1),
      },
      rule: {
        sourceUrl: RULE_SOURCE_URL,
        verifiedOn: RULE_VERIFIED_ON,
        holidays: runtime.holidays,
        utcWindows: utcWindowsLabel(),
      },
    }
  }

  /** A zone the browser asked for, or the Host's own when it cannot be used. */
  const requestZone = (value) => {
    if (typeof value !== 'string' || value === '' || value === 'local') return 'local'
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date())
      return value
    } catch {
      return 'local'
    }
  }

  const pricePayload = () => {
    const models = ['deepseek-flash', 'deepseek-v4-pro']
    const now = Date.now()
    const atPeak = peakInstant()
    const currency = effectiveCurrency()
    const current = {}
    const peak = {}
    for (const model of models) {
      const options = { currency, holidays: runtime.holidays, fallback: fallback() }
      current[model] = priceAt(model, now, options)
      peak[model] = priceAt(model, atPeak, options)
    }
    return { current, peak, atPeak, currency }
  }

  /** An instant guaranteed to be inside a peak window, for the "peak rate" column. */
  const peakInstant = () => {
    const now = Date.now()
    const change = nextChange(now, runtime.holidays)
    if (change !== null && change.toPeak) return change.atMs
    const forward = now + 60 * 1000
    const next = nextChange(forward, runtime.holidays)
    return next !== null && next.toPeak ? next.atMs : now
  }

  const fallback = () => (runtime.priceUnknownModels ? runtime.fallbackPrices : undefined)

  /** The session's estimated cost, read from the projection this plugin registered. */
  const sessionPayload = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      const store = ctx.get('sessions')
      const projections = ctx.get('sessionProjections')
      if (store === undefined || projections === undefined) return null
      const session = store.get(sessionId)
      if (session === undefined || session === null) return null
      const snapshot = projections.snapshot(session, [SESSION_COST_KEY])
      const value = snapshot?.values?.[SESSION_COST_KEY]
      return value === undefined ? null : value
    } catch (error) {
      warn(`cannot read the session projection: ${message(error)}`)
      return null
    }
  }

  /**
   * The projection state of one session.
   *
   * A session this host owns answers from the live projection. A session that is
   * only open for reading — the usual case in a browser instance that did not
   * start the agent, where `sessions.get` knows nothing — is folded here from its
   * stored log through the same unit, so both paths price with one rule.
   *
   * @param sessionId - the session whose state is read.
   * @returns `{ state }`, or `{ error, detail? }` when it cannot be read.
   */
  const projectionStateOf = async (sessionId) => {
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) return { error: 'projection-unavailable' }
    try {
      const live = ctx.get('sessions')?.get?.(sessionId)
      if (live !== undefined && live !== null) {
        const state = projections.stateOf(live, SESSION_COST_KEY)
        return state === undefined ? { error: 'projection-unavailable' } : { state }
      }
      const query = ctx.get('sessionQuery')
      if (query === undefined) return { error: 'unknown-session' }
      const snapshot = await query.readSession(sessionId)
      // A forked child is seeded with its parent's turns; that prefix is the
      // parent's work, and the fold is told to skip it exactly as the live unit is.
      const empty = storedFold.init(undefined, snapshot.inheritedEventCount ?? 0)
      const state = snapshot.events.reduce((folded, event) => storedFold.apply(folded, event), empty)
      return { state }
    } catch (error) {
      return { error: 'unknown-session', detail: message(error) }
    }
  }

  /**
   * The per-Step series of one session, priced and ready for the Cost view.
   *
   * This is the only route that reads the series, and it answers for exactly the
   * session it was asked about: nothing here enumerates sessions or walks a
   * subtree — subagent sessions get their own route (and their own explicit ask).
   *
   * @param sessionId - the session whose series is requested.
   * @returns the payload, or `{ ok: false, error }` when the session or the
   * projection is not available.
   */
  const seriesPayloadOf = async (sessionId) => {
    const resolved = await projectionStateOf(sessionId)
    if (resolved.error !== undefined) {
      return { ok: false, error: resolved.error, ...(resolved.detail === undefined ? {} : { detail: resolved.detail }) }
    }
    try {
      const state = resolved.state
      const currency = effectiveCurrency()
      const options = {
        currency,
        holidays: runtime.holidays,
        fallback: makeFallbackResolver(projectionConfig()),
      }
      const nodes = seriesPayload(state, options)
      const findings = findingsMemo.read(
        `${sessionId}:${state.seq}:${pricingKey()}:${anomalies.preset}`,
        () => detectFindings(nodes, { anomalies }),
      )
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const fromMs = first === undefined ? Date.now() : first.tStart
      const toMs = last === undefined ? fromMs + 1 : Math.max(last.tEnd, fromMs + 1)
      return {
        ok: true,
        sessionId,
        seq: state.seq,
        currency,
        nodes,
        /** What the Indicators found in this series, and the rules they ran under. */
        findings,
        anomalies: anomaliesPayload(),
        rule: {
          sourceUrl: RULE_SOURCE_URL,
          verifiedOn: RULE_VERIFIED_ON,
          holidays: runtime.holidays,
          rates: rateSchedule(currency),
        },
        peakIntervals: peakIntervalsBetween(fromMs, toMs, runtime.holidays),
        /**
         * What the account as a whole spent while this session was sampled, or
         * `null` when the samples cannot express it (D27).
         */
        calibration: calibrationOf({ samples, fromMs, toMs, currency }),
        /**
         * The session's own title, so the export can name what it is a history of.
         * A session without one reports an empty title, never a fabricated one.
         */
        title: await sessionTitleOf(sessionId),
        /** The view choices this reader saved, so the view opens as they left it. */
        prefs: browserPrefs(),
      }
    } catch (error) {
      warn(`cannot read the session series: ${message(error)}`)
      return { ok: false, error: message(error) }
    }
  }

  /**
   * The title of one session, or `''` when it has none.
   *
   * A title is a nicety of the series payload (the export names its subject with
   * it), so a query service that is absent or cannot fold one is not an error: the
   * figures stand on their own.
   */
  const sessionTitleOf = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (query?.readTitle === undefined) return ''
    try {
      const snapshot = await query.readTitle(sessionId)
      return typeof snapshot?.title === 'string' ? snapshot.title : ''
    } catch {
      return ''
    }
  }

  /**
   * The text of one session's log, for the export's `full` level.
   *
   * The cost projection holds usage and not messages (D20), so the words come from
   * the log itself — read here, normalized, and never truncated: the client owns
   * the 2000-character rule, which keeps one place responsible for the payload
   * (D45, D46). Nothing is written anywhere; the client downloads what it gets.
   *
   * @param sessionId - the session whose text records are requested.
   * @returns `{ ok, records }`, or an error when the log cannot be read.
   */
  const textPayloadOf = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return { ok: false, error: 'query-unavailable' }
    try {
      const snapshot = await query.readSession(sessionId)
      return {
        ok: true,
        sessionId,
        records: textRecordsOf(snapshot.events, snapshot.inheritedEventCount ?? 0),
      }
    } catch (error) {
      warn(`cannot read the session text: ${message(error)}`)
      return { ok: false, error: message(error) }
    }
  }

  /**
   * The subagent tree of one session, each child priced by the same unit.
   *
   * This is the only route that reads other sessions, and it does so only when it
   * is asked: with `full` it walks every session below through `listDescendants`,
   * without it only the direct children are read (D26). Nothing here feeds the
   * parent's total — a child line is a line of its own (D25) — and a child that
   * cannot be read becomes a diagnostic line instead of failing the request, so
   * one corrupt branch does not hide the rest of the tree.
   *
   * @param sessionId - the session whose subtree is requested.
   * @param full - `true` to walk the whole tree, `false` for direct children.
   * @returns the per-child lines, the subtree total and the diagnostics.
   */
  const childrenPayloadOf = async (sessionId, full, signal) => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return { ok: false, error: 'subagents-unavailable' }
    const options = {
      currency: effectiveCurrency(),
      holidays: runtime.holidays,
      fallback: makeFallbackResolver(projectionConfig()),
    }
    let rows
    try {
      rows = full === true
        ? await subagents.listDescendants(sessionId, signal)
        : (await subagents.listChildren(sessionId, signal)).map((entry) => ({ ...entry, parentId: sessionId, depth: 1, kind: 'child' }))
    } catch (error) {
      return { ok: false, error: message(error) }
    }
    const children = []
    const diagnostics = []
    for (const row of rows) {
      // An `unsupported` diagnostic means the catalog entry has an unknown mode:
      // its own log is still readable and still counts, so it becomes a child line
      // marked `unknown` — only a branch that cannot be read is a diagnostic.
      const unsupported = row.kind === 'diagnostic' && row.reason === 'unsupported'
      if (row.kind === 'diagnostic' && !unsupported) {
        diagnostics.push({ id: row.id, parentId: row.parentId, depth: row.depth, reason: row.reason })
        continue
      }
      const resolved = await projectionStateOf(row.id)
      if (resolved.error !== undefined) {
        diagnostics.push({ id: row.id, parentId: row.parentId, depth: row.depth, reason: 'unavailable' })
        continue
      }
      try {
        const summary = subtreeSummary(seriesPayload(resolved.state, options))
        children.push({
          id: row.id,
          parentId: row.parentId,
          depth: row.depth,
          mode: unsupported ? 'unknown' : row.mode,
          label: row.label ?? '',
          // `listDescendants` strips the creation time, so a deep line has none:
          // the client shows its id rather than a 1970 date.
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
          ...(row.activity === undefined ? {} : { activity: row.activity }),
          hasChildren: row.hasChildren === true,
          ...summary,
        })
      } catch (error) {
        diagnostics.push({ id: row.id, parentId: row.parentId, depth: row.depth, reason: 'unreadable' })
        warn(`cannot price the child session ${row.id}: ${message(error)}`)
      }
    }
    const total = subtreeSummary(children.map((child) => ({
      tStart: child.tStart,
      tEnd: child.tEnd,
      buckets: child.tokens,
      byModel: Object.fromEntries(child.models.map((model) => [model, { buckets: child.tokens }])),
      cost: child.cost,
      costByBucket: child.costByBucket,
      offPeak: child.offPeak,
      peak: child.peak,
      unpriced: child.unpriced,
    })))
    /**
     * What the Indicators make of this session *once its subtree is known*: the
     * whole point of `expensive-subtree` is a question only this route can answer,
     * and it is asked only here, so the session route never reports it (I15).
     */
    let findings = []
    try {
      const resolved = await projectionStateOf(sessionId)
      if (resolved.error === undefined) {
        const nodes = seriesPayload(resolved.state, options)
        findings = findingsMemo.read(
          `${sessionId}:${resolved.state.seq}:${pricingKey()}:${anomalies.preset}:subtree:${total.cost}`,
          () => detectFindings(nodes, { anomalies, subtree: { cost: total.cost } }),
        )
      }
    } catch (error) {
      warn(`cannot detect the Indicators of ${sessionId}: ${message(error)}`)
    }
    return {
      ok: true,
      sessionId,
      full: full === true,
      currency: options.currency,
      children,
      diagnostics,
      /**
       * The subtree's own money: a child line carries exactly the shape a Step
       * does here, so the sum is the same sum the parent's own total is. The Step
       * count is the sum of the lines' Steps, not the number of sessions.
       */
      total: { ...total, steps: children.reduce((count, child) => count + child.steps, 0) },
      findings,
      anomalies: anomaliesPayload(),
    }
  }

  /**
   * Currency the account is actually billed in.
   *
   * `currency` in the config is a preference, not a promise: an account topped up
   * in USD answers with USD only, and a ledger read in CNY would silently see
   * (the shell ships against a USD account, so USD is the default preference).
   * nothing. Whatever the endpoint returns is what the samples, the ledger and
   * the rate table follow.
   */
  const effectiveCurrency = () => {
    const match = cache.balances.find((entry) => entry.currency === runtime.currency)
    if (match !== undefined) return match.currency
    return cache.balances[0]?.currency ?? runtime.currency
  }

  /**
   * The live config the session-cost projection prices with. The global fallback
   * is handed over already gated: with `priceUnknownModels` off an unknown model
   * must stay unpriced, which is what the Cost view flags, while a rate the reader
   * entered for that model prices it whatever that flag says.
   */
  const projectionConfig = () => ({ ...runtime, currency: effectiveCurrency(), fallbackPrices: fallback() })

  /**
   * Everything a price depends on, as one comparable value. It is part of the
   * detection memo's key because entering a fallback rate reprices the history
   * without moving the session's `seq`.
   */
  const pricingKey = () => JSON.stringify([
    effectiveCurrency(), runtime.holidays, runtime.fallbackPrices,
    runtime.fallbackRates, runtime.priceUnknownModels,
  ])

  /** The thresholds in force, as the view reads them: it derives none of its own. */
  const anomaliesPayload = () => ({ preset: anomalies.preset, thresholds: anomalies.byId })

  /**
   * The same unit again, unregistered: the series route folds a stored session log
   * with it when this host does not own the session live.
   */
  const storedFold = makeSessionCostProjection(projectionConfig)

  const balancePayload = () => {
    const currency = effectiveCurrency()
    const primary = cache.balances.find((entry) => entry.currency === currency) ?? cache.balances[0] ?? null
    const thresholds = { warning: runtime.warningThreshold, danger: runtime.dangerThreshold }
    return {
      ok: cache.ok && primary !== null,
      error: cache.error,
      stale: cache.stale,
      fetchedAt: cache.fetchedAt,
      isAvailable: cache.isAvailable,
      balances: cache.balances,
      primary,
      currency,
      /** What the config asked for, which the account currency may override. */
      currencyPreference: runtime.currency,
      thresholds,
      /** True when the configured currency is missing from the response. */
      currencyMissing: primary !== null && primary.currency !== runtime.currency,
    }
  }

  const ledgerPayload = () => buildLedger({
    samples,
    overrides,
    currency: effectiveCurrency(),
    zone: runtime.dayZone,
    nowMs: Date.now(),
    days: runtime.historyDays,
  })

  /**
   * The browser-side choices, and only those: the settings the Host applies live
   * in their own payload fields, so this stays the map the Cost view restores from.
   */
  const browserPrefs = () => Object.fromEntries(
    Object.entries(uiPrefs).filter(([key]) => UI_SETTINGS[key] !== undefined),
  )

  const buildPayload = (sessionId, zone = 'local') => ({
    host: { version: VERSION, now: Date.now(), dir, samples: samples.length, loaded },
    balance: balancePayload(),
    ledger: ledgerPayload(),
    peak: peakPayload(zone),
    prices: pricePayload(),
    fallbackPrices: runtime.priceUnknownModels ? runtime.fallbackPrices : null,
    fallbackRates: runtime.fallbackRates,
    /** Choices the panel stored, so the browser restores them on the next mount. */
    prefs: browserPrefs(),
    sampling: {
      refreshIntervalMs: runtime.refreshIntervalMs,
      clientPollIntervalMs: runtime.clientPollIntervalMs,
    },
    client: clientHello,
    session: sessionPayload(sessionId),
  })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeSessionCostProjection(projectionConfig))
  })

  ctx.inject(['webServer'], (webCtx) => {
    const sendJson = (res, status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    /**
     * Register a POST route: the method guard and the JSON body read are the same
     * for every writer, so they live here instead of in each handler. A lenient
     * route (the client heartbeat, the refresh trigger) keeps going with an empty
     * body when the payload is unreadable, because it carries no required fields.
     */
    const postRoute = (path, label, handle, { lenient = false } = {}) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path,
        async handler(req, res) {
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' })
            res.end()
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            if (!lenient) {
              sendJson(res, 400, { ok: false, error: message(error) })
              return
            }
            body = {}
          }
          await handle(body, res)
        },
      }), label)
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-balance',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        if (!loaded) await ready
        const url = new URL(req.url ?? '/dsh-balance', 'http://127.0.0.1')
        const payload = buildPayload(
          url.searchParams.get('sessionId') ?? '',
          requestZone(url.searchParams.get('zone')),
        )
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, payload)
      },
    }), 'dsh-balance: read route')

    postRoute('/dsh-balance/refresh', 'dsh-balance: refresh route', async (body, res) => {
      await refresh()
      sendJson(res, 200, buildPayload(''))
    }, { lenient: true })

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-balance/session-cost',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/dsh-balance/session-cost', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        if (!loaded) await ready
        sendJson(res, 200, await seriesPayloadOf(sessionId))
      },
    }), 'dsh-balance: session cost route')

    // The subtree route. It is a separate registration because it is a separate
    // question: the series route above answers for one session and enumerates
    // nothing, while this one walks the subagent catalog on an explicit ask (D26).
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-balance/session-cost/children',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/dsh-balance/session-cost/children', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        if (!loaded) await ready
        // A tree can be wide and every child is read from its own log, so the walk
        // is cancellable: the reader closing the view stops the work on the Host.
        const abort = new AbortController()
        const cancel = () => abort.abort()
        req.on?.('close', cancel)
        try {
          sendJson(res, 200, await childrenPayloadOf(sessionId, url.searchParams.get('full') === '1', abort.signal))
        } finally {
          req.off?.('close', cancel)
        }
      },
    }), 'dsh-balance: session cost children route')

    // The text route. It exists for the export's `full` level alone (D46): the cost
    // projection holds no messages, so the words come from the session log, and only
    // when the reader asks for them.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-balance/session-cost/text',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/dsh-balance/session-cost/text', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        if (!loaded) await ready
        sendJson(res, 200, await textPayloadOf(sessionId))
      },
    }), 'dsh-balance: session cost text route')

    postRoute('/dsh-balance/hello', 'dsh-balance: client hello route', async (body, res) => {
      const mount = body.phase === 'mount'
      clientHello = {
        version: typeof body.version === 'string' ? body.version : null,
        at: Date.now(),
        count: clientHello.count + 1,
        reads: clientHello.reads + (mount ? 0 : 1),
        mounts: clientHello.mounts + (mount ? 1 : 0),
      }
      void persist()
      sendJson(res, 200, { ok: true, refreshIntervalMs: runtime.refreshIntervalMs, clientPollIntervalMs: runtime.clientPollIntervalMs })
    }, { lenient: true })

    postRoute('/dsh-balance/overrides', 'dsh-balance: overrides route', async (body, res) => {
        // The load owns the maps it restores, so a request that arrives while it is
        // in flight must wait rather than edit a map that is about to be replaced.
        if (!loaded) await ready
        const date = typeof body.date === 'string' ? body.date : ''
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' })
          return
        }
        if (body.amount === null || body.amount === undefined || body.amount === '') {
          delete overrides[date]
        } else {
          const amount = Number(body.amount)
          if (!Number.isFinite(amount) || amount < 0) {
            sendJson(res, 400, { ok: false, error: 'amount must be a non-negative number or null' })
            return
          }
          // The anchor matters: the ledger measures the drop from this balance to
          // the newest sample, so a corrected day keeps filling instead of freezing
          // and a whole day costs one subtraction, not hundreds of additions.
          const currency = effectiveCurrency()
          const anchor = cache.balances.find((entry) => entry.currency === currency) ?? cache.balances[0] ?? null
          overrides = {
            ...overrides,
            [date]: {
              amount: Math.round(amount * 1e6) / 1e6,
              at: Date.now(),
              ...(anchor === null ? {} : { balance: anchor.total }),
            },
          }
        }
        await persist()
        sendJson(res, 200, { ok: true, overrides, ledger: ledgerPayload() })
    })

    postRoute('/dsh-balance/settings', 'dsh-balance: settings route', async (body, res) => {
        if (!loaded) await ready
        const changed = []
        for (const [key, check] of Object.entries(MUTABLE_SETTINGS)) {
          if (body[key] === undefined) continue
          if (!check(body[key])) {
            sendJson(res, 400, { ok: false, error: `${key} rejected` })
            return
          }
          assignSetting(key, body[key])
          uiPrefs[key] = runtime[key]
          changed.push(key)
        }
        for (const [key, check] of Object.entries(UI_SETTINGS)) {
          if (body[key] === undefined) continue
          if (!check(body[key])) {
            sendJson(res, 400, { ok: false, error: `${key} rejected` })
            return
          }
          uiPrefs[key] = body[key]
          changed.push(key)
        }
        if (changed.includes('refreshIntervalMs')) resetLoop()
        if (changed.length > 0) await persist()
        sendJson(res, 200, {
          ok: true,
          changed,
          prefs: browserPrefs(),
          fallbackRates: runtime.fallbackRates,
          sampling: { refreshIntervalMs: runtime.refreshIntervalMs, clientPollIntervalMs: runtime.clientPollIntervalMs },
        })
    })
  })
}

/** Normalize the official balance response into the shape the ledger stores. */
export function normalizeBalances(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  return infos.map((info) => ({
    currency: typeof info?.currency === 'string' && info.currency !== '' ? info.currency.toUpperCase() : 'USD',
    total: amount(info?.total_balance),
    granted: amount(info?.granted_balance),
    toppedUp: amount(info?.topped_up_balance),
  }))
}

const VERSION = '0.2.0'

const amount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const message = (error) => (error instanceof Error ? error.message : String(error))

/** Read a JSON request body with a size and time guard. */
function readJsonBody(req, limitBytes = 1e6, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let body = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy?.()
      reject(new Error('request body timeout'))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > limitBytes) {
        req.destroy?.()
        finish(reject, new Error('payload too large'))
      }
    })
    req.on('end', () => {
      if (body.trim() === '') {
        finish(resolve, {})
        return
      }
      try {
        finish(resolve, JSON.parse(body))
      } catch {
        finish(reject, new Error('invalid JSON'))
      }
    })
    req.on('error', (error) => finish(reject, error))
  })
}
