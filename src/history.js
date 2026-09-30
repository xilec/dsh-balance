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
 * A manual override carries the amount the user typed, the instant their anchor balance was
 * read and that balance (`{ amount, at, balance }`). It is a *base*, not a
 * frozen value: the day is `base + (balanceAt − newestBalance) + creditsSince`, which
 * is the same window formula as everywhere else, so the figure keeps filling while
 * the day runs and settles on the last sample once it ends. Anchoring on a balance
 * rather than summing the deltas that happen to arrive afterwards keeps the
 * rounding error of a day to one subtraction instead of hundreds of them. An entry
 * with no balance (or a bare number, the oldest shape) has nothing to measure
 * against and stays frozen, and so does an anchor the day's own samples cannot
 * measure from — see `addedSince`.
 *
 * Pure module: no imports, no clock, no IO. The caller supplies samples,
 * overrides and "now".
 */

const HOUR_MS = 60 * 60_000

/** A day in milliseconds, the unit a range of day keys is measured in. */
const DAY_MS = 24 * HOUR_MS

/** Smallest credit worth recording; below this a rising balance is rounding noise. */
const DEFAULT_CREDIT_MIN_DELTA = 0.01

/** Smallest spend worth recording, in the account currency. */
const DEFAULT_SPEND_MIN_DELTA = 0.001

/**
 * The first day each of the three windows starts at, given today's day key.
 *
 * The windows are calendar ranges that end with today, so their lengths follow from these two
 * anchors rather than being fixed: a week is one day long on a Monday and seven on a Sunday, a
 * month is as long as the month has. None of them depends on `historyDays`, which only says how
 * many day rows the ledger keeps: the row count is a retention setting the reader can lower to
 * 3, and a window that inherited it would claim a month over three days.
 *
 * A day key is a fixed-width `YYYY-MM-DD` and the ledger's zone has already decided which
 * calendar day every sample belongs to, so the anchors are a question about a string, not about
 * an instant: no clock and no second timezone conversion, and therefore no DST edge to reason
 * about here.
 */
const WINDOW_STARTS = {
  d1: (todayKey) => todayKey,
  w1: weekStartKey,
  m1: monthStartKey,
}

/**
 * Money is rounded to six decimals on the way out.
 *
 * Differences of binary floats otherwise leak artefacts such as
 * `0.11000000000000298` into the day rows and the stored overrides.
 */
const round6 = (value) => Math.round(value * 1e6) / 1e6

/**
 * Cached formatter per IANA zone, `null` where the runtime rejects the name.
 *
 * Building a formatter costs microseconds and the ledger asks for calendar fields once per
 * sample, so building one per call spent seconds inside a single ledger build. The zone is one
 * panel setting, so this holds a handful of entries; the map is capped anyway and dropped
 * wholesale when it overflows, which keeps a caller that passes many zone names from growing it
 * without bound and needs no eviction policy to reason about.
 */
const FORMATTER_CACHE_LIMIT = 16
const zoneFormatters = new Map()

/**
 * Where the two-digit hour starts in this formatter's output, or `-1` when the output is not
 * the `YYYY-MM-DD<separator>HH` shape the fast path slices.
 *
 * `format` is about twice as fast as `formatToParts`, which allocates an array and five part
 * objects per sample, but reading it depends on the pattern — so the shape is confirmed once
 * per zone against two known instants before anything is sliced out of it.
 */
function probeHourAt(formatter) {
  const noon = formatter.format(Date.UTC(2026, 0, 2, 12))
  const midnight = formatter.format(Date.UTC(2026, 0, 2, 0))
  const shape = /^\d{4}-\d{2}-\d{2}[^\d]*\d{2}$/
  if (!shape.test(noon) || !shape.test(midnight)) return -1
  // Noon UTC is one of three local dates, so the front of the string is what makes it a date.
  if (!['2026-01-01', '2026-01-02', '2026-01-03'].includes(noon.slice(0, 10))) return -1
  return noon.length - 2
}

/**
 * The formatter for an IANA zone, with the hour offset in its output.
 *
 * @param zone - IANA zone name.
 * @returns `{ format, hourAt }`, or null when the runtime does not know the zone.
 */
