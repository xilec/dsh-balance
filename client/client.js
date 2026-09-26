/**
 * dsh-balance — browser half.
 *
 * Registers one chip into the shell overlay, anchored at the bottom-left of the
 * content area (just right of the sidebar): account balance plus spend over
 * 1 day / 1 week / 1 month, read from balance differences, plus this session's
 * token-based estimate beside them.
 *
 * Everything comes from the Host through `/dsh-balance`; this half never talks to
 * DeepSeek. Clicking the chip opens a card with the per-day ledger (each day
 * editable), the credit (top-up) events, and the sampling settings.
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

    //#region styles
    const CSS_ID = 'dsh-balance/styles.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-balance'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.dshb_anchor{position:absolute;bottom:10px;left:var(--dshb-left,12px);display:inline-flex;',
        'flex-direction:column;align-items:flex-start;z-index:21}',
        '.dshb_root{position:relative;display:inline-flex;align-items:center;gap:8px;',
        'padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));',
        'background:var(--dsw-alias-bg-layer-1,var(--dsw-hovercard-bg,rgba(255,255,255,.9)));',
        'color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;',
        'box-shadow:var(--dsw-shadow-lv2,0 2px 10px rgba(0,0,0,.12));cursor:pointer;user-select:none;',
        'backdrop-filter:blur(12px);white-space:nowrap}',
        '.dshb_root:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.4))}',
        '.dshb_dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
        '.dshb_dot_success{background:var(--dsw-alias-state-success-primary,#10b981)}',
        '.dshb_dot_warning{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
        '.dshb_dot_danger{background:var(--dsw-alias-state-error-primary,#ef4444)}',
        '.dshb_dot_idle{background:var(--dsw-alias-border-l3,rgba(128,128,128,.5))}',
        '.dshb_balance{font-weight:600}',
        '.dshb_sep{color:var(--dsw-alias-separator-primary,rgba(128,128,128,.4))}',
        '.dshb_metric{color:var(--dsw-alias-label-secondary,inherit)}',
        '.dshb_metric b{font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dshb_metric_muted{opacity:.65}',
        '.dshb_tip{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;min-width:280px;max-width:min(420px,92vw);',
        'padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));',
        'background:var(--dsw-alias-bg-layer-1,var(--dsw-hovercard-bg,#fff));color:var(--dsw-alias-label-primary);',
        'font-size:12px;line-height:1.6;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18));',
        'display:flex;flex-direction:column;gap:4px;cursor:default;white-space:normal}',
        '.dshb_tip_head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:600}',
        '.dshb_tip_row{display:flex;justify-content:space-between;gap:12px}',
        '.dshb_tip_row span:last-child{color:var(--dsw-alias-label-secondary,inherit)}',
        '.dshb_tip_note{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}',
        '.dshb_tip_flag{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
        '.dshb_backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
        'padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}',
        '.dshb_modal{width:min(720px,96vw);max-height:min(78vh,760px);display:flex;flex-direction:column;',
        'border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));',
        'background:var(--dsw-alias-bg-layer-1,var(--dsw-hovercard-bg,#fff));color:var(--dsw-alias-label-primary);',
        'box-shadow:var(--dsw-shadow-lv3,0 18px 48px rgba(0,0,0,.28));overflow:hidden}',
        '.dshb_modal_head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;',
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
        '.dshb_modal_title{font-size:14px;font-weight:600}',
        '.dshb_modal_sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshb_close{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:4px}',
        '.dshb_tabs{display:flex;gap:4px;padding:10px 16px 0}',
        '.dshb_tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
        'font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer}',
        '.dshb_tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));',
        'border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.25));color:var(--dsw-alias-label-primary)}',
        '.dshb_body{padding:12px 16px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}',
        '.dshb_cards{display:flex;gap:10px;flex-wrap:wrap}',
        '.dshb_card{flex:1 1 150px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;padding:10px 12px}',
        '.dshb_card_label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshb_card_value{font-size:18px;font-weight:600;margin-top:2px}',
        '.dshb_card_hint{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);margin-top:2px}',
        '.dshb_table{width:100%;border-collapse:collapse;font-size:12px}',
        '.dshb_table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);',
        'padding:6px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));position:sticky;top:0;',
        'background:var(--dsw-alias-bg-layer-1,var(--dsw-hovercard-bg,#fff))}',
        '.dshb_table td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.1))}',
        '.dshb_table tr[data-today="true"] td{font-weight:600}',
        '.dshb_num{text-align:right;font-variant-numeric:tabular-nums}',
        '.dshb_input{width:92px;text-align:right;font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,transparent);',
        'color:inherit;font-variant-numeric:tabular-nums}',
        '.dshb_row_flags{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}',
        '.dshb_btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;',
        'font:inherit;font-size:11.5px;padding:2px 8px;border-radius:6px;cursor:pointer}',
        '.dshb_btn:disabled{opacity:.5;cursor:default}',
        '.dshb_btn_primary{background:var(--dsw-alias-state-success-primary,#10b981);border-color:transparent;color:#fff}',
        '.dshb_settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}',
        '.dshb_field{display:flex;flex-direction:column;gap:3px;font-size:12px}',
        '.dshb_field span{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}',
        '.dshb_field input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;',
        'padding:4px 8px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px}',
        '.dshb_footer{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;',
        'color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshb_credits{display:flex;flex-direction:column;gap:4px;font-size:12px}',
        '.dshb_credit{display:flex;justify-content:space-between;gap:12px}',
        '.dshb_error{color:var(--dsw-alias-state-error-primary,#ef4444)}',
      ].join('')
      document.head.appendChild(tag)
    }
    //#endregion

    //#region copy
    const copy = {
      en: {
        'chip.balance': 'Balance',
        'chip.session': 'session',
        'chip.unknown': 'no data',
        'chip.reason.peak': 'peak rates',
        'chip.reason.off-peak': 'off-peak rates',
        'chip.reason.weekend': 'weekend, off-peak all day',
        'chip.reason.holiday': 'Chinese public holiday, off-peak all day',
        'tip.title': 'Account and spend',
        'tip.balance': 'Balance',
        'tip.toppedUp': 'Topped up',
        'tip.granted': 'Granted',
        'tip.spend1d': 'Last day',
        'tip.spend1w': 'Last 7 days',
        'tip.spend1m': 'Last 30 days',
        'tip.session': 'This session (estimate)',
        'tip.tariff': 'Tariff now',
        'tip.next': 'Next change',
        'tip.samples': 'Samples',
        'tip.cadence': 'Median gap',
        'tip.fetched': 'Balance read',
        'tip.credits': 'Credits in history',
        'tip.partial': 'partial: sampling started later',
        'tip.coarse': 'some days are marked coarse — the app was closed across a day boundary',
        'tip.unpriced': 'not priced: {models}',
        'tip.hint': 'Click for the per-day ledger, credits and sampling settings',
        'tip.error.api-key-missing': 'no API key found (DEEPSEEK_API_KEY)',
        'tip.stale': 'showing the last successful read',
        'card.title': 'DeepSeek balance and spend',
        'card.sub': 'spend is measured as the drop of the account balance, plus credits',
        'tab.days': 'Days',
        'tab.credits': 'Credits',
        'tab.settings': 'Settings',
        'card.balance': 'Balance',
        'card.today': 'Today',
        'card.week': '7 days',
        'card.month': '30 days',
        'card.session': 'This session',
        'card.unavailable': 'balance unavailable',
        'days.date': 'Day',
        'days.sampled': 'From samples',
        'days.manual': 'Manual',
        'days.actions': '',
        'days.coarse': 'coarse',
        'days.open': 'in progress',
        'days.reset': 'reset',
        'days.save': 'save',
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
        'settings.note': 'The host samples the balance on its own schedule — the chip only reads its cached payload.',
        'footer.rule': 'Rates and tariff rule',
        'footer.ruleLink': 'official page',
        'footer.host': 'host {version}',
        'footer.client': 'client {version}',
        'common.close': 'Close',
        'common.refresh': 'Refresh now',
        'common.never': 'never',
      },
      ru: {
        'chip.balance': 'Баланс',
        'chip.session': 'сессия',
        'chip.unknown': 'нет данных',
        'chip.reason.peak': 'пиковый тариф',
        'chip.reason.off-peak': 'льготный тариф',
        'chip.reason.weekend': 'выходные — весь день льготный тариф',
        'chip.reason.holiday': 'госпраздник КНР — весь день льготный тариф',
        'tip.title': 'Баланс и расход',
        'tip.balance': 'Баланс',
        'tip.toppedUp': 'Пополнено',
        'tip.granted': 'Подарочные',
        'tip.spend1d': 'За сутки',
        'tip.spend1w': 'За 7 дней',
        'tip.spend1m': 'За 30 дней',
        'tip.session': 'Эта сессия (оценка)',
        'tip.tariff': 'Тариф сейчас',
        'tip.next': 'Следующая смена',
        'tip.samples': 'Сэмплов',
        'tip.cadence': 'Медианный интервал',
        'tip.fetched': 'Баланс прочитан',
        'tip.credits': 'Пополнения в истории',
        'tip.partial': 'частично: сэмплирование началось позже',
        'tip.coarse': 'часть дней помечена как грубые — приложение было закрыто через границу суток',
        'tip.unpriced': 'без цены: {models}',
        'tip.hint': 'Клик — таблица по дням, пополнения и настройки опроса',
        'tip.error.api-key-missing': 'не найден ключ API (DEEPSEEK_API_KEY)',
        'tip.stale': 'показано последнее успешное чтение',
        'card.title': 'Баланс и расход DeepSeek',
        'card.sub': 'расход считается как падение баланса плюс пополнения',
        'tab.days': 'Дни',
        'tab.credits': 'Пополнения',
        'tab.settings': 'Настройки',
        'card.balance': 'Баланс',
        'card.today': 'Сегодня',
        'card.week': '7 дней',
        'card.month': '30 дней',
        'card.session': 'Эта сессия',
        'card.unavailable': 'баланс недоступен',
        'days.date': 'День',
        'days.sampled': 'Из сэмплов',
        'days.manual': 'Вручную',
        'days.actions': '',
        'days.coarse': 'грубо',
        'days.open': 'идёт',
        'days.reset': 'сброс',
        'days.save': 'ок',
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

    function compactMoney(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return money(value, currency, Math.abs(value) >= 10 ? 1 : 2)
    }

    function duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const minutes = Math.floor(ms / 60000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
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
    //#endregion

    //#region store
    const DEFAULT_POLL_MS = 15000

    /** Single shared poller: one reader per page, whichever chip is mounted. */
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

      const notify = () => {
        for (const listener of [...listeners]) listener()
      }

      async function read() {
        if (inflight !== null) {
          refetchRequested = true
          return inflight
        }
        const requestedSession = currentSessionId
        inflight = (async () => {
          try {
            const url = requestedSession === ''
              ? '/dsh-balance'
              : `/dsh-balance?sessionId=${encodeURIComponent(requestedSession)}`
            const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            pollMs = clamp(payload?.sampling?.clientPollIntervalMs ?? pollMs, 2000, 3600000)
            snapshot = { status: 'ok', payload, error: null, at: Date.now() }
            if (!helloSent) {
              helloSent = true
              void fetch('/dsh-balance/hello', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ version: VERSION }),
              }).catch(() => {})
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
          void read('timer').then(schedule, schedule)
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
        subscribe(listener) {
          listeners.add(listener)
          if (subscribers === 0) {
            void read('first').then(schedule, schedule)
          }
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
          void read('session').then(schedule, schedule)
        },
        refresh: () => read('manual'),
        async setOverride(date, amount) {
          const result = await post('/dsh-balance/overrides', { date, amount })
          await read('after-override')
          return result
        },
        async saveSettings(values) {
          const result = await post('/dsh-balance/settings', values)
          pollMs = clamp(result?.sampling?.clientPollIntervalMs ?? pollMs, 2000, 3600000)
          await read('after-settings')
          return result
        },
        forceRefresh: () => post('/dsh-balance/refresh', {}).then(() => read('after-refresh')),
      }
    }

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

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

    const store = createStore()

    const useStore = () => react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

    /**
     * The session the user is looking at.
     *
     * `shell.overlay` is a root-scope slot, so it gets root hooks but no
     * `sessionId`; the canonical root-scope way to find the session the main view
     * retains is the `useSessions` selector hook.
     */
    function useCurrentSessionId(useSessions) {
      return useSessions === undefined
        ? ''
        : useSessions((state) => {
          const rows = Object.values(state?.byId ?? {})
          return rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id ?? ''
        })
    }
    //#endregion

    //#region components
    const h = react.createElement

    function statusLevel(balance, thresholds) {
      if (balance === null || thresholds === undefined) return 'idle'
      if (balance <= thresholds.danger) return 'danger'
      if (balance <= thresholds.warning) return 'warning'
      return 'success'
    }

    function Chip(props) {
      const { t } = props
      const state = useStore()
      const sessionId = useCurrentSessionId(props.useSessions)
      const [open, setOpen] = react.useState(false)
      const [hover, setHover] = react.useState(false)
      const payload = state.payload
      const balance = payload?.balance ?? null
      const primary = balance?.primary ?? null
      const ledger = payload?.ledger ?? null
      const level = statusLevel(primary?.total ?? null, balance?.thresholds)
      const currency = balance?.currency ?? 'USD'
      const session = payload?.session ?? null

      react.useEffect(() => {
        store.setSessionId(sessionId)
      }, [sessionId])

      // The overlay layer spans the whole frame and publishes nothing about the
      // sidebar, so the chip measures the sidebar column itself: it is the frame's
      // first element child, and drag/collapse only resizes that column.
      react.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const layer = document.querySelector('[data-shell-overlay]')
        const frame = layer?.parentElement ?? null
        if (layer === null || frame === null) return undefined
        const sidebar = frame.firstElementChild
        const measure = () => {
          const right = sidebar === null ? 0 : sidebar.getBoundingClientRect().right
          layer.style.setProperty('--dshb-left', `${Math.round(right > 0 ? right + 8 : 12)}px`)
        }
        measure()
        const observer = new ResizeObserver(measure)
        if (sidebar !== null) observer.observe(sidebar)
        const mutations = new MutationObserver(measure)
        mutations.observe(frame, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed'] })
        return () => {
          observer.disconnect()
          mutations.disconnect()
        }
      }, [])

      const balanceText = primary === null
        ? t('chip.unknown')
        : `${t('chip.balance')} ${money(primary.total, currency)}`

      const metric = (label, value, covered = true) => h('span', {
        className: `dshb_metric${covered ? '' : ' dshb_metric_muted'}`,
        key: label,
      }, h('b', null, compactMoney(value, currency)), ` ${label}`)

      const chip = h('div', {
        className: 'dshb_root',
        role: 'button',
        tabIndex: 0,
        onClick: () => setOpen(true),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') setOpen(true)
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        title: t('tip.hint'),
      }, [
        h('span', { className: `dshb_dot dshb_dot_${level}`, key: 'dot' }),
        h('span', { className: 'dshb_balance', key: 'bal' }, balanceText),
        ledger === null ? null : h('span', { className: 'dshb_sep', key: 's1' }, '·'),
        ledger === null ? null : metric('1d', ledger.totals.d1.amount, ledger.totals.d1.covered),
        ledger === null ? null : metric('1w', ledger.totals.w1.amount, ledger.totals.w1.covered),
        ledger === null ? null : metric('1m', ledger.totals.m1.amount, ledger.totals.m1.covered),
        session === null ? null : h('span', { className: 'dshb_sep', key: 's2' }, '·'),
        session === null ? null : h('span', { className: 'dshb_metric', key: 'ses' },
          h('b', null, money(session.cost, session.currency ?? currency)), ` ${t('chip.session')}`),
      ])

      return h('div', { className: 'dshb_anchor' }, [
        hover && open === false ? h(Tooltip, { key: 'tip', t, state }) : null,
        chip,
        open ? h(Card, { key: 'card', t, state, onClose: () => setOpen(false) }) : null,
      ])
    }

    function Tooltip({ t, state }) {
      const payload = state.payload
      if (payload === null) return h('div', { className: 'dshb_tip' }, state.error ?? '…')
      const balance = payload.balance
      const ledger = payload.ledger
      const peak = payload.peak
      const primary = balance?.primary ?? null
      const currency = balance?.currency ?? 'USD'
      const rows = []
      const row = (label, value, key) => rows.push(h('div', { className: 'dshb_tip_row', key }, [
        h('span', { key: 'l' }, label),
        h('span', { key: 'v' }, value),
      ]))

      rows.push(h('div', { className: 'dshb_tip_head', key: 'head' }, [
        h('span', { key: 't' }, t('tip.title')),
        h('span', { key: 'r', className: state.status === 'error' ? 'dshb_error' : 'dshb_tip_note' },
          state.status === 'error' ? (state.error ?? '') : t(`chip.reason.${peak?.reason ?? 'off-peak'}`)),
      ]))
      if (primary !== null) {
        row(t('tip.balance'), money(primary.total, currency), 'bal')
        row(t('tip.toppedUp'), money(primary.toppedUp, currency), 'top')
        row(t('tip.granted'), money(primary.granted, currency), 'gra')
      } else {
        row(t('tip.balance'), balance?.error === 'api-key-missing' ? t('tip.error.api-key-missing') : t('card.unavailable'), 'bal')
      }
      if (ledger !== null) {
        row(t('tip.spend1d'), money(ledger.totals.d1.amount, currency), 'd1')
        row(t('tip.spend1w'), money(ledger.totals.w1.amount, currency), 'w1')
        row(t('tip.spend1m'), money(ledger.totals.m1.amount, currency), 'm1')
      }
      if (payload.session !== null) row(t('tip.session'), money(payload.session.cost, payload.session.currency ?? currency), 'ses')
      if (payload.session !== null && payload.session.unpriced?.length > 0) {
        rows.push(h('div', { className: 'dshb_tip_note dshb_tip_flag', key: 'unpriced' }, t('tip.unpriced', { models: payload.session.unpriced.join(', ') })))
      }
      if (peak?.changeAt !== null && peak?.changeAt !== undefined) {
        row(t('tip.next'), `${clock(peak.changeAt)} → ${t(`chip.reason.${peak.changeReason ?? 'peak'}`)} (${duration(peak.changeAt - Date.now())})`, 'next')
      }
      if (ledger !== null) {
        row(t('tip.samples'), `${ledger.sampleCount}`, 'samples')
        if (ledger.medianGapMs !== null) row(t('tip.cadence'), duration(ledger.medianGapMs), 'gap')
        if (!ledger.totals.m1.covered) rows.push(h('div', { className: 'dshb_tip_note dshb_tip_flag', key: 'partial' }, t('tip.partial')))
        if (ledger.rows.some((r) => r.coarse)) rows.push(h('div', { className: 'dshb_tip_note dshb_tip_flag', key: 'coarse' }, t('tip.coarse')))
        row(t('tip.credits'), `${money(ledger.creditTotal, currency)} (${ledger.credits.length})`, 'credits')
      }
      row(t('tip.fetched'), balance?.fetchedAt ? `${clock(balance.fetchedAt)}${balance.stale ? ` · ${t('tip.stale')}` : ''}` : t('common.never'), 'fetched')
      rows.push(h('div', { className: 'dshb_tip_note', key: 'hint' }, t('tip.hint')))
      return h('div', { className: 'dshb_tip' }, rows)
    }

    function Card({ t, state, onClose }) {
      const [tab, setTab] = react.useState('days')
      const payload = state.payload
      const currency = payload?.balance?.currency ?? 'USD'
      const ledger = payload?.ledger ?? null
      const balance = payload?.balance ?? null
      const primary = balance?.primary ?? null

      react.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const cards = h('div', { className: 'dshb_cards', key: 'cards' }, [
        h('div', { className: 'dshb_card', key: 'bal' }, [
          h('div', { className: 'dshb_card_label', key: 'l' }, t('card.balance')),
          h('div', { className: 'dshb_card_value', key: 'v' }, primary === null ? '—' : money(primary.total, currency)),
          h('div', { className: 'dshb_card_hint', key: 'h' }, primary === null
            ? (balance?.error ?? t('card.unavailable'))
            : `${t('tip.toppedUp')} ${money(primary.toppedUp, currency)} · ${t('tip.granted')} ${money(primary.granted, currency)}`),
        ]),
        h('div', { className: 'dshb_card', key: 'd1' }, [
          h('div', { className: 'dshb_card_label', key: 'l' }, t('card.today')),
          h('div', { className: 'dshb_card_value', key: 'v' }, ledger === null ? '—' : money(ledger.totals.d1.amount, currency)),
        ]),
        h('div', { className: 'dshb_card', key: 'w1' }, [
          h('div', { className: 'dshb_card_label', key: 'l' }, t('card.week')),
          h('div', { className: 'dshb_card_value', key: 'v' }, ledger === null ? '—' : money(ledger.totals.w1.amount, currency)),
        ]),
        h('div', { className: 'dshb_card', key: 'm1' }, [
          h('div', { className: 'dshb_card_label', key: 'l' }, t('card.month')),
          h('div', { className: 'dshb_card_value', key: 'v' }, ledger === null ? '—' : money(ledger.totals.m1.amount, currency)),
        ]),
        h('div', { className: 'dshb_card', key: 'ses' }, [
          h('div', { className: 'dshb_card_label', key: 'l' }, t('card.session')),
          h('div', { className: 'dshb_card_value', key: 'v' }, payload?.session === null || payload?.session === undefined
            ? '—'
            : money(payload.session.cost, payload.session.currency ?? currency)),
          h('div', { className: 'dshb_card_hint', key: 'h' }, payload?.peak === undefined ? '' : t(`chip.reason.${payload.peak.reason}`)),
        ]),
      ])

      const body = tab === 'days'
        ? h(DaysTable, { t, ledger, currency, key: 'days' })
        : tab === 'credits'
          ? h(Credits, { t, ledger, currency, key: 'credits' })
          : h(Settings, { t, state, key: 'settings' })

      return h('div', {
        className: 'dshb_backdrop',
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      }, h('div', { className: 'dshb_modal' }, [
        h('div', { className: 'dshb_modal_head', key: 'head' }, [
          h('div', { key: 'titles' }, [
            h('div', { className: 'dshb_modal_title', key: 't' }, t('card.title')),
            h('div', { className: 'dshb_modal_sub', key: 's' }, t('card.sub')),
          ]),
          h('button', { className: 'dshb_close', key: 'x', onClick: onClose, title: t('common.close') }, '×'),
        ]),
        h('div', { className: 'dshb_tabs', key: 'tabs' }, ['days', 'credits', 'settings'].map((id) =>
          h('button', {
            key: id,
            className: 'dshb_tab',
            'data-active': tab === id ? 'true' : 'false',
            onClick: () => setTab(id),
          }, t(`tab.${id}`)))),
        h('div', { className: 'dshb_body', key: 'body' }, [cards, body]),
        h('div', { className: 'dshb_modal_head', key: 'foot' }, [
          h('div', { className: 'dshb_footer', key: 'l' }, [
            h('span', { key: 'rule' }, `${t('footer.rule')}: `),
            h('a', {
              key: 'link',
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
      ]))
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
                if (event.key === 'Escape') setDrafts((current) => {
                  const { [row.key]: _dropped, ...rest } = current
                  return rest
                })
              },
              onBlur: () => {
                if (Object.prototype.hasOwnProperty.call(drafts, row.key) && drafts[row.key] !== (row.override ?? '')) void commit(row)
              },
            })),
            h('td', { key: 'a' }, h('div', { className: 'dshb_row_flags' }, [
              row.coarse ? h('span', { key: 'c', className: 'dshb_tip_flag' }, t('days.coarse')) : null,
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
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-balance',
        order: 50,
        locale: NS,
      }, Chip))

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
    return module.exports
  },
})
