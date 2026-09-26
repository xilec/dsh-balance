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
export const RULE_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** The day the rule and rates below were last checked against that page. */
export const RULE_VERIFIED_ON = '2026-09-27'

/** Peak windows as `[startMinute, endMinute)` offsets from 00:00 Beijing time. */
export const PEAK_WINDOWS_BJT_MINUTES = Object.freeze([
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
export const RATE_SCHEDULE = Object.freeze([
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
export function holidaySet(holidays) {
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
export function bjtDayStartMs(tsMs) {
  return Math.floor((tsMs + BJT_OFFSET_MS) / DAY_MS) * DAY_MS - BJT_OFFSET_MS
}

/**
 * The next instant the tariff changes.
 *
 * Candidates are the two window edges of each of the next nine Beijing days plus
 * each Beijing midnight (weekends and holidays begin and end there), so a change
 * is found without scanning minute by minute.
 *
 * @param tsMs - epoch milliseconds to search forward from.
 * @param holidays - Chinese public holidays as `YYYY-MM-DD` Beijing-time dates.
 * @returns `{ atMs, toPeak, reason, inMs }`, or null when no change is found.
 */
export function nextChange(tsMs, holidays = PUBLIC_HOLIDAYS_2026) {
  const current = peakState(tsMs, holidays).peak
  const dayStart = bjtDayStartMs(tsMs)
  const candidates = []
  for (let day = 0; day <= 9; day += 1) {
    const base = dayStart + day * DAY_MS
    for (const [from, to] of PEAK_WINDOWS_BJT_MINUTES) {
      candidates.push(base + from * MINUTE_MS, base + to * MINUTE_MS)
    }
    candidates.push(base + DAY_MS)
  }
  const next = candidates
    .filter((candidate) => candidate > tsMs)
    .sort((a, b) => a - b)
    .find((candidate) => peakState(candidate, holidays).peak !== current)
  if (next === undefined) return null
  const state = peakState(next, holidays)
  return { atMs: next, toPeak: state.peak, reason: state.reason, inMs: next - tsMs }
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