function formatterFor(zone) {
  const cached = zoneFormatters.get(zone)
  if (cached !== undefined) return cached
  if (zoneFormatters.size >= FORMATTER_CACHE_LIMIT) zoneFormatters.clear()
  let entry = null
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      // `h23` rather than `hour12: false`: some ICU versions answer `24` for midnight, which
      // would be a different thinning bucket than `00`.
      hour: '2-digit', hourCycle: 'h23',
    })
    entry = { format, hourAt: probeHourAt(format) }
  } catch {
    /* an unknown zone falls back to the host's own, as the read route requires */
  }
  zoneFormatters.set(zone, entry)
  return entry
}

/**
 * Calendar fields of an instant in the host's own zone.
 *
 * Assembled for the two lookups below and never handed to a caller whole: the ledger wants the
 * day and the thinning pass wants the hour, and one function returning a pair meant the
 * `formatToParts` slow path walked the parts array for a field the day-only caller never wanted.
 *
 * @param tsMs - epoch milliseconds.
 * @returns `{ dateKey, hour }`, the key being `YYYY-MM-DD`.
 */
function hostFields(tsMs) {
  const d = new Date(tsMs)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return { dateKey: `${d.getFullYear()}-${month}-${day}`, hour: d.getHours() }
}

/**
 * The zone's own answer for an instant: its formatter when the runtime knows the zone, the
 * host's fields when it does not, which is the fallback the read route requires.
 *
 * @param tsMs - epoch milliseconds.
 * @param zone - IANA zone name, or `local`/undefined for the host's own zone.
 * @returns the formatter entry (or null) and the host's fields, whichever answers.
 */
function zoneSource(tsMs, zone) {
  if (!zone || zone === 'local') return { entry: null, host: hostFields(tsMs) }
  const entry = formatterFor(zone)
  return entry === null ? { entry: null, host: hostFields(tsMs) } : { entry, host: null }
}

/** The `YYYY-MM-DD` day key of an instant in a zone. */
export function dayKeyOf(tsMs, zone) {
  const { entry, host } = zoneSource(tsMs, zone)
  if (entry === null) return host.dateKey
  if (entry.hourAt < 0) {
    const parts = entry.format.formatToParts(tsMs)
    const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  }
  return entry.format.format(tsMs).slice(0, 10)
}

/**
 * The retention thinning's bucket for an instant: its clock hour *of the ledger's zone*, with
 * the day the ledger attributes it to.
 *
 * A UTC hour straddles local midnight wherever the offset is not a whole number of hours
 * (+05:30, +05:45, +09:30), and then the last sample kept before the boundary is not a sample of
 * the day it belongs to — the thinned history loses that day's own last hour. The pair is
 * assembled here, in the one caller that reads both halves, so the day-only callers never pay
 * for the hour (and the hour-only one would be meaningless without the day).
 *
 * @param tsMs - epoch milliseconds.
 * @param zone - IANA zone name, or `local`/undefined for the host's own zone.
 * @returns `{ dateKey, hour }`, the key being `YYYY-MM-DD`.
 */
function hourBucketOf(tsMs, zone) {
  const { entry, host } = zoneSource(tsMs, zone)
  if (entry === null) return host
  if (entry.hourAt < 0) {
    const parts = entry.format.formatToParts(tsMs)
    const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
    return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
  }
  const text = entry.format.format(tsMs)
  return { dateKey: text.slice(0, 10), hour: Number(text.slice(entry.hourAt, entry.hourAt + 2)) }
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

/**
 * The Monday of the week a day key falls in: the Monday on or before it, which is the day
 * itself when today is a Monday.
 *
 * ISO 8601 weeks start on Monday, and that is the rule the 1-week window and the panel's
 * "week from Monday" label both rest on. A Sunday-start week is the obvious alternative and is
 * not this one, so the next reader does not have to derive which was meant from the figures.
 *
 * Pure: the key is read as UTC midnight, which is only a fixed frame for the weekday — the
 * ledger's zone has already decided which calendar day the key names.
 *
 * @param dayKey - `YYYY-MM-DD`.
 * @returns the `YYYY-MM-DD` of that Monday.
 */
export function weekStartKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  // `getUTCDay()` is 0 for Sunday and 1 for Monday, so this is the distance back to the Monday.
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}

