/**
 * Balance history → spend ledger.
 *
 * The account balance is the only ground truth DeepSeek exposes about money
 * spent (there is no usage or billing API), so the ledger is built from
 * differences between balance samples:
 *
 *   spend(t0..t1) = balance(t0) − balance(t1) + credits(t0..t1)
 *
 * A rising balance is a credit (a top-up, a refund, or a correction) and is
 * recorded as an event rather than counted as negative spend. A falling balance
 * is spend. Both are attributed to the local calendar day of the *later* sample,
 * which for the usual sampling cadence (minutes) is exact; an interval spanning
 * days is marked `coarse`, and per-day overrides exist for exactly that case.
 *
 * Pure module: no imports, no clock, no IO. The caller supplies samples,
 * overrides and "now".
 */

const HOUR_MS = 60 * 60_000

/** Smallest credit worth recording; below this a rising balance is rounding noise. */
const DEFAULT_CREDIT_MIN_DELTA = 0.01

/** Smallest spend worth recording, in the account currency. */
const DEFAULT_SPEND_MIN_DELTA = 0.001

/**
 * Money is rounded to six decimals on the way out.
 *
 * Differences of binary floats otherwise leak artefacts such as
 * `0.11000000000000298` into the day rows and the stored overrides.
 */
const round6 = (value) => Math.round(value * 1e6) / 1e6

/**
 * Calendar fields of an instant in a zone.
 *
 * @param tsMs - epoch milliseconds.
 * @param zone - IANA zone name, or `local`/undefined for the host's own zone.
 * @returns `{ dateKey, hour, minute }`, the key being `YYYY-MM-DD`.
 */
function zoneFields(tsMs, zone) {
  if (!zone || zone === 'local') {
    const d = new Date(tsMs)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return { dateKey: `${d.getFullYear()}-${month}-${day}`, hour: d.getHours(), minute: d.getMinutes() }
  }
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(tsMs))
  } catch {
    return zoneFields(tsMs, 'local')
  }
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  }
}

/** The `YYYY-MM-DD` day key of an instant in a zone. */
export function dayKeyOf(tsMs, zone) {
  return zoneFields(tsMs, zone).dateKey
}

/** The day keys of the `count` days ending at (and including) `endKey`, oldest first. */
export function recentDayKeys(endKey, count) {
  const [y, m, d] = endKey.split('-').map(Number)
  const keys = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(y, m - 1, d))
    date.setUTCDate(date.getUTCDate() - i)
    keys.push(date.toISOString().slice(0, 10))
  }
  return keys
}

/** Keep only the samples of one currency, sorted ascending by time. */
function seriesFor(samples, currency) {
  return (Array.isArray(samples) ? samples : [])
    .filter((s) => s && typeof s.t === 'number' && Number.isFinite(s.t) &&
      typeof s.total === 'number' && Number.isFinite(s.total) &&
      (currency === undefined || s.currency === currency))
    .slice()
    .sort((a, b) => a.t - b.t)
}

/**
 * Fold a balance series into per-interval movements and credit events.
 *
 * @param series - ascending samples of one currency.
 * @param options - `creditMinDelta`, `spendMinDelta`.
 * @returns `{ intervals, credits }`, each interval carrying its spend (0 for a
 * credit interval), the credit amount, and whether it spans more than one day.
 */
export function movements(series, options = {}) {
  const creditMin = options.creditMinDelta ?? DEFAULT_CREDIT_MIN_DELTA
  const spendMin = options.spendMinDelta ?? DEFAULT_SPEND_MIN_DELTA
  const intervals = []
  const credits = []
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]
    const cur = series[i]
    const delta = prev.total - cur.total
    const spend = delta > 0 && delta >= spendMin ? round6(delta) : 0
    const credit = delta < 0 && -delta >= creditMin ? round6(-delta) : 0
    const interval = {
      from: prev.t,
      to: cur.t,
      spend,
      credit,
      fromTotal: prev.total,
      toTotal: cur.total,
    }
    intervals.push(interval)
    if (credit > 0) {
      credits.push({ t: cur.t, amount: credit, fromTotal: prev.total, toTotal: cur.total, intervalFrom: prev.t })
    }
  }
  return { intervals, credits }
}

/**
 * Build the day ledger and the window totals the UI shows.
 *
 * @param options.samples - balance samples `{ t, total, currency, ... }`.
 * @param options.overrides - `{ [YYYY-MM-DD]: amount }`, the user's manual fix
 * for one day; a day present here ignores the sampled value.
 * @param options.currency - account currency to read.
 * @param options.zone - day-boundary zone; `local` (default) or an IANA name.
 * @param options.nowMs - the instant "today" is measured from.
 * @param options.days - how many day rows to produce (default 30).
 * @param options.creditMinDelta - credit noise floor.
 * @returns day rows, credit events, and the 1d/1w/1m totals with their coverage.
 */
