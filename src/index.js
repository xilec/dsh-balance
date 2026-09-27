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
import { buildLedger } from './history.js'
import {
  OFF_PEAK_RATIO, PUBLIC_HOLIDAYS_2026, RULE_SOURCE_URL, RULE_VERIFIED_ON,
  nextChange, peakSchedule, peakState, phaseAt, priceAt, utcWindowsLabel, windowsOfLocalDay,
} from './pricing.js'
import { SESSION_COST_KEY, makeSessionCostProjection } from './session-cost.js'
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
})

/** Keys a runtime settings write may change, with the check each value must pass. */
const MUTABLE_SETTINGS = {
  currency: (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value.toUpperCase()),
  dayZone: (value) => typeof value === 'string' && value !== '',
  refreshIntervalMs: (value) => Number.isFinite(value) && value >= 15000,
  clientPollIntervalMs: (value) => Number.isFinite(value) && value >= 2000,
  warningThreshold: (value) => Number.isFinite(value) && value >= 0,
  dangerThreshold: (value) => Number.isFinite(value) && value >= 0,
  historyDays: (value) => Number.isInteger(value) && value >= 3 && value <= 400,
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
      if (state.client !== null && typeof state.client === 'object') clientHello = { ...clientHello, ...state.client }
      const prefs = state.prefs ?? {}
      for (const [key, check] of Object.entries(MUTABLE_SETTINGS)) {
        if (prefs[key] !== undefined && check(prefs[key])) {
          runtime[key] = key === 'currency' ? String(prefs[key]).toUpperCase() : prefs[key]
          uiPrefs[key] = runtime[key]
        }
      }
      log(`loaded ${samples.length} samples, ${Object.keys(overrides).length} overrides, ${Object.keys(uiPrefs).length} panel settings`)
    } catch (error) {
      warn(`cannot read history: ${message(error)}`)
    } finally {
      loaded = true
    }
  }
  const ready = load()

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

  const resetLoop = () => {
    if (loopTimer !== null) clearTimeout(loopTimer)
    const tick = () => {
      void refresh().then(() => {
        const delay = cache.error === 'api-key-missing' ? 30000 : runtime.refreshIntervalMs
        loopTimer = setTimeout(tick, delay)
      })
    }
    loopTimer = setTimeout(tick, 500)
  }

  ctx.effect(() => {
    resetLoop()
    return () => {
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

  /** The live config the session-cost projection prices with. */
  const projectionConfig = () => ({ ...runtime, currency: effectiveCurrency() })

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
    keepDays: runtime.keepDays,
  })

  const buildPayload = (sessionId, zone = 'local') => ({
    host: { version: VERSION, now: Date.now(), dir, samples: samples.length, loaded },
    balance: balancePayload(),
    ledger: ledgerPayload(),
    peak: peakPayload(zone),
    prices: pricePayload(),
    fallbackPrices: runtime.priceUnknownModels ? runtime.fallbackPrices : null,
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
          // The instant matters: the ledger adds only the samples that arrive after
          // it, so a corrected day keeps filling instead of freezing.
          overrides = { ...overrides, [date]: { amount: Math.round(amount * 1e6) / 1e6, at: Date.now() } }
        }
        if (!loaded) await ready
        await persist()
        sendJson(res, 200, { ok: true, overrides, ledger: ledgerPayload() })
    })

    postRoute('/dsh-balance/settings', 'dsh-balance: settings route', async (body, res) => {
        const changed = []
        for (const [key, check] of Object.entries(MUTABLE_SETTINGS)) {
          if (body[key] === undefined) continue
          if (!check(body[key])) {
            sendJson(res, 400, { ok: false, error: `${key} rejected` })
            return
          }
          runtime[key] = key === 'currency' ? String(body[key]).toUpperCase() : body[key]
          uiPrefs[key] = runtime[key]
          changed.push(key)
        }
        if (changed.includes('refreshIntervalMs')) resetLoop()
        if (changed.length > 0) await persist()
        sendJson(res, 200, { ok: true, changed, sampling: { refreshIntervalMs: runtime.refreshIntervalMs, clientPollIntervalMs: runtime.clientPollIntervalMs } })
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

const VERSION = '0.1.0'

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