/**
 * The first day of the month a day key falls in.
 *
 * @param dayKey - `YYYY-MM-DD`.
 * @returns the `YYYY-MM-DD` of that month's 1st, 28, 29, 30 or 31 days back from it.
 */
export function monthStartKey(dayKey) {
  return `${dayKey.slice(0, 8)}01`
}

/**
 * The number of calendar days from `fromKey` through `toKey`, both of them included.
 *
 * The windows are ranges of day keys rather than counts, and this is the one place that turns
 * such a range into a length. Both keys parse as UTC midnight, so the difference is exact days
 * whatever zone the ledger is in and whatever the offsets are — a DST day is still one day.
 *
 * @param fromKey - `YYYY-MM-DD`, the window's first day.
 * @param toKey - `YYYY-MM-DD`, today.
 * @returns at least 1.
 */
export function daySpan(fromKey, toKey) {
  return Math.round((Date.parse(toKey) - Date.parse(fromKey)) / DAY_MS) + 1
}

/**
 * Read one entry of the override map.
 *
 * @param value - `{ amount, at }` as the panel writes it, or a bare number from an
 * older state file (which has no instant and is therefore frozen).
 * @returns `{ base, at }`, or null when the entry is unusable.
 */
function overrideEntry(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { base: value, at: null, balance: null } : null
  if (value === null || typeof value !== 'object') return null
  const base = Number(value.amount)
  if (!Number.isFinite(base)) return null
  const at = Number(value.at)
  const balance = Number(value.balance)
  return {
    base,
    at: Number.isFinite(at) ? at : null,
    balance: Number.isFinite(balance) ? balance : null,
  }
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
 * What the account spent while a session ran, as far as the samples reach.
 *
 * The balance is account-wide and the samples are sparse, so this is a
 * calibration rather than a measurement of one session: the delta covers every
 * session and every other charge between the first and the last sample inside
 * the window, and a single sample cannot express a delta at all — hence `null`
 * below two samples (the view then shows no calibration line).
 *
 * @param options - `samples` (any currency), `fromMs`/`toMs` of the window and
 * the `currency` to keep.
 * @returns `{ currency, samples, from, to, delta }`, or `null` when the window
 * holds fewer than two samples of that currency.
 */
export function calibrationOf(options = {}) {
  const { samples = [], fromMs = 0, toMs = 0, currency } = options
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null
  const inside = seriesFor(samples, currency).filter((sample) => sample.t >= fromMs && sample.t <= toMs)
  if (inside.length < 2) return null
  const first = inside[0]
  const last = inside[inside.length - 1]
  return {
    currency: first.currency ?? currency ?? null,
    samples: inside.length,
    from: first.t,
    to: last.t,
    delta: round6(first.total - last.total),
  }
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
 * The three windows are calendar ranges that end with today: today alone, the week from its
 * Monday, and the month from its 1st. `WINDOW_STARTS` says where each begins, and a window is
 * as long as the days between that day and today.
 *
 * @param options.samples - balance samples `{ t, total, currency, ... }`.
 * @param options.overrides - `{ [YYYY-MM-DD]: amount }`, the user's manual fix
 * for one day; a day present here ignores the sampled value.
 * @param options.currency - account currency to read.
 * @param options.zone - day-boundary zone; `local` (default) or an IANA name.
 * @param options.nowMs - the instant "today" is measured from.
 * @param options.days - how many day rows to produce (default 30). This is retention, not a
 * window length: the totals below range over their own calendar weeks and months.
 * @param options.creditMinDelta - credit noise floor.
 * @returns day rows, credit events, and the 1d/1w/1m totals. Each window reports its own
 * `days` (the calendar days it spans), how many of them the ledger and the samples `measured`,
 * and whether that is the whole window.
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

  // One calendar lookup per sample, reused by everything below. The fold used to ask for the
  // day of both ends of every interval, which is two lookups per interval, and the manual
  // bases asked again for every sample of their own day.
  const dayKeys = series.map((one) => dayKeyOf(one.t, zone))

  const sampled = new Map()
  const coarseKeys = new Set()
  for (let i = 1; i < series.length; i += 1) {
    // `movements` emits one interval per consecutive pair, in order, so interval `i - 1`
    // belongs to the samples `i - 1` and `i`.
    if (intervals[i - 1].spend <= 0) continue
    const fromKey = dayKeys[i - 1]
    const toKey = dayKeys[i]
    const target = toKey
    sampled.set(target, round6((sampled.get(target) ?? 0) + intervals[i - 1].spend))
    if (fromKey !== toKey) coarseKeys.add(target)
  }

  /**
   * The samples and credits of each day, indexed by day key, built on the first manual base.
   *
   * The bases re-filtered the whole series (and the whole credit list) once per row, which
   * made a read O(days × samples); the index costs one pass and is skipped entirely by the
   * ledgers that hold no anchored base.
   */
  let byDay = null
  const dayIndex = () => {
    if (byDay !== null) return byDay
    byDay = new Map()
    const bucket = (key) => {
      const found = byDay.get(key)
      if (found !== undefined) return found
      const created = { samples: [], credits: [] }
      byDay.set(key, created)
      return created
    }
    for (let i = 0; i < series.length; i += 1) bucket(dayKeys[i]).samples.push(series[i])
    for (const credit of credits) bucket(dayKeyOf(credit.t, zone)).credits.push(credit)
    return byDay
  }

  /**
   * What the day spent since a manual base was anchored.
   *
   * The base stores the account balance of one named instant, so the added part is the drop
   * from that balance to the newest sample of the same day, plus the credits that arrived in
   * between (a top-up raises the balance back and must not look like negative spend). One
   * subtraction, one credit sum — no per-interval rounding to accumulate.
   *
   * The window is `[anchor, newest sample of the day]`, and it only measures one day when both
   * of its ends are inside that day. A correction made after the day's last sample has nothing
   * left to measure, and one anchored before the day's first sample would measure a window
   * reaching back over midnight — the previous day's spend, which the reader's own figure for
   * this day cannot absorb. Both leave the base as the reader's final word.
   *
   * @param key - the day being valued.
   * @param entry - the parsed override `{ base, at, balance }`.
   * @returns the amount to add to the base, or 0 when there is no anchor to add from.
   */
  const addedSince = (key, entry) => {
    if (entry === null || entry.at === null || entry.balance === null) return 0
    const day = dayIndex().get(key)
    if (day === undefined) return 0
    const oldest = day.samples[0]
    const newest = day.samples[day.samples.length - 1]
    if (newest === undefined || entry.at > newest.t || entry.at < oldest.t) return 0
    const creditsSince = day.credits.reduce((total, credit) => (
      credit.t > entry.at ? total + credit.amount : total
    ), 0)
    return Math.max(0, round6(entry.balance - newest.total + creditsSince))
  }

  const rows = keys.map((key) => {
    const entry = overrideEntry(overrides[key])
    const computed = sampled.get(key) ?? 0
    const added = addedSince(key, entry)
    return {
      key,
      spend: entry === null ? computed : round6(entry.base + added),
      computed,
      override: entry === null ? null : entry.base,
      overrideAt: entry === null ? null : entry.at,
      /** Spend that arrived after the manual base was set. */
      measuredAfter: added,
      coarse: coarseKeys.has(key),
      /** True when the day ends after the newest sample: its value is still filling. */
      open: key === todayKey,
    }
  })

  const sum = (from, to) => round6(rows.slice(from, to).reduce((acc, row) => acc + row.spend, 0))
  const firstSampleMs = series.length > 0 ? series[0].t : null
  // Where the first sample's day sits in the row array, counted from its end: the number of
  // days the samples actually span. An index at or before the oldest row means the samples
  // reach past the ledger, so every row is measured.
  const firstSampleKey = firstSampleMs === null ? null : dayKeyOf(firstSampleMs, zone)
  const firstSampled = firstSampleKey === null
    ? rows.length
    : rows.findIndex((row) => row.key === firstSampleKey)
  const sampledDays = firstSampled <= 0 ? rows.length : rows.length - firstSampled

  /**
   * One window of the ledger, from its own first day through today.
   *
   * A window is a range of day keys, and the rows are contiguous and end with today, so the
   * window's first row is `max(0, rows.length - length)`: a window longer than the ledger starts
   * before the oldest row and takes all of them. A ledger too short to fill a window is summed
   * anyway — a partial month the reader can compare with yesterday's is worth more than a hole.
   *
   * `days` is the window's own calendar length, which is what the panel renders next to a
   * figure reading "so far this week". `measured` is what the ledger and the samples really
   * fill, and `covered` is exactly `measured === days`: the samples have to reach back to the
   * window's first day, so a ledger that starts on Tuesday has not covered a week that began on
   * Monday. Deriving the flag from the count rather than asking the two questions separately is
   * what keeps it from describing a different range than the figure beside it.
   *
   * @param startKey - the window's first day, `YYYY-MM-DD`.
   * @returns `{ amount, covered, days, measured }` for that window.
   */
  const windowTotal = (startKey) => {
    const length = daySpan(startKey, todayKey)
    const from = Math.max(0, rows.length - length)
    const measured = Math.min(length, rows.length - from, sampledDays)
    return {
      amount: sum(from, rows.length),
      covered: measured === length,
      days: length,
      measured,
    }
  }

  return {
    zone,
    currency: options.currency ?? null,
    todayKey,
    rows,
    credits: credits.slice(-50).reverse(),
    creditTotal: round6(credits.reduce((acc, c) => acc + c.amount, 0)),
    totals: Object.fromEntries(
      Object.entries(WINDOW_STARTS).map(([key, startsAt]) => [key, windowTotal(startsAt(todayKey))]),
    ),
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
 * @param options.zone - the ledger's day boundary; the thinned hours are its clock hours.
 * @returns the retained samples, ascending.
 */
export function compactSamples(samples, options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const keepDays = options.keepDays ?? 7
  const zone = options.zone ?? 'local'
  const fullFrom = nowMs - keepDays * 24 * HOUR_MS
  const hourly = new Map()
  const kept = []
  for (const sample of seriesFor(samples, undefined)) {
    if (sample.t >= fullFrom) {
      kept.push(sample)
      continue
    }
    // The bucket has to be a clock hour of the ledger's zone — see `hourBucketOf`.
    const { dateKey, hour } = hourBucketOf(sample.t, zone)
    const previous = hourly.get(`${dateKey}T${hour}`)
    // One sample per hour: keep the last of the hour, which carries the end state.
    if (previous === undefined) hourly.set(`${dateKey}T${hour}`, sample)
    else if (previous.t <= sample.t) hourly.set(`${dateKey}T${hour}`, sample)
  }
  return [...hourly.values(), ...kept].sort((a, b) => a.t - b.t)
}

/**
 * Parse newline-delimited JSON samples, skipping damaged lines.
 *
 * The log is append-only, so the newest samples are its last lines: `limit` keeps
 * only that many of them, and the lines before them are counted past without ever
 * being sliced out of the text. That is what bounds the cost of reading a log
 * nobody thinned — a file of a million lines used to materialise a million objects
 * before the caller threw almost all of them away. The limit counts lines and not
 * parsed samples, so a damaged line inside the window costs a sample from the
 * result: finding out that it is damaged is what parsing is, and parsing the lines
 * before the window is what the cap is there to avoid.
 *
 * @param text - the whole log, as read from disk.
 * @param options.limit - how many of the newest samples to materialise (all of
 * them when absent).
 * @returns the parsed samples, ascending by time.
 */
export function parseSamples(text, options = {}) {
  const source = String(text ?? '')
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : Infinity
  let lines = 0
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lines += 1
  if (source !== '' && !source.endsWith('\n')) lines += 1
  let skip = Math.max(0, lines - limit)
  const out = []
  let cursor = 0
  while (cursor < source.length) {
    let end = source.indexOf('\n', cursor)
    if (end === -1) end = source.length
    const line = source.slice(cursor, end).trim()
    cursor = end + 1
    if (skip > 0) {
      skip -= 1
      continue
    }
    if (line === '') continue
    try {
      const value = JSON.parse(line)
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

