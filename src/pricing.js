/**
 * The DeepSeek API pricing rule, as pure functions of an instant.
 *
 * Published rule (verified against the official pricing page on 2026-09-27):
 *
 *   "空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 *    9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
 *    全天均为空闲时段。"
 *
 *   Off-peak rates are half of the peak rates. Peak hours are 09:00-12:00 and
 *   14:00-18:00 Beijing time, Monday through Friday, excluding Chinese public
 *   holidays. All other hours are off-peak, including weekends and Chinese
 *   public holidays in full.
 *
 * Everything here is stated in Beijing time (UTC+8) calendar fields, so a local
 * time zone never enters the pricing decision. No imports, no side effects: this
 * module is what the tests pin and what the Host half prices with.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** UTC offset of Beijing time, the zone the published rule is stated in. */
export const BJT_OFFSET_MS = 8 * HOUR_MS

/** Where the rule and the rates below come from. */
export const RULE_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

/** The day the rule and rates below were last checked against that page. */
export const RULE_VERIFIED_ON = '2026-09-27'

/** Peak windows as `[startMinute, endMinute)` offsets from 00:00 Beijing time. */
const PEAK_WINDOWS_BJT_MINUTES = Object.freeze([
  Object.freeze([9 * 60, 12 * 60]),
  Object.freeze([14 * 60, 18 * 60]),
])

/** Off-peak price as a fraction of the peak price. */
export const OFF_PEAK_RATIO = 0.5

/**
 * Chinese public holidays for 2026, as Beijing-time dates, straight from the
 * State Council notice (国务院办公厅关于2026年部分节假日安排的通知, 2025-11-04).
 * Weekend dates are listed as well even though weekends are off-peak anyway.
 *
 * @remarks The list is per-year: it is the one part of the pricing rule that
 * cannot be derived, so it ships as data and is overridable in the plugin
 * config (`holidays`).
 */
export const PUBLIC_HOLIDAYS_2026 = Object.freeze([
  // 元旦：1月1日至3日
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节：2月15日至23日
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节：4月4日至6日
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节：5月1日至5日
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节：6月19日至21日
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节：9月25日至27日
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节：10月1日至7日
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
  '2026-10-07',
])

/**
 * Peak rates per 1M tokens. Off-peak is derived from these by
 * {@link OFF_PEAK_RATIO}, which is how the official page states the relation,
 * so only one table per currency is kept.
 */
const RATES_CURRENT = Object.freeze({
  CNY: Object.freeze({
    flash: Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 }),
    pro: Object.freeze({ cacheHit: 0.3, cacheMiss: 9, output: 27 }),
  }),
  USD: Object.freeze({
    flash: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
    pro: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
  }),
})

/**
 * Peak rates before the 2026-09-10 12:00 (BJT) Flash price cut. Kept so an old
 * session is still priced by the rates in force when it ran; Pro rates were not
 * part of that change. Off-peak is half of these too.
 */
const RATES_20260823 = Object.freeze({
  CNY: Object.freeze({
    flash: Object.freeze({ cacheHit: 0.1, cacheMiss: 3, output: 9 }),
    pro: RATES_CURRENT.CNY.pro,
  }),
  USD: Object.freeze({
    flash: Object.freeze({ cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }),
    pro: RATES_CURRENT.USD.pro,
  }),
})

/** Effective-dated rate tables; the last entry whose `fromMs` is not after the instant wins. */
const RATE_SCHEDULE = Object.freeze([
  // 2026-08-23 00:00 BJT: peak/off-peak pricing and all-day off-peak weekends start.
  Object.freeze({ fromMs: Date.UTC(2026, 7, 22, 16, 0, 0), rates: RATES_20260823 }),
  // 2026-09-10 12:00 BJT: the current Flash price cut.
  Object.freeze({ fromMs: Date.UTC(2026, 8, 10, 4, 0, 0), rates: RATES_CURRENT }),
])

/**
 * Beijing-time calendar fields of an instant.
 *
 * @param tsMs - epoch milliseconds.
 * @returns the Beijing-time date key, weekday (0 = Sunday) and minute of day.
 */