export function buildLedger(options) {
  const zone = options.zone ?? 'local'
  const nowMs = options.nowMs ?? Date.now()
  const days = options.days ?? 30
  const overrides = options.overrides ?? {}
  const series = seriesFor(options.samples, options.currency)
  const { intervals, credits } = movements(series, options)
  const todayKey = dayKeyOf(nowMs, zone)
  const keys = recentDayKeys(todayKey, days)

  const sampled = new Map()
  let coarseKeys = new Set()
  for (const interval of intervals) {
    if (interval.spend <= 0) continue
    const fromKey = dayKeyOf(interval.from, zone)
    const toKey = dayKeyOf(interval.to, zone)
    const target = toKey
    sampled.set(target, round6((sampled.get(target) ?? 0) + interval.spend))
    if (fromKey !== toKey) coarseKeys.add(target)
  }

  const rows = keys.map((key) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, key) ? Number(overrides[key]) : null
    const computed = sampled.get(key) ?? 0
    const hasOverride = override !== null && Number.isFinite(override)
    return {
      key,
      spend: hasOverride ? override : computed,
      computed,
      override: hasOverride ? override : null,
      coarse: coarseKeys.has(key),
      /** True when the day ends after the newest sample: its value is still filling. */
      open: key === todayKey,
    }
  })

  const sum = (from, to) => round6(rows.slice(from, to).reduce((acc, row) => acc + row.spend, 0))
  const firstSampleMs = series.length > 0 ? series[0].t : null
  // A window is "covered" only when sampling already started before its first day,
  // otherwise its total is a partial sum the UI must label as such.
  const windowCovered = (dayCount) => {
    if (firstSampleMs === null) return false
    const startKey = recentDayKeys(todayKey, dayCount)[0]
    return dayKeyOf(firstSampleMs, zone) <= startKey
  }

  return {
    zone,
    currency: options.currency ?? null,
    todayKey,
    rows,
    credits: credits.slice(-50).reverse(),
    creditTotal: round6(credits.reduce((acc, c) => acc + c.amount, 0)),
    totals: {
      d1: { amount: sum(rows.length - 1, rows.length), covered: windowCovered(1) },
      w1: { amount: sum(Math.max(0, rows.length - 7), rows.length), covered: windowCovered(7) },
      m1: { amount: sum(0, rows.length), covered: windowCovered(days) },
    },
    firstSampleMs,
    lastSampleMs: series.length > 0 ? series[series.length - 1].t : null,
    sampleCount: series.length,
    medianGapMs: series.length > 1 ? medianGapMs(series) : null,
  }
}

/** Median gap between consecutive samples, the sampling cadence actually achieved. */
export function medianGapMs(series) {
  const gaps = []
  for (let i = 1; i < series.length; i += 1) gaps.push(series[i].t - series[i - 1].t)
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 1 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2)
}

/**
 * Drop samples older than a retention window and thin out the rest.
 *
 * Retains every sample from the last `keepDays`, plus one sample per hour before
 * that, so the file stays small without losing day boundaries.
 *
 * @param samples - any sample list.
 * @param options.nowMs - the instant retention is measured from.
 * @param options.keepDays - full-resolution window in days (default 7).
 * @returns the retained samples, ascending.
 */
export function compactSamples(samples, options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const keepDays = options.keepDays ?? 7
  const fullFrom = nowMs - keepDays * 24 * HOUR_MS
  const hourly = new Map()
  const kept = []
  for (const sample of seriesFor(samples, undefined)) {
    if (sample.t >= fullFrom) {
      kept.push(sample)
      continue
    }
    const hour = Math.floor(sample.t / HOUR_MS)
    const previous = hourly.get(hour)
    // One sample per hour: keep the last of the hour, which carries the end state.
    if (previous === undefined) hourly.set(hour, sample)
    else if (previous.t <= sample.t) hourly.set(hour, sample)
  }
  return [...hourly.values(), ...kept].sort((a, b) => a.t - b.t)
}

/** Parse newline-delimited JSON samples, skipping damaged lines. */
export function parseSamples(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value.t === 'number' && typeof value.total === 'number') out.push(value)
    } catch {
      /* a torn tail line from a crash is expected and simply dropped */
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Serialize samples as newline-delimited JSON. */
export function serializeSamples(samples) {
  return samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length > 0 ? '\n' : '')
}

