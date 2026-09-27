/**
 * dsh-balance — browser half.
 *
 * Three additive surfaces, all fed by `/dsh-balance`:
 *
 * 1. A compact readout in `conversation.composer.dock` at `order: -10`, so it is
 *    drawn immediately left of the shipped `stats` entry ("N turns · M steps") and
 *    reads as part of that line: `b:$19.52 · 1d:$0.39 · 1w:$2.29 · 1m:$10.43 · s:$0.33`.
 *    Hovering explains it, clicking opens the panel.
 * 2. The peak-tariff chip in the session header (and a floating copy for a session
 *    whose header is hidden), driven by the Host's rule — the same module that prices
 *    sessions, so holidays and the weekend discount are accounted for consistently.
 * 3. The panel: the account cards, the per-day ledger with manual corrections, the
 *    credit events and the sampling settings.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')

    const VERSION = '0.1.0'
    const NS = 'dsh-balance'

    /** Provider whose requests the published pricing rule bills. */
    const DEEPSEEK_PROVIDER = 'deepseek-official'

    /** How long before a peak window opens the chip switches to `soon`. */
    const WARN_LEAD_MS = 30 * 60 * 1000

    //#region styles
    const CSS_ID = 'dsh-balance/styles.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-balance'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        // The readout copies the shipped stats pills: same font size, same tertiary
        // colour, same hover wash, dot separators between the figures.
        '.dshb_readout{box-sizing:border-box;min-width:0;max-width:100%;',
        'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
        'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:flex;align-items:center;justify-content:center}',
        '.dshb_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;',
        'font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;',
        'align-items:center;gap:2px;padding:1px 8px;display:inline-flex;cursor:pointer;overflow:hidden;text-overflow:ellipsis}',
        '.dshb_pill:hover,.dshb_pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
        '.dshb_metric_muted{opacity:.55}',
        '.dshb_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 6px}',
        '.dshb_anchor{position:relative;display:inline-flex;min-width:0}',
        // The panel is an anchored popover — the behaviour of the token-usage pills
        // beside it: no dimmed backdrop, just a catch layer for outside clicks.
        '.dshb_catch{position:fixed;inset:0;z-index:60}',
        '.dshb_popover{position:absolute;bottom:calc(100% + 8px);left:0;z-index:61;width:min(560px,92vw);',
        'max-height:min(72vh,660px);display:flex;flex-direction:column;overflow:hidden;border-radius:10px;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));',
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-secondary);',
        'font-size:12px;line-height:1.6;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18));text-align:left;white-space:normal}',
        '.dshb_popover_head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 12px 0}',
        '.dshb_popover_body{padding:10px 12px 12px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
        '.dshb_popover_foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;',
        'border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
        '.dshb_modal_title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dshb_modal_sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_close{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 4px}',
        '.dshb_meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dshb_flag{color:var(--dsw-alias-state-warn-primary,#f59e0b);font-size:11px}',
        '.dshb_link{color:var(--dsw-alias-label-link,var(--dsw-alias-state-info-primary,#3b82f6));cursor:pointer;',
        'text-decoration:none;background:none;border:none;padding:0;font:inherit;text-align:left}',
        '.dshb_link:hover{text-decoration:underline}',
        '.dshb_cards{display:flex;gap:8px;flex-wrap:wrap}',
        '.dshb_card{flex:1 1 140px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;padding:8px 10px}',
        '.dshb_card_label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_card_value{font-size:16px;font-weight:600;margin-top:2px}',
        '.dshb_card_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
        '.dshb_tabs{display:flex;gap:4px}',
        '.dshb_tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);',
        'font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer}',
        '.dshb_tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));',
        'border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.25));color:var(--dsw-alias-label-primary)}',
        '.dshb_table{width:100%;border-collapse:collapse;font-size:12px}',
        '.dshb_table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 6px;',
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));position:sticky;top:0;',
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff))}',
        '.dshb_table td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.1))}',
        '.dshb_table tr[data-today="true"] td{font-weight:600}',
        '.dshb_num{text-align:right;font-variant-numeric:tabular-nums}',
        '.dshb_input{width:92px;text-align:right;font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,transparent);',
        'color:inherit;font-variant-numeric:tabular-nums}',
        '.dshb_row_flags{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dshb_btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;',
        'font:inherit;font-size:11.5px;padding:2px 8px;border-radius:6px;cursor:pointer}',
        '.dshb_btn:disabled{opacity:.5;cursor:default}',
        '.dshb_btn_primary{background:var(--dsw-alias-state-success-primary,#10b981);border-color:transparent;color:#fff}',
        '.dshb_settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}',
        '.dshb_field{display:flex;flex-direction:column;gap:3px;font-size:12px}',
        '.dshb_field span{color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dshb_field input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;',
        'padding:4px 8px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px}',
        '.dshb_footer{display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_credits{display:flex;flex-direction:column;gap:4px;font-size:12px}',
        '.dshb_credit{display:flex;justify-content:space-between;gap:12px}',
        '.dshb_error{color:var(--dsw-alias-state-error-primary,#ef4444)}',
        // The peak chip keeps the look of the standalone peaks plugin.
        '.dshb_peak{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:24px;',
        'padding:0 10px 2px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);',
        'font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
        '.dshb_peak_peak{background:#7d2626;color:#fff}',
        '.dshb_peak_soon{background:#7a5a06;color:#fff}',
        '.dshb_peak_off-peak{background:#1d6b45;color:#fff}',
        '.dshb_peak_peak:hover{background:#8e2c2c}',
        '.dshb_peak_soon:hover{background:#8f6a08}',
        '.dshb_peak_off-peak:hover{background:#237a50}',
        '.dshb_panel{position:absolute;z-index:61;display:flex;flex-direction:column;gap:3px;width:max-content;',
        'max-width:min(440px,88vw);padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));',
        'border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));',
        'box-shadow:0 6px 24px rgba(0,0,0,.16);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;text-align:left}',
        '.dshb_panel_below{top:calc(100% + 6px);left:0}',
        '.dshb_panel_above{bottom:calc(100% + 6px);right:0}',
        '.dshb_panel_title{color:var(--dsw-alias-label-primary);font-weight:600}',
        '.dshb_float{position:absolute;right:18px;bottom:6px;z-index:1}',
      ].join('')
      document.head.appendChild(tag)
    }
    //#endregion

    //#region copy
    const copy = {
      en: {
        'readout.balance': 'b',
        'readout.session': 's',
        'readout.aria': 'DeepSeek balance and spend',
        'tip.balance': 'Balance',
        'tip.toppedUp': 'Topped up',
        'tip.granted': 'Granted',
        'tip.spend1d': 'Last day',
        'tip.spend1w': 'Last 7 days',
        'tip.spend1m': 'Last 30 days',
        'tip.session': 'This session (estimate)',
        'tip.samples': 'Samples',
        'tip.cadence': 'Median gap',
        'tip.fetched': 'Balance read',
        'tip.credits': 'Credits in history',
        'tip.partial': 'partial: sampling started later',
        'tip.coarse': 'some days are coarse — the app was closed across a day boundary',
        'tip.unpriced': 'not priced: {models}',
        'reason.peak': 'peak rates',
        'reason.soon': 'peak rates start soon',
        'reason.off-peak': 'off-peak rates',
        'reason.weekend': 'weekend, off-peak all day',
        'reason.holiday': 'Chinese public holiday, off-peak all day',
        'tip.error.api-key-missing': 'no API key found (DEEPSEEK_API_KEY)',
        'tip.stale': 'showing the last successful read',
        'card.title': 'DeepSeek balance and spend',
        'card.sub': 'spend is measured as the drop of the account balance, plus credits',
        'tab.days': 'Days',
        'tab.credits': 'Credits',
        'tab.settings': 'Settings',
        'card.balance': 'Balance',
        'card.today': 'Today',
        'card.session': 'This session',
        'card.week': '7 days',
        'card.month': '30 days',
        'card.unavailable': 'balance unavailable',
        'days.date': 'Day',
        'days.sampled': 'From samples',
        'days.manual': 'Manual',
        'days.actions': '',
        'days.coarse': 'coarse',
        'days.open': 'in progress',
        'days.reset': 'reset',
        'credits.empty': 'no credits recorded yet',
        'credits.note': 'a rising balance is a top-up, a refund, or a correction',
        'settings.currency': 'Currency',
        'settings.dayZone': 'Day boundary zone',
        'settings.refresh': 'Balance poll, ms',
        'settings.poll': 'Chip refresh, ms',
        'settings.warning': 'Amber below',
        'settings.danger': 'Red below',
        'settings.historyDays': 'Day rows kept',
        'settings.apply': 'Apply',
        'settings.saved': 'saved',
        'settings.failed': 'rejected: {error}',
        'settings.note': 'The Host samples the balance on its own schedule — the chip only reads its cached payload.',
        'footer.rule': 'Rates and tariff rule',
        'footer.ruleLink': 'official page',
        'footer.host': 'host {version}',
        'footer.client': 'client {version}',
        'common.close': 'Close',
        'common.refresh': 'Refresh now',
        'common.never': 'never',
        'peak.chip.peak': 'Peak · ends in {remaining}',
        'peak.chip.soon': 'Peak soon · {remaining}',
        'peak.chip.off': 'Off-peak · peak in {remaining}',
        'peak.title': 'DeepSeek peak hours',
        'peak.aria': 'DeepSeek peak pricing: {text}',
        'peak.state.peak': 'Now: peak pricing (×2)',
        'peak.state.off': 'Now: off-peak pricing (×0.5)',
        'peak.reason.weekend': 'Weekend pricing: off-peak all day',
        'peak.reason.holiday': 'Chinese public holiday: off-peak all day',
        'peak.today': 'Today ({zone}): {windows}',
        'peak.tomorrow': 'Tomorrow ({zone}): {windows}',
        'peak.allDay': 'off-peak all day',
        'peak.utc': 'Peak hours: {windows} UTC, Mon–Fri',
        'peak.offPeakNote': 'Weekends and Chinese public holidays are off-peak all day.',
        'peak.price': 'Off-peak rates are half of peak rates.',
        'peak.nextPeakEnds': 'Next change: peak ends {day} at {time} (in {remaining})',
        'peak.nextPeakStarts': 'Next change: peak starts {day} at {time} (in {remaining})',
        'peak.dayToday': 'today',
        'peak.dayTomorrow': 'tomorrow',
        'peak.source': 'Source: {url} · verified {date}',
      },
      ru: {
        'readout.balance': 'б',
        'readout.session': 'с',
        'readout.aria': 'Баланс и расход DeepSeek',
        'tip.balance': 'Баланс',
        'tip.toppedUp': 'Пополнено',
        'tip.granted': 'Подарочные',
        'tip.spend1d': 'За сутки',
        'tip.spend1w': 'За 7 дней',
        'tip.spend1m': 'За 30 дней',
        'tip.session': 'Эта сессия (оценка)',
        'tip.samples': 'Сэмплов',
        'tip.cadence': 'Медианный интервал',
        'tip.fetched': 'Баланс прочитан',
        'tip.credits': 'Пополнения в истории',
        'tip.partial': 'частично: сэмплирование началось позже',
        'tip.coarse': 'часть дней помечена как грубые — приложение было закрыто через границу суток',
        'tip.unpriced': 'без цены: {models}',
        'reason.peak': 'пиковый тариф',
        'reason.soon': 'скоро пиковый тариф',
        'reason.off-peak': 'льготный тариф',
        'reason.weekend': 'выходные — весь день льготный тариф',
        'reason.holiday': 'госпраздник КНР — весь день льготный тариф',
        'tip.error.api-key-missing': 'не найден ключ API (DEEPSEEK_API_KEY)',
        'tip.stale': 'показано последнее успешное чтение',
        'card.title': 'Баланс и расход DeepSeek',
        'card.sub': 'расход считается как падение баланса плюс пополнения',
        'tab.days': 'Дни',
        'tab.credits': 'Пополнения',
        'tab.settings': 'Настройки',
        'card.balance': 'Баланс',
        'card.today': 'Сегодня',
        'card.session': 'Эта сессия',
        'card.week': '7 дней',
        'card.month': '30 дней',
        'card.unavailable': 'баланс недоступен',
        'days.date': 'День',
        'days.sampled': 'Из сэмплов',
        'days.manual': 'Вручную',
        'days.actions': '',
        'days.coarse': 'грубо',
        'days.open': 'идёт',
        'days.reset': 'сброс',
        'credits.empty': 'пополнений пока нет',
        'credits.note': 'рост баланса — это пополнение, возврат или правка',
        'settings.currency': 'Валюта',
        'settings.dayZone': 'Зона границы суток',
        'settings.refresh': 'Опрос баланса, мс',
        'settings.poll': 'Обновление чипа, мс',
        'settings.warning': 'Жёлтый ниже',
        'settings.danger': 'Красный ниже',
        'settings.historyDays': 'Хранить дней',
        'settings.apply': 'Применить',
        'settings.saved': 'сохранено',
        'settings.failed': 'отклонено: {error}',
        'settings.note': 'Хост опрашивает баланс по своему расписанию — чип только читает его кэш.',
        'footer.rule': 'Тарифы и правило峰/谷',
        'footer.ruleLink': 'официальная страница',
        'footer.host': 'хост {version}',
        'footer.client': 'клиент {version}',
        'common.close': 'Закрыть',
        'common.refresh': 'Обновить',
        'common.never': 'никогда',
        'peak.chip.peak': 'Пик · закончится через {remaining}',
        'peak.chip.soon': 'Скоро пик · {remaining}',
        'peak.chip.off': 'Льготный · пик через {remaining}',
        'peak.title': 'Пиковые часы DeepSeek',
        'peak.aria': 'Пиковые тарифы DeepSeek: {text}',
        'peak.state.peak': 'Сейчас: пиковый тариф (×2)',
        'peak.state.off': 'Сейчас: льготный тариф (×0.5)',
        'peak.reason.weekend': 'Тариф выходного дня: весь день льготный',
        'peak.reason.holiday': 'Госпраздник КНР: весь день льготный',
        'peak.today': 'Сегодня ({zone}): {windows}',
        'peak.tomorrow': 'Завтра ({zone}): {windows}',
        'peak.allDay': 'весь день льготный',
        'peak.utc': 'Пиковые часы: {windows} UTC, Пн–Пт',
        'peak.offPeakNote': 'Выходные и госпраздники КНР — весь день льготный тариф.',
        'peak.price': 'Льготный тариф — половина пикового.',
        'peak.nextPeakEnds': 'Смена: пик закончится {day} в {time} (через {remaining})',
        'peak.nextPeakStarts': 'Смена: пик начнётся {day} в {time} (через {remaining})',
        'peak.dayToday': 'сегодня',
        'peak.dayTomorrow': 'завтра',
        'peak.source': 'Источник: {url} · проверено {date}',
      },
    }
    //#endregion

    //#region formatting
    const SYMBOL = { CNY: '¥', USD: '$', EUR: '€', RUB: '₽' }

    function symbol(currency) {
      return SYMBOL[currency] ?? `${currency} `
    }

    function money(value, currency, digits = 2) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const fixed = Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(digits)
      return `${symbol(currency)}${fixed}`
    }

    function duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const minutes = Math.floor(ms / 60000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    /** The countdown format the peaks chip uses: `45s`, `12m 30s`, `1h 23m`, `2d 15h`. */
    function formatRemaining(ms) {
      const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
      if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
      if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
      return `${seconds}s`
    }

    function clock(ts) {
      if (typeof ts !== 'number' || ts <= 0) return null
      const date = new Date(ts)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function dayLabel(key) {
      const [y, m, d] = key.split('-')
      return `${d}.${m}`
    }

    function statusLevel(balance, thresholds) {
      if (balance === null || thresholds === undefined) return 'idle'
      if (balance <= thresholds.danger) return 'danger'
      if (balance <= thresholds.warning) return 'warning'
      return 'success'
    }
    //#endregion

    //#region peak state
    /**
     * The tariff state at `nowMs`, derived from the Host's transition schedule.
     *
     * The Host owns the rule (it is the same module that prices sessions); the
     * schedule carries absolute instants, so the chip can tick every second between
     * polls without asking anyone.
     *
     * @param schedule - `[{ atMs, toPeak, reason }]` from the payload, in order.
     * @param asOfMs - instant the payload was read.
     * @param asOfPeak - whether that instant was peak.
     * @param nowMs - instant to describe.
     * @returns `{ peak, phase, untilMs, changeAtMs, changeToPeak }`.
     */
    function phaseFromSchedule(schedule, asOfMs, asOfPeak, nowMs) {
      let peak = asOfPeak === true
      let next = null
      for (const transition of schedule ?? []) {
        if (typeof transition?.atMs !== 'number') continue
        if (transition.atMs <= asOfMs) continue
        if (transition.atMs <= nowMs) {
          peak = transition.toPeak === true
          continue
        }
        next = transition
        break
      }
      const untilMs = next === null ? null : next.atMs - nowMs
      const phase = peak
        ? 'peak'
        : (next !== null && next.toPeak === true && untilMs <= WARN_LEAD_MS ? 'soon' : 'off-peak')
      return {
        peak,
        phase,
        untilMs,
        changeAtMs: next === null ? null : next.atMs,
        changeToPeak: next === null ? null : next.toPeak === true,
      }
    }

    /** The route one `modelSelection` leaf describes. */
    function routeOfSelection(selection) {
      if (selection === null || typeof selection !== 'object') return null
      const provider = selection.provider
      const model = selection.model
      if (typeof provider !== 'string' || typeof model !== 'string') return null
      return { provider, model }
    }

    /** The route recorded by the `modelSelection` projection, if any. */
    function routeFromModelSelection(value) {
      if (value === null || typeof value !== 'object') return null
      return routeOfSelection(value.next) ?? routeOfSelection(value.lastUsed)
    }

    /** The route a session with no recorded selection will use, from the catalog default. */
    function routeFromCatalogDefault(snapshot) {
      const catalog = snapshot?.value
      if (catalog === null || typeof catalog !== 'object') return null
      return routeOfSelection(catalog.default)
    }

    /**
     * The route the next request will use.
     *
     * An absent projection means the runtime never told us which model the session
     * uses, and the indicator stays hidden rather than quoting a price for a route it
     * cannot see.
     */
    function effectiveRoute(projection, catalogSnapshot) {
      const recorded = routeFromModelSelection(projection)
      if (recorded !== null) return recorded
      if (projection === undefined || projection === null) return null
      return routeFromCatalogDefault(catalogSnapshot)
    }

    /** Whether the published rule bills this provider at all. */
    function isPeakRuleRoute(provider) {
      return provider === DEEPSEEK_PROVIDER
    }
    //#endregion

    //#region store
    const DEFAULT_POLL_MS = 15000
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

    function browserZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return typeof zone === 'string' && zone.length > 0 ? zone : 'local'
      } catch {
        return 'local'
      }
    }

    function settingsOf(payload) {
      return {
        currency: payload?.balance?.currencyPreference ?? payload?.balance?.currency ?? 'USD',
        dayZone: payload?.ledger?.zone ?? 'local',
        refreshIntervalMs: payload?.sampling?.refreshIntervalMs ?? 300000,
        clientPollIntervalMs: payload?.sampling?.clientPollIntervalMs ?? DEFAULT_POLL_MS,
        warningThreshold: payload?.balance?.thresholds?.warning ?? 10,
        dangerThreshold: payload?.balance?.thresholds?.danger ?? 5,
        historyDays: payload?.ledger?.rows?.length ?? 30,
      }
    }

    /**
     * One shared poller: a single reader per page whatever number of surfaces the
     * plugin adds, with the reader's zone and session id attached.
     */
    function createStore() {
      let snapshot = { status: 'loading', payload: null, error: null, at: 0 }
      let pollMs = DEFAULT_POLL_MS
      let timer = null
      let inflight = null
      let subscribers = 0
      let helloSent = false
      let currentSessionId = ''
      let refetchRequested = false
      const listeners = new Set()
      const zone = browserZone()

      const notify = () => {
        for (const listener of [...listeners]) listener()
      }

      function sayHello(phase) {
        void fetch('/dsh-balance/hello', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: VERSION, phase }),
        }).catch(() => {})
      }

      async function read() {
        if (inflight !== null) {
          refetchRequested = true
          return inflight
        }
        const requestedSession = currentSessionId
        inflight = (async () => {
          try {
            const params = new URLSearchParams({ zone })
            if (requestedSession !== '') params.set('sessionId', requestedSession)
            const response = await fetch(`/dsh-balance?${params.toString()}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            pollMs = clamp(payload?.sampling?.clientPollIntervalMs ?? pollMs, 2000, 3600000)
            snapshot = { status: 'ok', payload, error: null, at: Date.now() }
            if (!helloSent) {
              helloSent = true
              sayHello('read')
            }
          } catch (error) {
            snapshot = {
              status: 'error',
              payload: snapshot.payload,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            }
          } finally {
            inflight = null
            notify()
          }
        })()
        const settled = inflight
        // A read that raced the session switch (or a manual refresh) leaves the
        // payload stale, so run one more pass once this one has settled.
        void settled.then(() => {
          if (refetchRequested || requestedSession !== currentSessionId) {
            refetchRequested = false
            void read()
          }
        })
        return inflight
      }

      const schedule = () => {
        if (timer !== null) return
        timer = setTimeout(() => {
          timer = null
          if (typeof document !== 'undefined' && document.hidden) {
            schedule()
            return
          }
          void read().then(schedule, schedule)
        }, pollMs)
      }

      async function post(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      }

      return {
        sayHello,
        subscribe(listener) {
          listeners.add(listener)
          if (subscribers === 0) void read().then(schedule, schedule)
          subscribers += 1
          return () => {
            listeners.delete(listener)
            subscribers -= 1
            if (subscribers === 0 && timer !== null) {
              clearTimeout(timer)
              timer = null
            }
          }
        },
        getSnapshot: () => snapshot,
        setSessionId(id) {
          const next = typeof id === 'string' ? id : ''
          if (next === currentSessionId) return
          currentSessionId = next
          void read().then(schedule, schedule)
        },
        refresh: () => read(),
        async setOverride(date, amount) {
          const result = await post('/dsh-balance/overrides', { date, amount })
          await read()
          return result
        },
        async saveSettings(values) {
          const result = await post('/dsh-balance/settings', values)
          pollMs = clamp(result?.sampling?.clientPollIntervalMs ?? pollMs, 2000, 3600000)
          await read()
          return result
        },
        forceRefresh: () => post('/dsh-balance/refresh', {}).then(() => read()),
      }
    }

    const store = createStore()

    const useStore = () => react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

    /** A clock that ticks while a component is mounted, for countdowns. */
    function useNow(intervalMs) {
      const [now, setNow] = react.useState(() => Date.now())
      react.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }
    //#endregion

    //#region components
    const h = react.createElement

    /**
     * The compact readout in the composer dock, left of the shipped stats entry.
     *
     * The format is deliberately terse — `b:`, `1d`, `1w`, `1m`, `s:` — because it
     * shares one line with the turn counters and the token pills.
     */
    function Readout(props) {
      const { t } = props
      const state = useStore()
      // The session projection updates as the turn streams; the payload's copy is the
      // fallback when the projection unit is not registered.
      const projection = typeof props.useProjection === 'function' ? props.useProjection('dshBalanceCost') : undefined
      const [open, setOpen] = react.useState(false)
      const payload = state.payload
      const balance = payload?.balance ?? null
      const primary = balance?.primary ?? null
      const ledger = payload?.ledger ?? null
      const currency = balance?.currency ?? 'USD'
      const sessionCost = projection?.cost ?? payload?.session?.cost ?? null
      const sessionCurrency = projection?.currency ?? payload?.session?.currency ?? currency

      react.useEffect(() => {
        store.setSessionId(typeof props.sessionId === 'string' ? props.sessionId : '')
        store.sayHello('mount')
      }, [props.sessionId])

      react.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      /**
       * The line carries no labels: balance, the three window totals and the session
       * estimate, each figure keeping its own currency symbol. The legend lives in
       * the native title and in the panel, because the pill shares one line with the
       * turn counters and the token pills.
       */
      const legend = [
        t('tip.balance'),
        `${t('tip.spend1d')}/${t('tip.spend1w')}/${t('tip.spend1m')}`,
        t('tip.session'),
      ].join(' · ')

      const window_ = (key, value, covered) => h('span', {
        key,
        className: covered ? undefined : 'dshb_metric_muted',
      }, money(value, currency))

      const spend = ledger === null
        ? h('span', { key: 'spend' }, '—')
        : h('span', { key: 'spend' }, [
          window_('1d', ledger.totals.d1.amount, ledger.totals.d1.covered),
          h('span', { key: 'slash1' }, '/'),
          window_('1w', ledger.totals.w1.amount, ledger.totals.w1.covered),
          h('span', { key: 'slash2' }, '/'),
          window_('1m', ledger.totals.m1.amount, ledger.totals.m1.covered),
        ])

      const line = [
        h('span', { key: 'balance' }, primary === null ? '—' : money(primary.total, currency)),
        h('span', { className: 'dshb_sep', key: 'sep1' }),
        spend,
        h('span', { className: 'dshb_sep', key: 'sep2' }),
        h('span', { key: 'session' }, sessionCost === null ? '—' : money(sessionCost, sessionCurrency)),
      ]

      return h('div', { className: 'dshb_readout' }, h('div', { className: 'dshb_anchor' }, [
        h('button', {
          key: 'pill',
          type: 'button',
          className: 'dshb_pill',
          title: legend,
          'aria-label': `${t('readout.aria')}: ${legend}`,
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        }, line),
        open ? h(Popover, { key: 'popover', t, state, projection, onClose: () => setOpen(false) }) : null,
      ]))
    }

    /** The peak-tariff chip: the session header, or a floating copy for a hidden header. */
    function createPeakChip(deps) {
      const { forNewSession, catalogSnapshot } = deps
      return function PeakChip(props) {
        const { t } = props
        const state = useStore()
        const nowMs = useNow(1000)
        const [open, setOpen] = react.useState(false)
        const prop = (name, ...args) => {
          try {
            return typeof props[name] === 'function' ? props[name](...args) : undefined
          } catch {
            return undefined
          }
        }
        const isFreshSession = prop('useSession', (snapshot) => snapshot.blank && !snapshot.running && !snapshot.promptAttempted) === true
        const projection = prop('useProjection', 'modelSelection')
        const payload = state.payload
        const route = effectiveRoute(projection, catalogSnapshot())
        const local = payload?.peak === null || payload?.peak === undefined
          ? null
          : phaseFromSchedule(payload.peak.schedule, payload.host?.now ?? state.at, payload.peak.peak, nowMs)

        if (isFreshSession !== forNewSession) return null
        if (route === null || !isPeakRuleRoute(route.provider)) return null
        if (local === null) return null

        const remaining = local.untilMs === null ? '—' : formatRemaining(local.untilMs)
        const text = local.phase === 'peak'
          ? t('peak.chip.peak', { remaining })
          : local.phase === 'soon'
            ? t('peak.chip.soon', { remaining })
            : t('peak.chip.off', { remaining })

        const chip = h('button', {
          type: 'button',
          className: `dshb_peak dshb_peak_${local.phase}`,
          'aria-expanded': open,
          'aria-label': t('peak.aria', { text }),
          onClick: () => setOpen((value) => !value),
        }, text)

        if (open === false) return forNewSession ? h('div', { className: 'dshb_float' }, chip) : chip
        const panel = h('div', { className: `dshb_panel ${forNewSession ? 'dshb_panel_above' : 'dshb_panel_below'}` }, [
          h('div', { className: 'dshb_panel_title', key: 'title' }, t('peak.title')),
          ...peakLines(t, payload, route, local, nowMs).map((line, index) => h('div', { key: `line-${index}` }, line)),
        ])
        const stack = h('div', { className: 'dshb_anchor' }, [
          chip,
          h('div', { className: 'dshb_catch', key: 'catch', onClick: () => setOpen(false) }),
          panel,
        ])
        return forNewSession ? h('div', { className: 'dshb_float' }, stack) : stack
      }
    }

    /** Every line the peak panel shows, derived from the Host's rule payload. */
    function peakLines(t, payload, route, local, nowMs) {
      const peak = payload?.peak ?? {}
      const windows = peak.windows ?? {}
      const zone = peak.zone ?? 'local'
      const changeAt = local.changeAtMs === null ? null : new Date(local.changeAtMs)
      const todayKey = new Date(nowMs).toDateString()
      const tomorrowKey = new Date(nowMs + 24 * 3600 * 1000).toDateString()
      const dayWord = changeAt === null
        ? ''
        : changeAt.toDateString() === todayKey
          ? t('peak.dayToday')
          : changeAt.toDateString() === tomorrowKey
            ? t('peak.dayTomorrow')
            : changeAt.toLocaleDateString(undefined, { weekday: 'short' })
      const lines = [
        local.peak ? t('peak.state.peak') : t('peak.state.off'),
        `${route.provider} · ${route.model}`,
        t('peak.today', { zone, windows: (windows.today ?? []).join(', ') || t('peak.allDay') }),
        t('peak.tomorrow', { zone, windows: (windows.tomorrow ?? []).join(', ') || t('peak.allDay') }),
        t('peak.utc', { windows: peak.rule?.utcWindows ?? '' }),
        t('peak.offPeakNote'),
        t('peak.price'),
      ]
      if (changeAt !== null) {
        lines.push(t(local.changeToPeak ? 'peak.nextPeakStarts' : 'peak.nextPeakEnds', {
          day: dayWord,
          time: changeAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
          remaining: formatRemaining(local.untilMs ?? 0),
        }))
      }
      if (!local.peak && (peak.reason === 'holiday' || peak.reason === 'weekend')) {
        lines.push(t(`peak.reason.${peak.reason}`))
      }
      lines.push(t('peak.source', { url: peak.rule?.sourceUrl ?? '', date: peak.rule?.verifiedOn ?? '' }))
      return lines
    }

    /**
     * The panel behind the pill: the summary cards, the per-day ledger, the credit
     * events and the settings, anchored above the readout like the token-usage
     * dialogs rather than a full-screen modal.
     */
    function Popover({ t, state, projection, onClose }) {
      const [tab, setTab] = react.useState('days')
      const payload = state.payload
      const currency = payload?.balance?.currency ?? 'USD'
      const ledger = payload?.ledger ?? null
      const balance = payload?.balance ?? null
      const primary = balance?.primary ?? null
      const sessionCost = projection?.cost ?? payload?.session?.cost ?? null
      const sessionCurrency = projection?.currency ?? payload?.session?.currency ?? currency

      const card = (key, label, value, hint) => h('div', { className: 'dshb_card', key }, [
        h('div', { className: 'dshb_card_label', key: 'l' }, label),
        h('div', { className: 'dshb_card_value', key: 'v' }, value),
        hint === undefined ? null : h('div', { className: 'dshb_card_hint', key: 'h' }, hint),
      ])

      // Balance, today and this session on the first row; the two rolling totals
      // below them, month first, week after it.
      const cards = h('div', { className: 'dshb_cards', key: 'cards' }, [
        card('bal', t('card.balance'),
          primary === null ? '—' : money(primary.total, currency),
          primary === null
            ? (balance?.error === 'api-key-missing' ? t('tip.error.api-key-missing') : t('card.unavailable'))
            : `${t('tip.toppedUp')} ${money(primary.toppedUp, currency)} · ${t('tip.granted')} ${money(primary.granted, currency)}`),
        card('d1', t('card.today'), ledger === null ? '—' : money(ledger.totals.d1.amount, currency)),
        card('ses', t('card.session'), sessionCost === null ? '—' : money(sessionCost, sessionCurrency),
          payload?.peak === undefined ? undefined : t(`reason.${payload.peak.phase ?? 'off-peak'}`)),
        card('m1', t('card.month'), ledger === null ? '—' : money(ledger.totals.m1.amount, currency)),
        card('w1', t('card.week'), ledger === null ? '—' : money(ledger.totals.w1.amount, currency)),
      ])

      const meta = []
      if (ledger !== null) {
        meta.push(`${t('tip.samples')} ${ledger.sampleCount}`)
        if (ledger.medianGapMs !== null) meta.push(`${t('tip.cadence')} ${duration(ledger.medianGapMs)}`)
        meta.push(`${t('tip.credits')} ${money(ledger.creditTotal, currency)} (${ledger.credits.length})`)
      }
      meta.push(`${t('tip.fetched')} ${balance?.fetchedAt ? clock(balance.fetchedAt) : t('common.never')}`)
      if (balance?.stale) meta.push(t('tip.stale'))

      const flags = []
      if (payload?.session?.unpriced?.length > 0) flags.push(t('tip.unpriced', { models: payload.session.unpriced.join(', ') }))
      if (ledger !== null && !ledger.totals.m1.covered) flags.push(t('tip.partial'))
      if (ledger !== null && ledger.rows.some((entry) => entry.coarse)) flags.push(t('tip.coarse'))

      const body = tab === 'days'
        ? h(DaysTable, { t, ledger, currency, key: 'days' })
        : tab === 'credits'
          ? h(Credits, { t, ledger, currency, key: 'credits' })
          : h(Settings, { t, state, key: 'settings' })

      return [
        h('div', { className: 'dshb_catch', key: 'catch', onClick: onClose }),
        h('div', { className: 'dshb_popover', key: 'popover', role: 'dialog', 'aria-label': t('card.title') }, [
          h('div', { className: 'dshb_popover_head', key: 'head' }, [
            h('div', { key: 'titles' }, [
              h('div', { className: 'dshb_modal_title', key: 't' }, t('card.title')),
              h('div', { className: 'dshb_modal_sub', key: 's' }, t('card.sub')),
            ]),
            h('button', { className: 'dshb_close', key: 'x', onClick: onClose, title: t('common.close') }, '×'),
          ]),
          h('div', { className: 'dshb_popover_body', key: 'body' }, [
            cards,
            h('div', { className: 'dshb_meta', key: 'meta' }, meta.join(' · ')),
            flags.length === 0 ? null : h('div', { className: 'dshb_flag', key: 'flags' }, flags.join(' · ')),
            h('div', { className: 'dshb_tabs', key: 'tabs' }, ['days', 'credits', 'settings'].map((id) =>
              h('button', {
                key: id,
                className: 'dshb_tab',
                'data-active': tab === id ? 'true' : 'false',
                onClick: () => setTab(id),
              }, t(`tab.${id}`)))),
            body,
          ]),
          h('div', { className: 'dshb_popover_foot', key: 'foot' }, [
            h('div', { className: 'dshb_footer', key: 'l' }, [
              h('span', { key: 'rule' }, `${t('footer.rule')}: `),
              h('a', {
                key: 'link',
                className: 'dshb_link',
                href: payload?.peak?.rule?.sourceUrl ?? 'https://api-docs.deepseek.com/quick_start/pricing',
                target: '_blank',
                rel: 'noreferrer',
              }, t('footer.ruleLink')),
              h('span', { key: 'verified' }, ` · ${payload?.peak?.rule?.verifiedOn ?? ''}`),
            ]),
            h('div', { className: 'dshb_footer', key: 'r' }, [
              h('button', {
                className: 'dshb_btn',
                key: 'refresh',
                onClick: () => store.forceRefresh().catch(() => {}),
              }, t('common.refresh')),
              h('span', { key: 'versions' }, `${t('footer.host', { version: payload?.host?.version ?? '?' })} · ${t('footer.client', { version: VERSION })}`),
            ]),
          ]),
        ]),
      ]
    }

    function DaysTable({ t, ledger, currency }) {
      const [drafts, setDrafts] = react.useState({})
      const [busy, setBusy] = react.useState('')
      const [error, setError] = react.useState('')
      if (ledger === null) return h('div', { className: 'dshb_footer' }, '…')

      const valueOf = (row) => Object.prototype.hasOwnProperty.call(drafts, row.key)
        ? drafts[row.key]
        : (row.override !== null ? String(row.override) : '')

      const commit = async (row) => {
        const raw = valueOf(row).trim()
        setBusy(row.key)
        setError('')
        try {
          await store.setOverride(row.key, raw === '' ? (row.computed > 0 ? row.computed : null) : Number(raw))
          setDrafts((current) => {
            const { [row.key]: _dropped, ...rest } = current
            return rest
          })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      }

      const rows = [...ledger.rows].reverse()
      return h('div', null, [
        error === '' ? null : h('div', { className: 'dshb_error', key: 'err' }, error),
        h('table', { className: 'dshb_table', key: 'table' }, [
          h('thead', { key: 'head' }, h('tr', null, [
            h('th', { key: 'd' }, t('days.date')),
            h('th', { className: 'dshb_num', key: 's' }, t('days.sampled')),
            h('th', { className: 'dshb_num', key: 'm' }, t('days.manual')),
            h('th', { key: 'f' }, t('days.actions')),
          ])),
          h('tbody', { key: 'body' }, rows.map((row) => h('tr', {
            key: row.key,
            'data-today': row.key === ledger.todayKey ? 'true' : 'false',
          }, [
            h('td', { key: 'd' }, `${dayLabel(row.key)}${row.key === ledger.todayKey ? ` · ${t('days.open')}` : ''}`),
            h('td', { className: 'dshb_num', key: 's' }, money(row.computed, currency)),
            h('td', { className: 'dshb_num', key: 'm' }, h('input', {
              className: 'dshb_input',
              value: valueOf(row),
              placeholder: '—',
              inputMode: 'decimal',
              onChange: (event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value })),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commit(row)
                if (event.key === 'Escape') {
                  setDrafts((current) => {
                    const { [row.key]: _dropped, ...rest } = current
                    return rest
                  })
                }
              },
              onBlur: () => {
                if (Object.prototype.hasOwnProperty.call(drafts, row.key) && drafts[row.key] !== (row.override ?? '')) void commit(row)
              },
            })),
            h('td', { key: 'a' }, h('div', { className: 'dshb_row_flags' }, [
              row.coarse ? h('span', { key: 'c', className: 'dshb_flag' }, t('days.coarse')) : null,
              row.override !== null ? h('button', {
                key: 'r',
                className: 'dshb_btn',
                disabled: busy === row.key,
                onClick: () => {
                  setDrafts((current) => {
                    const { [row.key]: _dropped, ...rest } = current
                    return rest
                  })
                  setBusy(row.key)
                  void store.setOverride(row.key, null).catch((cause) => setError(String(cause))).finally(() => setBusy(''))
                },
              }, t('days.reset')) : null,
            ])),
          ]))),
        ]),
      ])
    }

    function Credits({ t, ledger, currency }) {
      if (ledger === null) return h('div', { className: 'dshb_footer' }, '…')
      if (ledger.credits.length === 0) {
        return h('div', { className: 'dshb_footer' }, [h('span', { key: 'e' }, t('credits.empty')), h('span', { key: 'n' }, t('credits.note'))])
      }
      return h('div', { className: 'dshb_credits' }, [
        h('div', { className: 'dshb_footer', key: 'sum' }, [
          h('span', { key: 'l' }, `${t('tip.credits')}: ${money(ledger.creditTotal, currency)}`),
          h('span', { key: 'n' }, t('credits.note')),
        ]),
        ...ledger.credits.map((credit) => h('div', { className: 'dshb_credit', key: credit.t }, [
          h('span', { key: 'd' }, `${new Date(credit.t).toLocaleString()} `),
          h('span', { key: 'a' }, `+${money(credit.amount, currency)} → ${money(credit.toTotal, currency)}`),
        ])),
      ])
    }

    function Settings({ t, state }) {
      const [draft, setDraft] = react.useState(() => settingsOf(state.payload) ?? {})
      const [status, setStatus] = react.useState('')
      const [busy, setBusy] = react.useState(false)

      react.useEffect(() => {
        if (state.payload !== null) setDraft(settingsOf(state.payload))
      }, [state.payload])

      const field = (key, label, step) => h('label', { className: 'dshb_field', key }, [
        h('span', { key: 'l' }, label),
        h('input', {
          key: 'i',
          value: draft?.[key] ?? '',
          type: key === 'currency' || key === 'dayZone' ? 'text' : 'number',
          step,
          onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })),
        }),
      ])

      const apply = async () => {
        setBusy(true)
        setStatus('')
        try {
          const numbers = ['refreshIntervalMs', 'clientPollIntervalMs', 'warningThreshold', 'dangerThreshold', 'historyDays']
          const body = { currency: String(draft.currency ?? '').toUpperCase(), dayZone: String(draft.dayZone ?? 'local') }
          for (const key of numbers) {
            const value = Number(draft[key])
            if (Number.isFinite(value)) body[key] = key === 'historyDays' ? Math.round(value) : value
          }
          await store.saveSettings(body)
          setStatus(t('settings.saved'))
        } catch (cause) {
          setStatus(t('settings.failed', { error: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setBusy(false)
        }
      }

      return h('div', null, [
        h('div', { className: 'dshb_settings', key: 'grid' }, [
          field('currency', t('settings.currency')),
          field('dayZone', t('settings.dayZone')),
          field('refreshIntervalMs', t('settings.refresh'), 1000),
          field('clientPollIntervalMs', t('settings.poll'), 1000),
          field('warningThreshold', t('settings.warning')),
          field('dangerThreshold', t('settings.danger')),
          field('historyDays', t('settings.historyDays'), 1),
        ]),
        h('div', { className: 'dshb_footer', key: 'foot' }, [
          h('span', { key: 'note' }, t('settings.note')),
          h('span', { key: 'actions' }, [
            status === '' ? null : h('span', { key: 's', style: { marginRight: 8 } }, status),
            h('button', { key: 'a', className: 'dshb_btn dshb_btn_primary', disabled: busy, onClick: apply }, t('settings.apply')),
          ]),
        ]),
      ])
    }
    //#endregion

    //#region plugin
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, copy), 'dsh-balance: dictionaries')

      /** The model catalog snapshot, the same source the composer's picker reads. */
      const catalogSnapshot = () => {
        const directories = ctx.get('modelDirectories')
        if (directories === undefined) return undefined
        try {
          return directories.catalog.store.getSnapshot()
        } catch {
          return undefined
        }
      }

      // The readout is drawn before the shipped stats entry (`order: 0`), which puts
      // it immediately left of the turn counters on the same composer line.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-balance',
        order: -10,
        locale: NS,
      }, Readout))

      // The tariff chip keeps the surfaces of the standalone peaks plugin: the session
      // header, plus a floating copy for a fresh session whose header is hidden.
      const headerChip = { name: 'conversation.session.header.actions', id: 'dsh-balance-peak', order: -40, locale: NS }
      const overlayChip = { name: 'conversation.input.overlay', id: 'dsh-balance-peak', order: 10, locale: NS }
      ctx.slots.inject(headerChip.name, () => ctx.slots.register(headerChip, createPeakChip({ forNewSession: false, catalogSnapshot })))
      ctx.slots.inject(overlayChip.name, () => ctx.slots.register(overlayChip, createPeakChip({ forNewSession: true, catalogSnapshot })))

      // Catch up on return to the tab; the poller itself skips hidden pages.
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const onVisibility = () => {
          if (!document.hidden) void store.refresh()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, 'dsh-balance: visibility resume')
    }

    exports.apply = apply
    exports.inject = inject
    /**
     * Internals for the test suite only. The module loader reads `apply`/`inject`
     * and ignores everything else, so this adds no public surface to the plugin.
     */
    exports.__internals = {
      Readout, Popover, DaysTable, Credits, Settings, createPeakChip, createStore,
      money, duration, formatRemaining, statusLevel, phaseFromSchedule, effectiveRoute,
      routeFromModelSelection, routeFromCatalogDefault, isPeakRuleRoute, settingsOf, peakLines,
    }
    return module.exports
  },
})