export function bjtFields(tsMs) {
  const shifted = new Date(tsMs + BJT_OFFSET_MS)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return {
    dateKey: `${shifted.getUTCFullYear()}-${month}-${day}`,
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** Normalize a holiday list (array or Set of `YYYY-MM-DD`) to a Set. */
function holidaySet(holidays) {
  if (holidays instanceof Set) return holidays
  if (Array.isArray(holidays)) return new Set(holidays)
  return new Set(PUBLIC_HOLIDAYS_2026)
}

/**
 * Whether an instant is billed at peak rates.
 *
 * @param tsMs - epoch milliseconds.
 * @param holidays - Chinese public holidays as `YYYY-MM-DD` Beijing-time dates.
 * @returns the verdict plus the reason, which the UI shows in its tooltip.
 */
export function peakState(tsMs, holidays = PUBLIC_HOLIDAYS_2026) {
  const { dateKey, weekday, minuteOfDay } = bjtFields(tsMs)
  if (weekday === 0 || weekday === 6) return { peak: false, reason: 'weekend', dateKey }
  if (holidaySet(holidays).has(dateKey)) return { peak: false, reason: 'holiday', dateKey }
  const inWindow = PEAK_WINDOWS_BJT_MINUTES.some(([from, to]) => minuteOfDay >= from && minuteOfDay < to)
  return { peak: inWindow, reason: inWindow ? 'peak' : 'off-peak', dateKey }
}

/** Whether an instant is billed at peak rates. */
export function isPeakInstant(tsMs, holidays = PUBLIC_HOLIDAYS_2026) {
  return peakState(tsMs, holidays).peak
}

/** Epoch ms of 00:00 Beijing time on the Beijing day containing `tsMs`. */
function bjtDayStartMs(tsMs) {
  return Math.floor((tsMs + BJT_OFFSET_MS) / DAY_MS) * DAY_MS - BJT_OFFSET_MS
}

/**
 * The published peak windows as UTC labels, derived from the Beijing rule so the
 * copy cannot drift from the windows the plugin bills with.
 *
 * @returns for example `01:00–04:00 and 06:00–10:00`.
 */
export function utcWindowsLabel() {
  const toUtc = (minuteOfDay) => {
    const offsetMinutes = BJT_OFFSET_MS / MINUTE_MS
    const utc = (((minuteOfDay - offsetMinutes) % 1440) + 1440) % 1440
    const hours = String(Math.floor(utc / 60)).padStart(2, '0')
    const minutes = String(utc % 60).padStart(2, '0')
    return `${hours}:${minutes}`
  }
  return PEAK_WINDOWS_BJT_MINUTES.map(([from, to]) => `${toUtc(from)}–${toUtc(to)}`).join(' and ')
}

/** Phases of the indicator, in the order a day walks through them. */
export const PHASE = Object.freeze({
  PEAK: 'peak',
  SOON: 'soon',
  OFF_PEAK: 'off-peak',
})

/** How long before a peak window opens the indicator switches to {@link PHASE.SOON}. */
export const WARN_LEAD_MS = 30 * MINUTE_MS

/**
 * Peak windows as absolute instants, clipped to a range.
 *
 * Windows are generated per Beijing day and skipped on weekends and Chinese public
 * holidays, which is the whole rule: nothing else removes a window.
 *
 * @param fromMs - range start, inclusive.
 * @param toMs - range end, exclusive.
 * @param holidays - Chinese public holidays as `YYYY-MM-DD` Beijing-time dates.
 * @returns `[{ startMs, endMs }]` ascending, each half-open.
 */
export function peakIntervalsBetween(fromMs, toMs, holidays = PUBLIC_HOLIDAYS_2026) {
  const set = holidaySet(holidays)
  const intervals = []
  for (let day = bjtDayStartMs(fromMs) - DAY_MS; day <= toMs + DAY_MS; day += DAY_MS) {
    const { dateKey, weekday } = bjtFields(day)
    if (weekday === 0 || weekday === 6) continue
    if (set.has(dateKey)) continue
    for (const [from, to] of PEAK_WINDOWS_BJT_MINUTES) {
      const startMs = day + from * MINUTE_MS
      const endMs = day + to * MINUTE_MS
      if (endMs <= fromMs || startMs >= toMs) continue
      intervals.push({ startMs, endMs })
    }
  }
  return intervals.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Peak-window boundaries as tariff transitions, in order.
 *
 * @param fromMs - range start, exclusive.
 * @param toMs - range end, inclusive.
 * @param holidays - Chinese public holidays.
 * @param limit - maximum number of transitions to return.
 * @returns `[{ atMs, toPeak, reason }]`.
 */
export function transitionsBetween(fromMs, toMs, holidays = PUBLIC_HOLIDAYS_2026, limit = 0) {
  const transitions = []
  for (const interval of peakIntervalsBetween(fromMs, toMs, holidays)) {
    transitions.push({ atMs: interval.startMs, toPeak: true, reason: 'peak' })
    transitions.push({ atMs: interval.endMs, toPeak: false, reason: 'off-peak' })
  }
  const ordered = transitions
    .filter((transition) => transition.atMs > fromMs && transition.atMs <= toMs)
    .sort((a, b) => a.atMs - b.atMs)
  return limit > 0 ? ordered.slice(0, limit) : ordered
}

/** The transitions the shell needs to render its own countdown between polls. */
export function peakSchedule(tsMs, holidays = PUBLIC_HOLIDAYS_2026, days = 4, limit = 16) {
  return transitionsBetween(tsMs, tsMs + days * DAY_MS, holidays, limit)
}

/**
 * The tariff state of one instant, with the next transition.
 *
 * @param tsMs - epoch milliseconds.
 * @param holidays - Chinese public holidays.
 * @returns `{ phase, peak, untilMs, changeAtMs, changeToPeak, nextPeakAtMs, reason }`,
 * where `untilMs`/`changeAtMs` describe the next transition (null when none is in
 * range) and `reason` explains the current state (weekend, holiday, peak, off-peak).
 */
export function phaseAt(tsMs, holidays = PUBLIC_HOLIDAYS_2026) {
  const intervals = peakIntervalsBetween(tsMs - 2 * DAY_MS, tsMs + 10 * DAY_MS, holidays)
  const active = intervals.find((interval) => tsMs >= interval.startMs && tsMs < interval.endMs) ?? null
  const next = intervals.find((interval) => interval.startMs > tsMs) ?? null
  const reason = peakState(tsMs, holidays).reason
  if (active !== null) {
    return {
      phase: PHASE.PEAK,
      peak: true,
      untilMs: active.endMs - tsMs,
      changeAtMs: active.endMs,
      changeToPeak: false,
      nextPeakAtMs: next === null ? null : next.startMs,
      reason,
    }
  }
  if (next === null) {
    return { phase: PHASE.OFF_PEAK, peak: false, untilMs: null, changeAtMs: null, changeToPeak: null, nextPeakAtMs: null, reason }
  }
  const untilMs = next.startMs - tsMs
  return {
    phase: untilMs <= WARN_LEAD_MS ? PHASE.SOON : PHASE.OFF_PEAK,
    peak: false,
    untilMs,
    changeAtMs: next.startMs,
    changeToPeak: true,
    nextPeakAtMs: next.startMs,
    reason,
  }
}

/**
 * Human-readable duration: minutes normally, seconds inside the last minute, days
 * when the wait runs past a day (the weekend gap is 2d 15h long).
 *
 * @param durationMs - non-negative duration.
 * @returns for example `45s`, `12m 30s`, `1h 23m`, `2d 15h`.
 */
export function formatRemaining(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}

/** `HH:MM` of an instant in a zone; falls back to UTC when `Intl` cannot format it. */
export function timeLabelInZone(tsMs, zone) {
  if (zone !== undefined && zone !== null && zone !== 'local') {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(tsMs))
      const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
      const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
      return `${hour}:${minute}`
    } catch {
      /* fall through to UTC */
    }
  }
  const date = new Date(tsMs)
  if (zone === 'local' || zone === undefined || zone === null) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

/** Zone offset in milliseconds at one instant, or 0 when it cannot be resolved. */
function zoneOffsetMs(tsMs, zone) {
  if (zone === 'local' || zone === undefined || zone === null) return 0
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(tsMs))
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
    if (match === null) return 0
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * MINUTE_MS
  } catch {
    return 0
  }
}

