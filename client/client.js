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

    /**
     * The platform's own usage view. Not part of the rule (the Host reports where
     * the rule was verified), so it is a plain constant of the panel.
     */
    const USAGE_URL = 'https://platform.deepseek.com/usage'

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
        '.dshb_tabs{display:flex;gap:4px;padding:10px 12px 0}',
        '.dshb_summary{display:flex;flex-direction:column;gap:10px}',
        // `min-height:0` is what lets the body scroll: a flex child defaults to
        // `min-height:auto`, which is the content height and would stretch the panel.
        '.dshb_popover_body{flex:1 1 auto;min-height:0;padding:10px 12px 12px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
        '.dshb_popover_head,.dshb_tabs,.dshb_popover_foot{flex:none}',
        '.dshb_popover_foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;padding:8px 12px;',
        'border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
        '.dshb_modal_title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dshb_modal_sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_close{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 4px}',
        '.dshb_rows{display:flex;flex-direction:column;gap:3px}',
        '.dshb_row{display:flex;justify-content:space-between;gap:12px}',
        '.dshb_row span:last-child{color:var(--dsw-alias-label-tertiary)}',
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
        '.dshb_footer{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
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
        // The Cost view: a plot drawn on a canvas with a DOM overlay for the bands,
        // the turn separators, the axis labels and the tooltip.
        '.dshb_cost{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;height:100%;padding:12px 14px;overflow:auto}',
        '.dshb_cost_head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px}',
        '.dshb_cost_total{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
        '.dshb_cost_sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
        '.dshb_cost_chart{display:flex;align-items:stretch;gap:6px}',
        '.dshb_cost_yaxis{position:relative;flex:none;width:58px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}',
        '.dshb_cost_ylabel{position:absolute;right:0;transform:translateY(-50%);white-space:nowrap}',
        '.dshb_cost_plot{position:relative;flex:1 1 auto;min-width:0;height:240px}',
        '.dshb_cost_grid{position:absolute;left:0;right:0;height:1px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.14));pointer-events:none}',
        '.dshb_cost_canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
        '.dshb_cost_band{position:absolute;top:0;bottom:0;background:rgba(245,158,11,.10);pointer-events:none}',
        '.dshb_cost_sep{position:absolute;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.28));pointer-events:none}',
        '.dshb_cost_axis{position:relative;height:16px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}',
        '.dshb_cost_tick{position:absolute;transform:translateX(-50%);white-space:nowrap}',
        '.dshb_cost_tooltip{position:absolute;z-index:2;pointer-events:none;transform:translate(-50%,-108%);white-space:nowrap;padding:6px 8px;',
        'border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));',
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-secondary);',
        'box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.14));font-size:11.5px;line-height:1.45;text-align:left}',
        '.dshb_cost_split{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;align-items:start}',
        '.dshb_cost_card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;padding:8px 10px;font-size:12px;max-width:560px;display:flex;flex-direction:column;gap:6px}',
        '.dshb_cost_actions{display:flex;gap:6px;align-items:center;margin-top:4px}',
        '.dshb_cost_kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;align-items:baseline}',
        '.dshb_cost_kv>.k{color:var(--dsw-alias-label-tertiary)}',
        '.dshb_cost_preview{white-space:pre-line;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
        // `align-self` keeps the table at its content width inside the flex card: the
        // card stays roomy, the columns do not drift apart.
        '.dshb_cost_table{border-collapse:collapse;margin:0;font-size:12px;font-variant-numeric:tabular-nums;align-self:flex-start}',
        '.dshb_cost_table th,.dshb_cost_table td{padding:1px 0 1px 0;text-align:right;font-weight:400;color:var(--dsw-alias-label-secondary)}',
        '.dshb_cost_table th{color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dshb_cost_table th:first-child,.dshb_cost_table td:first-child{text-align:left;color:var(--dsw-alias-label-tertiary);padding-right:16px}',
        '.dshb_cost_table th+th,.dshb_cost_table td+td{min-width:64px;padding-left:16px}',
        '.dshb_cost_table tr:last-child td{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
        '.dshb_cost_card b{color:var(--dsw-alias-label-primary);font-weight:600}',
        '.dshb_cost_mark{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;pointer-events:none;',
        'background:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff))}',
        '.dshb_cost_note{color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
        '.dshb_cost_empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;color:var(--dsw-alias-label-tertiary);font-size:12px}',
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
        'tip.tariff': 'Tariff now',
        'tip.next': 'Next change',
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
        'tab.summary': 'Summary',
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
        'days.growing': '+{amount} after the correction',
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
        'footer.usage': 'Platform usage',
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
        'view.cost': 'Cost',
        'cost.title': 'Session cost estimate',
        'cost.sub': 'per Step, priced at the tariff in force when the tokens were reported',
        'cost.totalLabel': 'Fact',
        'cost.steps': '{steps} steps',
        'cost.unpriced': 'not priced: {models}',
        'cost.bandNote': 'shaded: peak windows',
        'cost.clip': 'clipped above {value}',
        'cost.unclip': 'Remove clipping',
        'cost.retry': 'Retry',
        'cost.empty.steps': 'No Steps with usage yet — the chart fills as the session runs.',
        'cost.empty.rates': 'This session reported tokens, but no rate in the tariff rule applies to their models.',
        'cost.empty.error': 'Cannot read this session’s history.',
        'cost.tip.turn': 'Turn {turn} · Step {step}',
        'cost.bucket.in': 'in',
        'cost.bucket.out': 'out',
        'cost.bucket.cacheRead': 'cache read',
        'cost.bucket.cacheWrite': 'cache write',
        'cost.column.tokens': 'tokens',
        'cost.column.cost': 'cost',
        'cost.bucket.total': 'Σ',
        'cost.tip.phase.peak': 'peak rates',
        'cost.tip.phase.off-peak': 'off-peak rates',
        'cost.tip.share': '{share} of the session',
        'cost.tip.interval': '{from}–{to}',
        'cost.inspector.title': 'Step {turn}.{step}',
        'cost.inspector.empty': 'Select a Step in the chart to inspect it.',
        'cost.inspector.tokens': 'Tokens',
        'cost.inspector.cost': 'Cost',
        'cost.inspector.share': 'Share of session',
        'cost.inspector.interval': 'Interval',
        'cost.inspector.calls': 'Tool calls',
        'cost.inspector.noCalls': 'no tool calls in this Step',
        'cost.inspector.retries': '{count} retries',
        'cost.inspector.inProgress': 'in progress',
        'cost.inspector.interrupted': 'interrupted',
        'cost.inspector.unpriced': 'unpriced',
        'cost.inspector.prompt': 'Turn prompt',
        'cost.inspector.noPrompt': 'the conversation events are not loaded',
        'cost.inspector.loadOlder': 'Load older',
        'cost.inspector.loading': 'loading…',
        'cost.inspector.loadFailed': 'loading older events failed',
        'cost.inspector.noFocus': 'no focus target: this Step holds no tool call',
        'cost.inspector.focus': 'Show in Trajectory',
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
        'tip.tariff': 'Тариф сейчас',
        'tip.next': 'Следующая смена',
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
        'tab.summary': 'Сводка',
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
        'days.growing': '+{amount} после правки',
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
        'footer.usage': 'Расход на платформе',
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
        'view.cost': 'Стоимость',
        'cost.title': 'Оценка стоимости сессии',
        'cost.sub': 'по шагам, по тарифу на момент отчёта о токенах',
        'cost.totalLabel': 'Факт',
        'cost.steps': 'шагов: {steps}',
        'cost.unpriced': 'без цены: {models}',
        'cost.bandNote': 'заливка — пиковые окна',
        'cost.clip': 'обрезано выше {value}',
        'cost.unclip': 'Снять обрезку',
        'cost.retry': 'Повторить',
        'cost.empty.steps': 'Шагов с usage пока нет — график заполнится по ходу сессии.',
        'cost.empty.rates': 'Сессия отчиталась о токенах, но в тарифном правиле нет ставки для их моделей.',
        'cost.empty.error': 'Не удалось прочитать историю этой сессии.',
        'cost.tip.turn': 'Ход {turn} · шаг {step}',
        'cost.bucket.in': 'вход',
        'cost.bucket.out': 'выход',
        'cost.bucket.cacheRead': 'чтение кэша',
        'cost.bucket.cacheWrite': 'запись кэша',
        'cost.column.tokens': 'токены',
        'cost.column.cost': 'стоимость',
        'cost.bucket.total': 'Σ',
        'cost.tip.phase.peak': 'пиковый тариф',
        'cost.tip.phase.off-peak': 'льготный тариф',
        'cost.tip.share': '{share} от сессии',
        'cost.tip.interval': '{from}–{to}',
        'cost.inspector.title': 'Шаг {turn}.{step}',
        'cost.inspector.empty': 'Выбери шаг на графике, чтобы посмотреть детали.',
        'cost.inspector.tokens': 'Токены',
        'cost.inspector.cost': 'Стоимость',
        'cost.inspector.share': 'Доля от сессии',
        'cost.inspector.interval': 'Интервал',
        'cost.inspector.calls': 'Вызовы инструментов',
        'cost.inspector.noCalls': 'в этом шаге нет вызовов инструментов',
        'cost.inspector.retries': 'повторов: {count}',
        'cost.inspector.inProgress': 'идёт',
        'cost.inspector.interrupted': 'прерван',
        'cost.inspector.unpriced': 'без цены',
        'cost.inspector.prompt': 'Промпт хода',
        'cost.inspector.noPrompt': 'события беседы не загружены',
        'cost.inspector.loadOlder': 'Загрузить старые',
        'cost.inspector.loading': 'загружаю…',
        'cost.inspector.loadFailed': 'не удалось загрузить старые события',
        'cost.inspector.noFocus': 'нет цели фокуса: в этом шаге нет вызова инструмента',
        'cost.inspector.focus': 'Показать в Trajectory',
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

    /**
     * How many decimals a cost figure needs to stay readable.
     *
     * A Step is a fraction of a cent, so two decimals render most of a session as
     * `0.00`: the precision follows the magnitude instead, and the largest totals
     * keep the familiar two decimals.
     */
    function costDigits(value) {
      const abs = Math.abs(typeof value === 'number' && Number.isFinite(value) ? value : 0)
      if (abs === 0 || abs >= 0.1) return 2
      if (abs >= 0.01) return 3
      if (abs >= 0.001) return 4
      return 5
    }

    /** A cost figure with enough decimals for the per-Step scale. */
    function costText(value, currency) {
      return money(value, currency, costDigits(value))
    }

    /**
     * The decimals the cost column is printed with.
     *
     * The host resolves a bucket's cost to six decimals and builds the Step total
     * as the sum of those very values, so the column only adds up at that
     * resolution: six decimals as soon as a value has a fraction below the cent
     * scale, and the familiar two otherwise. One number for the whole column, so
     * the digits line up and the rows can be added by eye.
     */
    function costColumnDigits(values) {
      const fine = values.some((value) => {
        const abs = Math.abs(typeof value === 'number' && Number.isFinite(value) ? value : 0)
        return abs > 0 && Math.round(abs * 100) / 100 !== abs
      })
      return fine ? 6 : 2
    }

    /** A cost figure printed with an explicitly chosen number of decimals. */
    function costCell(value, currency, digits) {
      return money(value, currency, digits)
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

    /**
     * The pricing page, always the English one.
     *
     * The Host owns the rule (and the URL it was verified on), but a Host started
     * before a locale fix may still report the Chinese page; the panel is not the
     * place to reproduce that.
     */
    function rulesUrl(url) {
      if (typeof url !== 'string' || url === '') return 'https://api-docs.deepseek.com/quick_start/pricing'
      return url.replace('/zh-cn/', '/')
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
      lines.push(t('peak.source', { url: rulesUrl(peak.rule?.sourceUrl), date: peak.rule?.verifiedOn ?? '' }))
      return lines
    }

    /**
     * The panel behind the pill: the summary first, then the per-day ledger, the
     * credit events and the settings, anchored above the readout like the
     * token-usage dialogs rather than a full-screen modal.
     */
    function Popover({ t, state, projection, onClose }) {
      const [tab, setTab] = react.useState('summary')
      // The panel is exactly as tall as the summary it opens on: a shorter tab is
      // padded to that height instead of shrinking the panel under the pointer, and a
      // taller one scrolls inside the same frame. The height comes from the panel
      // element itself, so the header, the tab row and the footer are all counted.
      const panelRef = react.useRef(null)
      const [panelHeight, setPanelHeight] = react.useState(null)
      const payload = state.payload

      react.useEffect(() => {
        // Waiting for the payload matters: a click before the first read would
        // otherwise pin the panel to the height of an empty summary.
        if (tab !== 'summary' || panelHeight !== null || payload === null) return
        const height = panelRef.current?.offsetHeight
        if (typeof height === 'number' && height > 0) setPanelHeight(height)
      }, [tab, panelHeight, payload])

      const body = tab === 'summary'
        ? h(Summary, { t, state, projection, key: 'summary' })
        : tab === 'days'
          ? h(DaysTable, { t, ledger: payload?.ledger ?? null, currency: payload?.balance?.currency ?? 'USD', key: 'days' })
          : tab === 'credits'
            ? h(Credits, { t, ledger: payload?.ledger ?? null, currency: payload?.balance?.currency ?? 'USD', key: 'credits' })
            : h(Settings, { t, state, key: 'settings' })

      return [
        h('div', { className: 'dshb_catch', key: 'catch', onClick: onClose }),
        h('div', {
          className: 'dshb_popover',
          key: 'popover',
          ref: panelRef,
          role: 'dialog',
          'aria-label': t('card.title'),
          // `max-height` in the stylesheet still wins in a short window.
          style: panelHeight === null ? undefined : { height: `${panelHeight}px` },
        }, [
          h('div', { className: 'dshb_popover_head', key: 'head' }, [
            h('div', { key: 'titles' }, [
              h('div', { className: 'dshb_modal_title', key: 't' }, t('card.title')),
              h('div', { className: 'dshb_modal_sub', key: 's' }, t('card.sub')),
            ]),
            h('button', { className: 'dshb_close', key: 'x', onClick: onClose, title: t('common.close') }, '×'),
          ]),
          h('div', { className: 'dshb_tabs', key: 'tabs' }, ['summary', 'days', 'credits', 'settings'].map((id) =>
            h('button', {
              key: id,
              className: 'dshb_tab',
              'data-active': tab === id ? 'true' : 'false',
              onClick: () => setTab(id),
            }, t(`tab.${id}`)))),
          h('div', { className: 'dshb_popover_body', key: 'body' }, body),
          h('div', { className: 'dshb_popover_foot', key: 'foot' }, [
            h('div', { className: 'dshb_footer', key: 'l' }, [
              h('span', { key: 'rule' }, `${t('footer.rule')}: `),
              h('a', {
                key: 'link',
                className: 'dshb_link',
                href: rulesUrl(payload?.peak?.rule?.sourceUrl),
                target: '_blank',
                rel: 'noreferrer',
              }, t('footer.ruleLink')),
              h('span', { key: 'verified' }, ` · ${payload?.peak?.rule?.verifiedOn ?? ''}`),
              h('span', { key: 'sep' }, ' · '),
              h('a', {
                key: 'usage',
                className: 'dshb_link',
                href: USAGE_URL,
                target: '_blank',
                rel: 'noreferrer',
              }, t('footer.usage')),
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

    /**
     * The opening tab: the account cards plus every figure the plugin knows, which
     * is what the old hover tooltip used to spell out.
     */
    function Summary({ t, state, projection }) {
      const payload = state.payload
      const currency = payload?.balance?.currency ?? 'USD'
      const ledger = payload?.ledger ?? null
      const balance = payload?.balance ?? null
      const primary = balance?.primary ?? null
      const peak = payload?.peak ?? null
      const sessionCost = projection?.cost ?? payload?.session?.cost ?? null
      const sessionCurrency = projection?.currency ?? payload?.session?.currency ?? currency

      const card = (key, label, value, hint) => h('div', { className: 'dshb_card', key }, [
        h('div', { className: 'dshb_card_label', key: 'l' }, label),
        h('div', { className: 'dshb_card_value', key: 'v' }, value),
        hint === undefined ? null : h('div', { className: 'dshb_card_hint', key: 'h' }, hint),
      ])

      // Balance, today and this session on the first row; then the two rolling
      // totals, week first, month after it.
      const cards = h('div', { className: 'dshb_cards', key: 'cards' }, [
        card('bal', t('card.balance'),
          primary === null ? '—' : money(primary.total, currency),
          primary === null
            ? (balance?.error === 'api-key-missing' ? t('tip.error.api-key-missing') : t('card.unavailable'))
            : `${t('tip.toppedUp')} ${money(primary.toppedUp, currency)} · ${t('tip.granted')} ${money(primary.granted, currency)}`),
        card('d1', t('card.today'), ledger === null ? '—' : money(ledger.totals.d1.amount, currency)),
        card('ses', t('card.session'), sessionCost === null ? '—' : money(sessionCost, sessionCurrency),
          peak === null ? undefined : t(`reason.${peak.phase ?? 'off-peak'}`)),
        card('w1', t('card.week'), ledger === null ? '—' : money(ledger.totals.w1.amount, currency)),
        card('m1', t('card.month'), ledger === null ? '—' : money(ledger.totals.m1.amount, currency)),
      ])

      const rows = []
      const row = (label, value) => rows.push(h('div', { className: 'dshb_row', key: label }, [
        h('span', { key: 'l' }, label),
        h('span', { key: 'v' }, value),
      ]))
      row(t('tip.balance'), primary === null ? '—' : money(primary.total, currency))
      if (primary !== null) {
        row(t('tip.toppedUp'), money(primary.toppedUp, currency))
        row(t('tip.granted'), money(primary.granted, currency))
      }
      if (ledger !== null) {
        row(t('tip.spend1d'), money(ledger.totals.d1.amount, currency))
        row(t('tip.spend1w'), money(ledger.totals.w1.amount, currency))
        row(t('tip.spend1m'), money(ledger.totals.m1.amount, currency))
      }
      row(t('tip.session'), sessionCost === null ? '—' : money(sessionCost, sessionCurrency))
      if (peak !== null) {
        row(t('tip.tariff'), t(`reason.${peak.phase ?? 'off-peak'}`))
        if (peak.changeAt !== null && peak.changeAt !== undefined) {
          row(t('tip.next'), `${clock(peak.changeAt)} · ${formatRemaining(peak.untilMs ?? 0)}`)
        }
      }
      if (ledger !== null) {
        row(t('tip.samples'), `${ledger.sampleCount}`)
        if (ledger.medianGapMs !== null) row(t('tip.cadence'), duration(ledger.medianGapMs))
        row(t('tip.credits'), `${money(ledger.creditTotal, currency)} (${ledger.credits.length})`)
      }
      row(t('tip.fetched'), balance?.fetchedAt
        ? `${clock(balance.fetchedAt)}${balance.stale ? ` · ${t('tip.stale')}` : ''}`
        : t('common.never'))

      const flags = []
      if (payload?.session?.unpriced?.length > 0) flags.push(t('tip.unpriced', { models: payload.session.unpriced.join(', ') }))
      if (ledger !== null && !ledger.totals.m1.covered) flags.push(t('tip.partial'))
      if (ledger !== null && ledger.rows.some((entry) => entry.coarse)) flags.push(t('tip.coarse'))

      return h('div', { className: 'dshb_summary' }, [
        cards,
        h('div', { className: 'dshb_rows', key: 'rows' }, rows),
        flags.length === 0 ? null : h('div', { className: 'dshb_flag', key: 'flags' }, flags.join(' · ')),
      ])
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
              row.measuredAfter > 0
                ? h('span', { key: 'g', className: 'dshb_flag' }, t('days.growing', { amount: money(row.measuredAfter, currency) }))
                : null,
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

    //#region cost view
    /** The figure one Step contributes to a metric. */
    function metricOf(node, metric = 'cost') {
      const buckets = node?.buckets ?? {}
      if (metric === 'output') return buckets.output ?? 0
      if (metric === 'cacheRead') return buckets.cacheRead ?? 0
      if (metric === 'cacheWrite') return buckets.cacheWrite ?? 0
      if (metric === 'tokens') {
        return (buckets.uncachedInput ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0)
      }
      return node?.cost ?? 0
    }

    /** A linear map from a data domain onto a pixel range. */
    function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
      const span = domainMax - domainMin
      if (!(span > 0)) return () => rangeMin
      return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin)
    }

    /**
     * The clipping threshold of a visible range: ten times its 95th percentile.
     *
     * `null` means nothing is clipped — either there is nothing to plot, or every
     * value is zero and there is no scale to flatten.
     */
    function clipThreshold(values) {
      const positive = values.filter((value) => value > 0)
      if (positive.length === 0) return null
      const sorted = [...positive].sort((a, b) => a - b)
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      return p95 > 0 ? p95 * 10 : null
    }

    /**
     * Per-pixel-column min/max of the plotted points.
     *
     * The chart draws one vertical bar per column instead of every point, which is
     * what keeps a 10⁴-Step history interactive.
     *
     * @param points - `[{ x, y }]` with `x` in pixels, ascending.
     * @param columns - pixel columns available.
     * @returns `{ bars, marks }`: the min/max bar of each column and the newest
     * point of each column (the marker the chart draws).
     */
    function decimatePoints(points, columns) {
      const bars = []
      const marks = []
      const width = Math.max(1, Math.floor(columns))
      for (const point of points) {
        const column = Math.max(0, Math.min(width - 1, Math.floor(point.x)))
        const last = bars[bars.length - 1]
        if (last === undefined || last.column !== column) {
          bars.push({ column, x: point.x, min: point.y, max: point.y, last: point })
        } else {
          last.min = Math.min(last.min, point.y)
          last.max = Math.max(last.max, point.y)
          last.last = point
        }
      }
      for (const bar of bars) marks.push(bar.last)
      return { bars, marks }
    }

    /**
     * A rounded vertical scale: a step from the 1/2/2.5/5/10 ladder and the values
     * under it, so the axis reads `0 / 0.005 / 0.01 …` instead of an odd maximum.
     *
     * @param top - the largest value to fit.
     * @param count - how many intervals the axis is divided into.
     * @returns `{ max, ticks: [{ value, fraction }] }`, ascending.
     */
    function valueAxis(top, count = 4) {
      const intervals = Math.max(1, Math.floor(count))
      if (!(top > 0) || !Number.isFinite(top)) {
        return { max: 1, ticks: [{ value: 0, fraction: 0 }, { value: 1, fraction: 1 }] }
      }
      const rough = top / intervals
      const magnitude = 10 ** Math.floor(Math.log10(rough))
      const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough - 1e-12) ?? magnitude * 10
      const max = step * intervals
      const ticks = []
      for (let index = 0; index <= intervals; index += 1) {
        ticks.push({ value: step * index, fraction: index / intervals })
      }
      return { max, ticks }
    }

    /** A short number for token axes: 1.2k, 3.4M. */
    function compactNumber(value) {
      const abs = Math.abs(value)
      if (!Number.isFinite(abs)) return '—'
      if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
      if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
      return String(Math.round(value))
    }

    /** The label of one vertical tick under the selected metric. */
    function tickLabel(value, metric, currency) {
      return metric === 'cost' ? costText(value, currency) : compactNumber(value)
    }

    /** The instant window the series spans, with a one-millisecond floor. */
    function seriesWindow(nodes) {
      if (nodes.length === 0) return { fromMs: 0, toMs: 1 }
      let fromMs = nodes[0].tStart
      let toMs = nodes[0].tEnd ?? nodes[0].tStart
      for (const node of nodes) {
        if (node.tStart < fromMs) fromMs = node.tStart
        const end = node.tEnd ?? node.tStart
        if (end > toMs) toMs = end
      }
      return { fromMs, toMs: toMs > fromMs ? toMs : fromMs + 1 }
    }

    /** The tariff phase of one instant, from the absolute windows the Host sent. */
    function phaseOf(ts, intervals) {
      for (const interval of intervals ?? []) {
        if (ts >= interval.startMs && ts < interval.endMs) return 'peak'
      }
      return 'off-peak'
    }

    /** Absolute peak windows as fractions of the plotted range, clipped to it. */
    function bandRanges(intervals, fromMs, toMs) {
      const span = toMs - fromMs
      if (!(span > 0)) return []
      const bands = []
      for (const interval of intervals ?? []) {
        const from = Math.max(0, (interval.startMs - fromMs) / span)
        const to = Math.min(1, (interval.endMs - fromMs) / span)
        if (to > from) bands.push({ from, to })
      }
      return bands
    }

    /** The first Step of every Turn, as a fraction of the plotted range. */
    function turnSeparators(nodes, fromMs, toMs) {
      const span = toMs - fromMs
      if (!(span > 0)) return []
      const seen = new Set()
      const separators = []
      for (const node of nodes) {
        if (seen.has(node.turn)) continue
        seen.add(node.turn)
        separators.push({ turn: node.turn, x: Math.max(0, Math.min(1, (node.tStart - fromMs) / span)) })
      }
      return separators
    }

    /** The totals the header and the tooltip shares are computed from. */
    function seriesSummary(nodes) {
      let total = 0
      let tokens = 0
      const models = []
      const unpriced = []
      for (const node of nodes) {
        total += node.cost ?? 0
        tokens += metricOf(node, 'tokens')
        for (const model of Object.keys(node.byModel ?? {})) if (!models.includes(model)) models.push(model)
        if (node.unpriced === true) {
          for (const model of Object.keys(node.byModel ?? {})) if (!unpriced.includes(model)) unpriced.push(model)
        }
      }
      return { total, tokens, steps: nodes.length, models, unpriced }
    }

    /**
     * Which of the three states the view is in.
     *
     * `empty-steps` and `empty-rates` are the two in-place empty states; the third
     * state, a failed read, is the error the route or the fetch reported.
     */
    function seriesState(status, payload, nodes, summary) {
      if (status === 'error' || payload?.ok === false) return 'error'
      if (status === 'loading' && payload === null) return 'loading'
      if (nodes.length === 0 || summary.steps === 0) return 'empty-steps'
      const priced = nodes.some((node) => node.cost > 0)
      if (!priced && summary.unpriced.length > 0) return 'empty-rates'
      if (!priced && summary.tokens === 0) return 'empty-steps'
      return 'ok'
    }

    /** The instant range the plot covers, and the ticks the axis shows. */
    function plotTicks(fromMs, toMs, count = 4) {
      if (!(toMs > fromMs)) return []
      const ticks = []
      for (let index = 0; index <= count; index += 1) {
        const at = fromMs + ((toMs - fromMs) * index) / count
        ticks.push({ at, x: index / count })
      }
      return ticks
    }

    /**
     * The pixel-space model of the chart.
     *
     * @param nodes - the per-Step records the route served.
     * @param options - `width`, `height`, `metric`, `clip` and `axis`.
     * @returns points (with their Step), the decimated bars and marks, the
     * clipping threshold and the value the Y axis tops out at.
     */
    function buildPlot(nodes, options = {}) {
      const { width = 720, height = 240, metric = 'cost', clip = true, axis = 'time' } = options
      const { fromMs, toMs } = seriesWindow(nodes)
      const values = nodes.map((node) => metricOf(node, metric))
      const threshold = clip ? clipThreshold(values) : null
      const capped = values.map((value) => (threshold !== null && value > threshold ? threshold : value))
      const scale = valueAxis(Math.max(0, ...capped))
      const max = scale.max
      const xOf = axis === 'index'
        ? linearScale(0, Math.max(1, nodes.length - 1), 0, width)
        : linearScale(fromMs, toMs, 0, width)
      const yOf = linearScale(0, max, height, 0)
      const points = nodes.map((node, index) => {
        const value = values[index]
        const clipped = threshold !== null && value > threshold
        const x = axis === 'index' ? xOf(index) : xOf(node.tStart)
        return { index, node, value, clipped, x, y: yOf(clipped ? threshold : value) }
      })
      const { bars, marks } = decimatePoints(points, Math.max(1, Math.floor(width)))
      const digest = `${points.length}:${Math.round(points.reduce((sum, point) => sum + point.value, 0) * 1e6)}`
      return { points, bars, marks, threshold, max, axis: scale, metric, fromMs, toMs, width, height, xOf, yOf, digest }
    }

    /** The colors the plot paints with, read from the theme tokens when available. */
    function plotColors(element) {
      const read = (name, fallback) => {
        if (typeof getComputedStyle !== 'function' || element === null || element === undefined) return fallback
        try {
          const value = getComputedStyle(element).getPropertyValue(name).trim()
          return value === '' ? fallback : value
        } catch {
          return fallback
        }
      }
      return {
        accent: read('--dsw-alias-state-info-primary', '#3b82f6'),
        clipped: read('--dsw-alias-state-warn-primary', '#f59e0b'),
        base: read('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
        stem: read('--dsw-alias-label-caption', 'rgba(128,128,128,0.45)'),
      }
    }

    /** Paint the plot: stems, the decimated step line and its markers. */
    function drawPlot(canvas, plot) {
      if (canvas === null || canvas === undefined || typeof canvas.getContext !== 'function') return
      const context = canvas.getContext('2d')
      if (context === null || context === undefined) return
      const ratio = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
      canvas.width = Math.max(1, Math.round(plot.width * ratio))
      canvas.height = Math.max(1, Math.round(plot.height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, plot.width, plot.height)

      const colors = plotColors(canvas)
      const baseline = plot.height - 0.5
      context.strokeStyle = colors.base
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(0, baseline)
      context.lineTo(plot.width, baseline)
      context.stroke()

      // Stems: from the baseline to every plotted point of a column.
      context.strokeStyle = colors.stem
      for (const bar of plot.bars) {
        context.beginPath()
        context.moveTo(bar.x, baseline)
        context.lineTo(bar.x, bar.min)
        context.stroke()
      }

      // The step line, with the min/max extent of each pixel column.
      context.strokeStyle = colors.accent
      context.lineWidth = 1.5
      for (const bar of plot.bars) {
        context.beginPath()
        context.moveTo(bar.x, bar.max)
        context.lineTo(bar.x, Math.max(bar.min, 1))
        context.stroke()
      }
      context.beginPath()
      plot.bars.forEach((bar, index) => {
        const y = bar.last.y
        if (index === 0) context.moveTo(bar.x, y)
        else context.lineTo(bar.x, y)
      })
      context.stroke()

      // Markers: the newest point of each column, hollow when its value is clipped.
      for (const mark of plot.marks) {
        context.beginPath()
        context.arc(mark.x, mark.y, 2.4, 0, Math.PI * 2)
        context.fillStyle = mark.clipped ? colors.clipped : colors.accent
        context.fill()
      }
    }

    /**
     * One line describing a token bucket set, input and output first: those are
     * what a Step actually consumed, the caches are how the input was served.
     */
    function bucketLine(buckets) {
      return [
        `${buckets?.uncachedInput ?? 0} in`,
        `${buckets?.output ?? 0} out`,
        `${buckets?.cacheRead ?? 0} cache read`,
        `${buckets?.cacheWrite ?? 0} cache write`,
      ].join(' · ')
    }

    /** The localized phase word for a Step, from the Host's absolute peak windows. */
    function nodePhase(node, intervals) {
      return `cost.tip.phase.${phaseOf(node.tStart, intervals)}`
    }

    /**
     * Fetch one session's series, re-reading it whenever the projection's `seq`
     * moves. The first read is the whole series: there is no paging and no button.
     */
    function useCostSeries(sessionId, seq) {
      const [snapshot, setSnapshot] = react.useState({ status: 'loading', payload: null, error: null })
      const [attempt, setAttempt] = react.useState(0)
      react.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || typeof fetch !== 'function') {
          setSnapshot({ status: 'error', payload: null, error: 'no-session' })
          return undefined
        }
        let cancelled = false
        // A re-read keeps the last result on screen until the new one lands: the
        // header must not flicker back to an empty plot between two tails.
        setSnapshot((current) => (current.payload === null && current.error === null
          ? { ...current, status: 'loading' }
          : current))
        fetch(`/dsh-balance/session-cost?sessionId=${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (cancelled) return
            const failed = payload?.ok === false
            setSnapshot({ status: failed ? 'error' : 'ok', payload: failed ? null : payload, error: failed ? payload.error : null })
          })
          .catch((error) => {
            if (cancelled) return
            setSnapshot({ status: 'error', payload: null, error: error instanceof Error ? error.message : String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [sessionId, seq, attempt])
      return { ...snapshot, retry: () => setAttempt((value) => value + 1) }
    }

    /**
     * The Cost view: the per-Step chart with its tooltip and inspector.
     */
    function CostView(props) {
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const projection = typeof props.useProjection === 'function' ? props.useProjection('dshBalanceCost') : undefined
      const series = useCostSeries(sessionId, projection?.seq ?? 0)
      const [selected, setSelected] = react.useState(-1)
      const [clip, setClip] = react.useState(true)
      const payload = series.payload
      // A Step that reported no usage has no point to draw; the empty state below
      // is what says so, instead of a chart of zeroes.
      const nodes = (Array.isArray(payload?.nodes) ? payload.nodes : []).filter((node) => node.hasUsage === true)
      const summary = seriesSummary(nodes)
      const currency = payload?.currency ?? projection?.currency ?? 'USD'
      const state = seriesState(series.status, payload, nodes, summary)
      // Without a payload there is no figure to lead with: a dash beats a `$0.00`
      // that would read as "this session cost nothing".
      const total = payload === null ? null : summary.total

      const head = h('div', { className: 'dshb_cost_head', key: 'head' }, [
        h('span', { className: 'dshb_cost_total', key: 'total' }, costText(total, currency)),
        payload === null ? null : h('span', { className: 'dshb_cost_sub', key: 'label' }, t('cost.totalLabel')),
        payload === null ? null : h('span', { className: 'dshb_cost_sub', key: 'steps' }, t('cost.steps', { steps: summary.steps })),
        payload?.peakIntervals?.length > 0 ? h('span', { className: 'dshb_cost_sub', key: 'bands' }, t('cost.bandNote')) : null,
        summary.unpriced.length > 0
          ? h('span', { className: 'dshb_flag', key: 'unpriced' }, t('cost.unpriced', { models: summary.unpriced.join(', ') }))
          : null,
      ])

      if (state !== 'ok') {
        return h('div', { className: 'dshb_cost' }, [head, h(CostEmpty, { t, key: 'empty', state, error: series.error, onRetry: series.retry })])
      }

      const plot = buildPlot(nodes, { clip, axis: 'time' })
      const clipped = plot.points.some((point) => point.clipped)
      const note = h('div', { className: 'dshb_cost_note', key: 'note' }, [
        h('span', { key: 'clip' }, clipped ? `${t('cost.clip', { value: costText(plot.threshold, currency) })} ` : ''),
        clipped ? h('button', { key: 'unclip', className: 'dshb_btn', onClick: () => setClip(false) }, t('cost.unclip')) : null,
      ])

      return h('div', { className: 'dshb_cost' }, [
        head,
        h(CostChart, {
          key: 'chart',
          t,
          nodes,
          payload,
          clip,
          currency,
          total,
          selected,
          onSelect: setSelected,
        }),
        note,
        h(CostInspector, {
          key: 'inspector',
          t,
          node: selected >= 0 && selected < nodes.length ? nodes[selected] : null,
          currency,
          total,
          peakIntervals: payload?.peakIntervals ?? [],
          inspectCall: props.inspectCall,
          loadOlder: props.loadOlder,
        }),
      ])
    }

    /** The in-place empty and error states: they explain themselves, no blank plot. */
    function CostEmpty({ t, state, error, onRetry }) {
      const message = state === 'error'
        ? `${t('cost.empty.error')}${error === null || error === undefined ? '' : ` (${error})`}`
        : state === 'empty-rates'
          ? t('cost.empty.rates')
          : t('cost.empty.steps')
      return h('div', { className: 'dshb_cost_empty' }, [
        h('span', { key: 'text' }, message),
        state === 'error' ? h('button', { key: 'retry', className: 'dshb_btn', onClick: onRetry }, t('cost.retry')) : null,
      ])
    }

    function CostChart({ t, nodes, payload, clip, currency, total, selected, onSelect }) {
      const boxRef = react.useRef(null)
      const canvasRef = react.useRef(null)
      const tooltipRef = react.useRef(null)
      const [size, setSize] = react.useState({ width: 720, height: 240 })
      const [tip, setTip] = react.useState({ width: 0, height: 0 })
      const [hover, setHover] = react.useState(-1)
      const plot = buildPlot(nodes, { width: size.width, height: size.height, clip, axis: 'time' })
      const intervals = payload?.peakIntervals ?? []

      react.useEffect(() => {
        const box = boxRef.current
        if (box === null || box === undefined || typeof box.getBoundingClientRect !== 'function') return undefined
        const measure = () => {
          const rect = box.getBoundingClientRect()
          if (rect.width > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) || 240 })
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(box)
          return () => observer.disconnect()
        }
        return undefined
      }, [])

      react.useEffect(() => {
        drawPlot(canvasRef.current, plot)
      }, [plot.digest, size.width, size.height])

      // The tooltip is measured after it renders, so the clamp uses its real size
      // and not a guess that would still let it poke out at the edge.
      react.useEffect(() => {
        const element = tooltipRef.current
        if (element === null || element === undefined) return
        const width = element.offsetWidth
        const height = element.offsetHeight
        if (typeof width === 'number' && width > 0 && (width !== tip.width || height !== tip.height)) {
          setTip({ width, height })
        }
      })

      /** The plotted point nearest to the pointer, within a small radius. */
      const nearest = (event) => {
        const box = boxRef.current
        if (box === null || box === undefined || typeof box.getBoundingClientRect !== 'function') return -1
        const rect = box.getBoundingClientRect()
        const x = event.clientX - rect.left
        let best = -1
        let distance = Infinity
        plot.points.forEach((point, index) => {
          const away = Math.abs(point.x - x)
          if (away < distance) {
            distance = away
            best = index
          }
        })
        return distance <= 24 ? best : -1
      }

      const bands = bandRanges(intervals, plot.fromMs, plot.toMs).map((band, index) => h('div', {
        key: `band-${index}`,
        className: 'dshb_cost_band',
        style: { left: `${band.from * 100}%`, width: `${(band.to - band.from) * 100}%` },
      }))
      const separators = turnSeparators(nodes, plot.fromMs, plot.toMs).map((separator, index) => h('div', {
        key: `sep-${index}`,
        className: 'dshb_cost_sep',
        style: { left: `${separator.x * 100}%` },
      }))
      const gridlines = plot.axis.ticks.map((tick, index) => h('div', {
        key: `grid-${index}`,
        className: 'dshb_cost_grid',
        style: { top: `${plot.yOf(tick.value)}px` },
      }))
      const yLabels = plot.axis.ticks.map((tick, index) => h('span', {
        key: `ylabel-${index}`,
        className: 'dshb_cost_ylabel',
        // The first and last labels sit on the plot's edges, so they are nudged
        // inside instead of hanging half outside the axis column.
        style: { top: `${Math.min(Math.max(plot.yOf(tick.value), 7), Math.max(7, plot.height - 7))}px` },
      }, tickLabel(tick.value, plot.metric, currency)))
      const ticks = plotTicks(plot.fromMs, plot.toMs).map((tick, index) => h('span', {
        key: `tick-${index}`,
        className: 'dshb_cost_tick',
        style: { left: `${tick.x * 100}%` },
      }, clock(tick.at) ?? ''))

      const hovered = hover >= 0 && hover < plot.points.length ? plot.points[hover] : null
      const placement = hovered === null ? null : tooltipPlacement(hovered, {
        width: plot.width,
        height: plot.height,
        tipWidth: tip.width === 0 ? 180 : tip.width,
        tipHeight: tip.height === 0 ? 72 : tip.height,
      })
      const tooltip = hovered === null ? null : h('div', {
        key: 'tooltip',
        ref: tooltipRef,
        className: 'dshb_cost_tooltip',
        style: { left: `${placement.left}px`, top: `${placement.top}px`, transform: placement.transform },
      }, tooltipLines(hovered.node, { t, currency, total, intervals })
        .map((line, index) => h('div', { key: `line-${index}` }, line)))

      const marker = selected >= 0 && selected < plot.points.length ? h('div', {
        key: 'marker',
        className: 'dshb_cost_mark',
        style: { left: `${plot.points[selected].x}px`, top: `${plot.points[selected].y}px` },
      }) : null

      return h('div', null, [
        h('div', { key: 'chart', className: 'dshb_cost_chart' }, [
          h('div', { key: 'yaxis', className: 'dshb_cost_yaxis' }, yLabels),
          h('div', {
            key: 'plot',
            className: 'dshb_cost_plot',
            ref: boxRef,
            onMouseMove: (event) => setHover(nearest(event)),
            onMouseLeave: () => setHover(-1),
            onClick: (event) => {
              const index = nearest(event)
              if (index >= 0) onSelect(index)
            },
          }, [
            ...bands,
            ...gridlines,
            h('canvas', { key: 'canvas', className: 'dshb_cost_canvas', ref: canvasRef }),
            ...separators,
            marker,
            tooltip,
          ]),
        ]),
        h('div', { key: 'axis', className: 'dshb_cost_axis', style: { marginLeft: 64 } }, ticks),
      ])
    }

    /** A Step's share of the session, as a percentage of two significant digits. */
    function shareOf(value, total) {
      if (!(total > 0)) return '0%'
      const percent = (value / total) * 100
      return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
    }

    /**
     * The lines the chart tooltip shows for one Step, top to bottom.
     *
     * The model shares the first line with the Step it belongs to: on its own line
     * it cost vertical space and read as a separator rather than a fact.
     *
     * @param node - the Step record the tooltip describes.
     * @param options - `t`, `currency`, the session total and the peak intervals.
     * @returns one string per line.
     */
    function tooltipLines(node, options = {}) {
      const { t = (key) => key, currency = 'USD', total = 0, intervals = [] } = options
      const models = Object.keys(node.byModel ?? {}).join(', ')
      const head = t('cost.tip.turn', { turn: node.turn, step: node.step })
      return [
        models === '' ? head : `${head} · ${models}`,
        `${clock(node.tStart) ?? ''} · ${t(nodePhase(node, intervals))}`,
        bucketLine(node.buckets),
        `${costText(node.cost, currency)} · ${t('cost.tip.share', { share: shareOf(node.cost, total) })}`,
      ]
    }

    /**
     * Where the tooltip goes so it stays inside the plot.
     *
     * The tooltip is centred on the point, so a point at either edge would push
     * half of it outside the chart; it is clamped instead, and it flips below the
     * point when there is no room above it.
     *
     * @param point - the plotted point in pixels (`{ x, y }`).
     * @param options - `width`/`height` of the plot and the tooltip's own size.
     * @returns `{ left, top, transform }` for the tooltip element.
     */
    function tooltipPlacement(point, options = {}) {
      const { width = 0, height = 0, tipWidth = 180, tipHeight = 72, gap = 8 } = options
      // An unknown plot width must not turn into a one-pixel clamp: fall back to a
      // box exactly as wide as the tooltip, which centres the point.
      const usable = width > 0 ? width : tipWidth + 2 * gap
      const half = Math.min(tipWidth, usable) / 2
      const left = Math.min(Math.max(point.x, half + gap), Math.max(half + gap, usable - half - gap))
      const top = Math.min(Math.max(point.y, 0), height)
      const below = point.y < tipHeight + gap
      return {
        left,
        top,
        transform: below ? `translate(-50%, ${gap + 6}px)` : 'translate(-50%, -108%)',
      }
    }

    /**
     * The inspector of one Step.
     *
     * The prompt comes from the projection, and the projection holds usage, not
     * messages: when there is no text the inspector says so and offers the explicit
     * `Load older` action instead of loading the conversation behind the reader's
     * back.
     */
    function CostInspector({ t, node, currency, total, peakIntervals, inspectCall, loadOlder }) {
      const [older, setOlder] = react.useState({ status: 'idle', error: null })
      if (node === null || node === undefined) {
        return h('div', { className: 'dshb_cost_card' }, h('div', { className: 'dshb_cost_note' }, t('cost.inspector.empty')))
      }
      const models = Object.keys(node.byModel ?? {}).join(', ') || '—'
      const flags = []
      if (node.ended === false) flags.push(t('cost.inspector.inProgress'))
      if (node.interrupted === true) flags.push(t('cost.inspector.interrupted'))
      if (node.unpriced === true) flags.push(t('cost.inspector.unpriced'))
      if (node.retries > 0) flags.push(t('cost.inspector.retries', { count: node.retries }))

      const calls = node.calls ?? []
      const focus = calls.length > 0 && typeof inspectCall === 'function'
        ? h('button', {
          className: 'dshb_btn',
          key: 'focus',
          onClick: () => inspectCall(calls[0].callId),
        }, t('cost.inspector.focus'))
        : null

      const load = async () => {
        if (typeof loadOlder !== 'function') return
        setOlder({ status: 'loading', error: null })
        try {
          await loadOlder()
          setOlder({ status: 'loaded', error: null })
        } catch (error) {
          setOlder({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      }

      // The token/cost table: one column per bucket, in and out first, and the
      // money the Step paid for each of them underneath its token count.
      const rows = [
        { key: 'uncachedInput', label: t('cost.bucket.in') },
        { key: 'output', label: t('cost.bucket.out') },
        { key: 'cacheRead', label: t('cost.bucket.cacheRead') },
        { key: 'cacheWrite', label: t('cost.bucket.cacheWrite') },
      ]
      const buckets = node.buckets ?? {}
      const costs = node.costByBucket ?? {}
      const totalTokens = (buckets.uncachedInput ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0)
      const digits = costColumnDigits([...rows.map((row) => costs[row.key] ?? 0), node.cost])
      const line = (key, label, tokens, cost) => h('tr', { key }, [
        h('td', { key: 'label' }, label),
        h('td', { key: 'tokens' }, String(tokens)),
        h('td', { key: 'cost' }, costCell(cost, currency, digits)),
      ])
      const table = h('table', { className: 'dshb_cost_table', key: 'table' }, [
        h('thead', { key: 'head' }, h('tr', null, [
          h('th', { key: 'corner' }, ''),
          h('th', { key: 'tokens' }, t('cost.column.tokens')),
          h('th', { key: 'cost' }, t('cost.column.cost')),
        ])),
        h('tbody', { key: 'body' }, [
          ...rows.map((row) => line(row.key, row.label, buckets[row.key] ?? 0, costs[row.key] ?? 0)),
          line('total', t('cost.bucket.total'), totalTokens, node.cost),
        ]),
      ])

      return h('div', { className: 'dshb_cost_card' }, [
        h('div', { className: 'dshb_cost_sub', key: 'title' }, `${t('cost.inspector.title', { turn: node.turn, step: node.step })} · ${models} · ${t(nodePhase(node, peakIntervals))}`),
        h('div', { className: 'dshb_cost_kv', key: 'meta' }, [
          h('span', { className: 'k', key: 'ik' }, t('cost.inspector.interval')),
          h('span', { key: 'iv' }, t('cost.tip.interval', {
            from: clock(node.tStart) ?? '—',
            to: clock(node.tEnd) ?? '—',
          })),
          h('span', { className: 'k', key: 'sk' }, t('cost.inspector.share')),
          h('span', { key: 'sv' }, shareOf(node.cost, total)),
        ]),
        table,
        flags.length === 0 ? null : h('div', { className: 'dshb_flag', key: 'flags' }, flags.join(' · ')),
        // The Turn's prompt comes before the calls: it is the context the calls
        // belong to, and the projection carries usage rather than messages — hence
        // the explicit "load older" action instead of hidden auto-loading.
        h('div', { className: 'dshb_cost_note', key: 'prompt-title' }, t('cost.inspector.prompt')),
        h('div', { className: 'dshb_cost_note', key: 'prompt' }, [
          h('span', { key: 'text' }, older.status === 'failed'
            ? t('cost.inspector.loadFailed')
            : t('cost.inspector.noPrompt')),
          h('button', {
            key: 'older',
            className: 'dshb_btn',
            disabled: older.status === 'loading' || typeof loadOlder !== 'function',
            onClick: () => { void load() },
            style: { marginLeft: 8 },
          }, older.status === 'loading' ? t('cost.inspector.loading') : t('cost.inspector.loadOlder')),
        ]),
        h('div', { className: 'dshb_cost_note', key: 'calls-title' }, t('cost.inspector.calls')),
        calls.length === 0
          ? h('div', { className: 'dshb_cost_note', key: 'no-calls' }, t('cost.inspector.noCalls'))
          : h('div', { className: 'dshb_cost_kv', key: 'calls' }, calls.flatMap((call) => [
            h('span', { className: 'k', key: `${call.callId}-n` }, call.name),
            h('span', { className: 'dshb_cost_preview', key: `${call.callId}-p` }, call.preview),
          ])),
        h('div', { className: 'dshb_cost_actions', key: 'actions' }, [
          focus === null ? h('span', { className: 'dshb_cost_note', key: 'no-focus' }, t('cost.inspector.noFocus')) : focus,
        ]),
      ])
    }
    //#endregion

    //#region plugin
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, copy), 'dsh-balance: dictionaries')
      /** Localized label lookup for the parts the shell renders outside a component. */
      const bind = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key

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

      // The Cost view sits directly after Trajectory (order 10) and is mounted lazily
      // on selection, so nothing is charted before the reader asks for it.
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'dsh-balance-cost',
        order: 20,
        locale: NS,
        label: () => bind('view.cost'),
        inject: (sessionId) => ({
          /**
           * Load older conversation events on demand. The chart itself needs the
           * projection, not the messages; this exists for the inspector's prompt
           * preview and is only ever called from its explicit action.
           */
          loadOlder: async () => {
            const sessions = ctx.get('sessions')
            const session = sessions?.binding?.(sessionId)?.session
            if (session === undefined || session === null) return false
            await session.loadOlder()
            return true
          },
        }),
      }, CostView))

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
      Readout, Popover, Summary, DaysTable, Credits, Settings, createPeakChip, createStore,
      money, duration, formatRemaining, statusLevel, phaseFromSchedule, effectiveRoute,
      routeFromModelSelection, routeFromCatalogDefault, isPeakRuleRoute, settingsOf, peakLines,
      CostView, CostChart, CostInspector, CostEmpty, drawPlot, metricOf, linearScale, clipThreshold,
      decimatePoints, seriesWindow, phaseOf, bandRanges, turnSeparators, seriesSummary, seriesState,
      plotTicks, buildPlot, bucketLine, shareOf, tooltipPlacement, costDigits, costText,
      costColumnDigits, costCell,
      valueAxis, compactNumber, tickLabel, tooltipLines,
    }
    return module.exports
  },
})