/**
 * Peak windows of one local calendar day, as `HH:MM–HH:MM` labels in that zone.
 *
 * @param tsMs - the instant that defines "today" in the zone.
 * @param holidays - Chinese public holidays.
 * @param zone - IANA zone name, or `local` for the host's own zone.
 * @param dayOffset - 0 for today, 1 for tomorrow.
 * @returns labels in window order; empty when that day has no peak window.
 */
export function windowsOfLocalDay(tsMs, holidays = PUBLIC_HOLIDAYS_2026, zone = 'local', dayOffset = 0) {
  const offset = zoneOffsetMs(tsMs, zone)
  const dayStart = Math.floor((tsMs + offset) / DAY_MS) * DAY_MS - offset + dayOffset * DAY_MS
  const dayEnd = dayStart + DAY_MS
  // A window belongs to the day its *start* falls in: one that opens at 23:00 and
  // closes at 03:00 is listed under the earlier day, and the tail of a window that
  // opened yesterday is not repeated here.
  return peakIntervalsBetween(dayStart, dayEnd, holidays)
    .filter((interval) => interval.startMs >= dayStart && interval.startMs < dayEnd)
    .map((interval) => `${timeLabelInZone(interval.startMs, zone)}–${timeLabelInZone(interval.endMs, zone)}`)
}

/**
 * The next instant the tariff changes.
 *
 * @param tsMs - epoch milliseconds to search forward from.
 * @param holidays - Chinese public holidays.
 * @returns `{ atMs, toPeak, reason, inMs }`, or null when no change is in range.
 */
export function nextChange(tsMs, holidays = PUBLIC_HOLIDAYS_2026) {
  const [change] = transitionsBetween(tsMs, tsMs + 9 * DAY_MS, holidays, 1)
  if (change === undefined) return null
  return { ...change, inMs: change.atMs - tsMs }
}

/**
 * The rate class a model id is billed under.
 *
 * @param model - model id as recorded in a session's request header.
 * @returns `flash`, `pro`, or null for a model this plugin has no rates for.
 */
export function modelClass(model) {
  if (typeof model !== 'string' || model === '') return null
  const id = model.toLowerCase()
  if (id === 'deepseek-v4-pro' || id === 'deepseek-pro') return 'pro'
  if (id === 'deepseek-flash' || id === 'deepseek-v4.1-flash' || id === 'deepseek-v4-flash' ||
    id === 'deepseek-v4-flash-vision-exp') return 'flash'
  // Unknown ids on the official route still name their family; keep the estimate useful.
  if (id.includes('flash')) return 'flash'
  if (id.includes('pro')) return 'pro'
  return null
}

/**
 * The rate table in force at an instant.
 *
 * @param tsMs - epoch milliseconds.
 * @returns the rate table of the last schedule entry effective at that instant;
 * the earliest entry is used for anything older (rates before 2026-08-23 are
 * approximated by that entry — see the README).
 */
export function ratesAt(tsMs) {
  let chosen = RATE_SCHEDULE[0]
  for (const entry of RATE_SCHEDULE) {
    if (entry.fromMs <= tsMs) chosen = entry
  }
  return chosen.rates
}

/**
 * Effective-dated rate tables of one currency, oldest first.
 *
 * The Cost view ships the whole schedule to the client so a session that spans a
 * price change is rendered against the rates that were in force, exactly as the
 * Host priced it.
 *
 * @param currency - `CNY` or `USD`; anything else is read as `CNY`.
 * @returns `[{ effectiveFrom, rates: { flash, pro } }]` in chronological order.
 */
export function rateSchedule(currency) {
  const code = String(currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
  return RATE_SCHEDULE.map((entry) => ({ effectiveFrom: entry.fromMs, rates: entry.rates[code] }))
}

/**
 * The price of one model at one instant.
 *
 * @param model - model id.
 * @param tsMs - epoch milliseconds of the billable event.
 * @param options - `currency` (CNY/USD) and `holidays`.
 * @returns `{ cacheHit, cacheMiss, output, peak, reason, currency, class }`, or
 * null when neither the config nor the built-in tables know the model.
 */
export function priceAt(model, tsMs, options = {}) {
  const currency = (options.currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const state = peakState(tsMs, options.holidays)
  const table = ratesAt(tsMs)[currency]
  const kind = modelClass(model) ?? (options.fallback !== undefined ? 'fallback' : null)
  if (kind === null) return null
  const peak = kind === 'fallback' ? options.fallback : (table[kind] ?? options.fallback)
  if (peak === undefined || peak === null) return null
  const ratio = state.peak ? 1 : OFF_PEAK_RATIO
  return {
    cacheHit: peak.cacheHit * ratio,
    cacheMiss: peak.cacheMiss * ratio,
    output: peak.output * ratio,
    peak: state.peak,
    reason: state.reason,
    currency,
    class: kind,
  }
}

/**
 * Cost of one token sample under a rate.
 *
 * @param tokens - `{ uncachedInput, cacheRead, cacheWrite, output }` counters.
 * @param rate - a {@link priceAt} result.
 * @returns the cost in the rate's currency.
 */
export function costOfTokens(tokens, rate) {
  const miss = (tokens.uncachedInput ?? 0) + (tokens.cacheWrite ?? 0)
  const hit = tokens.cacheRead ?? 0
  const out = tokens.output ?? 0
  return (miss * rate.cacheMiss + hit * rate.cacheHit + out * rate.output) / 1e6
}
