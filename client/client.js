/**
 * dsh-balance — browser half.
 *
 * Three additive surfaces, all fed by `/dsh-balance`:
 *
 * 1. A compact readout in `conversation.composer.dock` at `order: -10`, so it is
 *    drawn immediately left of the shipped `stats` entry ("N turns · M steps") and
 *    reads as part of that line: `$19.52 · $0.39/$2.29/$10.43 · $0.33`, with no
 *    labels — hovering explains the figures, clicking opens the panel.
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

    const VERSION = '0.2.0'
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
        '.dshb_cost_sessionline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshb_cost_id{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);user-select:all}',
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
        '.dshb_cost_card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;padding:8px 10px;font-size:12px;max-width:100%;display:flex;flex-direction:column;gap:6px;flex:1 1 auto}',
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
        // A spawn mark: a small diamond just above the Step it belongs to, so it
        // reads as a label on the point rather than as a second data series.
        '.dshb_cost_spawn{position:absolute;width:7px;height:7px;margin:-17px 0 0 -3.5px;transform:rotate(45deg);pointer-events:none;',
        'background:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-500,#4d6bfe));opacity:.85}',
        '.dshb_subagents{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));padding-top:6px}',
        '.dshb_sub_head{display:flex;gap:6px;align-items:baseline;width:100%;color:var(--dsw-alias-label-secondary);font-size:11.5px}',
        // The group head shares the money column of its rows, so every figure in the
        // card lines up on the right edge whether or not the row carries a button.
        '.dshb_sub_head .dshb_sub_money{margin-left:auto}',
        '.dshb_sub_row{display:flex;gap:8px;width:100%;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_sub_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshb_kv_open{display:inline-flex;align-items:baseline;justify-content:flex-end;gap:8px;width:100%}',
        '.dshb_kv_open .dshb_btn{flex:none}',
        '.dshb_sub_right{margin-left:auto;display:inline-flex;align-items:baseline;gap:8px;flex:none}',
        '.dshb_sub_reason{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
        '.dshb_sub_money{font-variant-numeric:tabular-nums;text-align:right;min-width:132px;color:var(--dsw-alias-label-secondary)}',
        '.dshb_sub_broken .dshb_sub_label{color:var(--dsw-alias-label-tertiary)}',
        '.dshb_cost_empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;color:var(--dsw-alias-label-tertiary);font-size:12px}',
        '.dshb_cost_controls{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}',
        '.dshb_cost_seg{display:inline-flex;align-items:center;gap:4px}',
        '.dshb_cost_segLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-right:2px}',
        '.dshb_seg{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:transparent;color:var(--dsw-alias-label-secondary);',
        'border-radius:6px;padding:1px 7px;font-size:11px;line-height:1.6;cursor:pointer}',
        '.dshb_seg:hover{color:var(--dsw-alias-label-primary)}',
        '.dshb_seg_on{background:var(--dsw-alias-state-info-primary,#3b82f6);border-color:transparent;color:#fff}',
        '.dshb_rates{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:10px;padding:8px 10px}',
        '.dshb_rates_row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}',
        '.dshb_rates_model{font-size:12px;color:var(--dsw-alias-label-primary);min-width:120px}',
        '.dshb_settings_block{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
        '.dshb_settings_title{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dshb_cost_brush{position:absolute;top:0;bottom:0;background:rgba(59,130,246,.18);border-left:1px solid rgba(59,130,246,.5);',
        'border-right:1px solid rgba(59,130,246,.5);pointer-events:none}',
        '.dshb_cost_turn{position:absolute;top:0;bottom:0;pointer-events:none;border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28))}',
        '.dshb_cost_turn_alt{background:rgba(128,128,128,.07)}',
        '.dshb_cost_turnLabel{position:absolute;top:0;left:3px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,0));',
        'font-size:9px;line-height:12px;padding:0 2px;border-radius:2px;white-space:nowrap}',
        '.dshb_spinner{display:flex;align-items:center;justify-content:center;gap:10px;padding:30px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
        '.dshb_spinner_ring{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dshb_spin .8s linear infinite}',
        '@keyframes dshb_spin{to{transform:rotate(360deg)}}',
        '.dshb_cost_prompt{white-space:pre-wrap;word-break:break-word;display:block;max-height:110px;overflow:auto;margin-top:2px;color:var(--dsw-alias-label-secondary)}',
        '.dshb_export{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;max-width:1120px}',
        '.dshb_export_check{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
        '.dshb_cost_tabrow{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;max-width:1120px}',
        '.dshb_cost_tabs{display:flex;gap:2px;flex:1 1 auto;min-width:0;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
        '.dshb_cost_tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);padding:3px 10px}',
        '.dshb_cost_tab:hover{color:var(--dsw-alias-label-primary)}',
        '.dshb_cost_tabOn{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-500,#4d6bfe))}',
        // Two content columns and no more: on a wide screen a row that spans the whole
        // window reads worse than a compact one, and the same cap keeps the tab strip
        // aligned with the panes below it.
        '.dshb_cost_panes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:stretch;max-width:1380px}',
        // The three readings are cards of the same height, so neither looks like loose text.
        '.dshb_cost_pane{min-width:0;display:flex;flex-direction:column}',
        '@media (max-width:1200px){.dshb_cost_panes{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}',
        '@media (max-width:900px){.dshb_cost_panes{grid-template-columns:minmax(0,1fr)}}',
        '.dshb_topk{display:flex;flex-direction:column;gap:2px}',
        '.dshb_topk_row{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:0 12px;align-items:baseline;cursor:pointer;',
        'border-radius:6px;padding:2px 6px}',
        '.dshb_topk_row:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}',
        '.dshb_topk_row_on{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
        // A Compaction row is ranked with the Steps but is not one of them: it is dimmed
        // and opens nothing, because it has no Step to open (I7).
        '.dshb_topk_row_off{cursor:default;opacity:.8}',
        // The Indicator badges sit on the Step they blame, above its point, and never
        // hide the marks the chart already draws (I19).
        '.dshb_cost_badge{position:absolute;transform:translate(-50%,-135%);display:inline-flex;align-items:center;gap:2px;',
        'padding:0 3px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));',
        'background:var(--dsw-alias-bg-layer-1,rgba(20,20,20,.82));color:var(--dsw-alias-label-primary);font-size:10px;line-height:14px;cursor:pointer}',
        '.dshb_cost_badge:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.22))}',
        '.dshb_cost_badge_warn{border-color:var(--dsw-alias-state-warn-primary,#f59e0b);color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
        '.dshb_cost_badge_alert{border-color:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444)}',
        '.dshb_cost_badgeCount{color:var(--dsw-alias-label-tertiary);font-size:9px}',
        // A Compaction step draws no point of the cost line: one dashed mark of its own.
        '.dshb_cost_compaction{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--dsw-alias-label-caption,rgba(128,128,128,.6));pointer-events:auto}',
        // The findings card: the third card of the band, scrolling inside itself (I20).
        '.dshb_findings{display:flex;flex-direction:column;gap:6px}',
        '.dshb_findings_list{display:flex;flex-direction:column;gap:4px;overflow-y:auto;max-height:320px;min-height:0}',
        '.dshb_finding{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:8px;cursor:pointer;',
        'border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}',
        '.dshb_finding:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}',
        '.dshb_finding_warn{border-left-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
        '.dshb_finding_alert{border-left-color:var(--dsw-alias-state-error-primary,#ef4444)}',
        '.dshb_finding_head{display:flex;align-items:baseline;gap:4px;color:var(--dsw-alias-label-primary);font-size:12px}',
        '.dshb_finding_text{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.35}',
        '.dshb_finding_partial{color:var(--dsw-alias-label-tertiary);font-size:10px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.35));',
        'border-radius:5px;padding:0 3px}',
        '.dshb_finding_detail{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));margin-top:4px;padding-top:4px}',
        '.dshb_finding_detailHead{color:var(--dsw-alias-label-primary);font-size:12px;margin-top:2px}',
        '.dshb_topk_head{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dshb_topk_rank{color:var(--dsw-alias-label-tertiary);margin-right:6px;font-size:11px}',
        '.dshb_topk_money{color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dshb_topk_body{grid-column:1 / -1;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
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
        'settings.fallbackRates': 'Fallback rates for unpriced models',
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
        'cost.proj.fact': 'Fact',
        'cost.proj.offPeak': 'off-peak',
        'cost.proj.peak': 'peak',
        'cost.fact': 'Fact: {value}',
        'cost.control.projection': 'Tariff',
        'cost.control.metric': 'Metric',
        'cost.control.axis': 'X axis',
        'cost.control.topk': 'Top',
        'cost.metric.cost': 'cost',
        'cost.metric.output': 'output',
        'cost.metric.cacheRead': 'cache read',
        'cost.metric.cacheWrite': 'cache write',
        'cost.metric.tokens': 'tokens',
        'cost.axis.time': 'time',
        'cost.axis.index': 'Step',
        'cost.topk.title': 'Heaviest over the visible range',
        'cost.topk.empty': 'no Steps in this range',
        'cost.topk.steps': 'Steps',
        'cost.topk.turns': 'Turns',
        'cost.topk.ofSteps': '{steps} steps',
        'cost.topk.unpriced': 'unpriced',
        'cost.session': 'session: {value}',
        'cost.zoom.reset': 'Reset zoom',
        'cost.zoom.hint': 'wheel zooms · right-drag pans · drag selects a range · ←/→ walk the Steps · double-click resets',
        'cost.rates.enter': 'enter rates',
        'cost.rates.note': 'peak rates per 1M tokens: the off-peak rate is half and a cache write is billed as a cache miss. Saving reprices this session’s whole history.',
        'cost.rates.miss': 'cache miss / in',
        'cost.rates.hit': 'cache hit / read',
        'cost.rates.output': 'output',
        'cost.rates.save': 'Save rates',
        'cost.rates.saved': 'saved — the history was repriced',
        'cost.rates.invalid': 'every rate must be a non-negative number',
        'cost.rates.failed': 'rejected: {error}',
        'cost.steps': '{steps} steps',
        'cost.session.label': 'session',
        'cost.session.copy': 'copy id',
        'cost.session.copied': 'copied',
        'cost.export.title': 'Export',
        'cost.export.detail': 'detail',
        'cost.export.detail.costs': 'costs',
        'cost.export.detail.full': 'full',
        'cost.export.subagents': 'include subagents',
        'cost.export.download': 'Download NDJSON',
        'cost.export.busy': 'Reading…',
        'cost.export.done': 'downloaded',
        'cost.export.failed': 'export failed: {error}',
        'cost.export.warn': 'a full export carries message, tool and thinking text, cut at 2000 characters; it is a plain file you keep, not a trace sent anywhere',
        'cost.tab.session': 'Session',
        'cost.tab.subagents': 'Subagents ({count})',
        'cost.tab.subagentsCount': 'Subagents',
        'cost.tab.hint': 'the header total is this session alone under both tabs',
        'cost.subagents.count': '{count} spawned',
        'cost.subagents.mark': 'spawned {labels}',
        'cost.subagents.title': 'Subagents spawned by this session',
        'cost.subagents.hint': 'not read yet — the session total above stays this session alone',
        'cost.subagents.include': 'Include subagents',
        'cost.subagents.loading': 'reading the subtree…',
        'cost.subagents.failed': 'the subtree could not be read: {error}',
        'cost.subagents.total': 'subtree: {value}',
        'cost.subagents.full': 'every session below is read',
        'cost.subagents.loadFull': 'Load full history',
        'cost.subagents.fullHint': 'walks every session below, not only the direct children',
        'cost.subagents.step': 'Subagents spawned here',
        'cost.subagents.stepTotal': 'subtree of this Step: {value}',
        'cost.subagents.notLoaded': 'not read yet',
        'cost.subagents.diagnostics': '{count} sessions below could not be read',
        'cost.subagents.open': 'open',
        'cost.subagents.openHint': 'open this subagent session with its Cost view',
        'cost.subagents.totalUnknown': 'subtree: nothing read',
        'cost.subagents.reason.corrupt': 'broken log',
        'cost.subagents.reason.unavailable': 'not readable',
        'cost.subagents.reason.unreadable': 'could not be priced',
        'cost.subagents.reason.unsupported': 'mode not supported',
        'cost.calibration': 'account-wide {value}',
        'cost.calibration.title': 'Between {from} and {to}, from {samples} balance samples: the whole account, other activity included — not this session alone',
        'cost.unpriced': 'not priced: {models}',
        'cost.bandNote': 'shaded: peak windows',
        'cost.clip': 'clipped above {value}',
        'cost.unclip': 'Remove clipping',
        'cost.retry': 'Retry',
        'cost.empty.steps': 'No Steps with usage yet — the chart fills as the session runs.',
        'cost.loading': 'reading the session history…',
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
        'cost.tip.unpriced': 'unpriced — no rate applies to this model',
        'cost.tip.share': '{share} of the session',
        'cost.tip.interval': '{from}–{to}',
        'cost.inspector.title': 'Step {turn}.{step}',
        'cost.inspector.empty': 'Select a Step in the chart to inspect it.',
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
        'cost.findings.title': 'Findings',
        'cost.findings.legend': 'confidence ranks suspicion inside the Session cost estimate — it is not a probability and not a claim about the bill',
        'cost.findings.empty': 'no Indicator found anything in this range',
        'cost.findings.norm': 'this session is below the short-session floor: its own norm is not established yet, so only the rule-based Indicators speak',
        'cost.findings.partial': 'reaches beyond this range',
        'cost.findings.preset': 'detected under the {preset} preset — hover for its thresholds',
        'cost.findings.subtree': 'the subtree reading: its own Findings, over this chart',
        'cost.findings.confidence': 'confidence {value} · {severity}',
        'cost.finding.at.step': 'turn {turn}, step {step}',
        'cost.finding.at.run': 'turn {turn}, steps {from}–{to}',
        'cost.finding.at.turns': 'turns {from}.{stepFrom}–{to}.{stepTo}',
        'cost.finding.at.compaction': 'a Compaction step',
        'cost.finding.severity.info': 'info',
        'cost.finding.severity.warn': 'warning',
        'cost.finding.severity.alert': 'alert',
        'cost.finding.preset': '{preset} sensitivity',
        'cost.finding.preset.strict': 'strict',
        'cost.finding.preset.balanced': 'balanced',
        'cost.finding.preset.loose': 'loose',
        'cost.finding.ranking': 'confidence {confidence} ({severity}) ranks suspicion inside the estimate, not a bill',
        'cost.finding.unknown': 'unknown Indicator {kind}',
        'cost.finding.kind.spike': 'cost spike',
        'cost.finding.kind.verbose-output': 'long reply',
        'cost.finding.kind.context-growth': 'context growth',
        'cost.finding.kind.retry-storm': 'retry storm',
        'cost.finding.kind.cache-miss': 'cache miss',
        'cost.finding.kind.tool-output-inflation': 'input inflation',
        'cost.finding.kind.post-compaction-spike': 'post-compaction spike',
        'cost.finding.kind.expensive-subtree': 'expensive subtree',
        'cost.finding.kind.tariff-attributable': 'peak-window cost',
        'cost.finding.kind.pricing-gap': 'pricing gap',
        'cost.finding.detect.spike': 'one Step far above this session’s own median',
        'cost.finding.detect.verbose-output': 'a generation far longer than this session’s own replies',
        'cost.finding.detect.context-growth': 'cost climbing with the context over a run of Steps',
        'cost.finding.detect.retry-storm': 'a Step fighting retries, or a Turn full of retried Steps',
        'cost.finding.detect.cache-miss': 'the context resent instead of reused, after a cache was in use',
        'cost.finding.detect.tool-output-inflation': 'a large tool result the next Step pays for as input',
        'cost.finding.detect.post-compaction-spike': 'a compaction, and the Step that had to rebuild the context after it',
        'cost.finding.detect.expensive-subtree': 'a subtree costing as much as the session it belongs to',
        'cost.finding.detect.tariff-attributable': 'money the peak window added, rather than the work',
        'cost.finding.detect.pricing-gap': 'models with no rate in the Tariff rule, so the total is a lower bound',
        'cost.finding.spike.text': 'this Step cost {cost} — {multiple} the session median {median}, past the {threshold} gate (MAD z {z}), {share} of the session',
        'cost.finding.verbose.text': '{value} output tokens against a {threshold}-token gate (session median {median} output tokens, z {z})',
        'cost.finding.growth.text': 'cost rose {rise} above the session median {median} over {steps} Steps (R² {r2} against a line, gate {threshold})',
        'cost.finding.retry.step': '{count} retries inside one Step (gate {threshold}; the Step cost {cost})',
        'cost.finding.retry.turn': '{count} retried Steps in turn {turn} (gate {threshold}; {cost} in total)',
        'cost.finding.cache.text': '{share} of the input over {steps} consecutive Steps was uncached (gate {threshold} uncached)',
        'cost.finding.tool.text': 'the next Step carried {delta} more input tokens after {tools} (gate {threshold})',
        'cost.finding.compaction.text': 'the compaction cost {cost}, and the Step after it cost {value}× the session median (gate {threshold}×, {tokens} tokens shadowed)',
        'cost.finding.subtree.text': 'the subtree costs {cost} — {share} of the session estimate {session}',
        'cost.finding.tariff.text': '{share} of the session ({delta} of {total}) is the peak-window surcharge',
        'cost.finding.gap.text': '{steps} Steps carry {share} of the tokens with no rate: the session estimate is a lower bound',
        'cost.compaction.mark': 'compaction · {cost} · {tokens} tokens shadowed',
        'cost.compaction.row': 'Compaction',
        'cost.compaction.body': 'context compaction · {tokens} tokens shadowed',
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
        'settings.fallbackRates': 'Запасные ставки для моделей без цены',
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
        'cost.proj.fact': 'Факт',
        'cost.proj.offPeak': 'льготный',
        'cost.proj.peak': 'пиковый',
        'cost.fact': 'Факт: {value}',
        'cost.control.projection': 'Тариф',
        'cost.control.metric': 'Метрика',
        'cost.control.axis': 'Ось X',
        'cost.control.topk': 'Топ',
        'cost.metric.cost': 'стоимость',
        'cost.metric.output': 'выход',
        'cost.metric.cacheRead': 'чтение кэша',
        'cost.metric.cacheWrite': 'запись кэша',
        'cost.metric.tokens': 'токены',
        'cost.axis.time': 'время',
        'cost.axis.index': 'шаг',
        'cost.topk.title': 'Самые дорогие на видимом отрезке',
        'cost.topk.empty': 'на этом отрезке нет шагов',
        'cost.topk.steps': 'шаги',
        'cost.topk.turns': 'ходы',
        'cost.topk.ofSteps': 'шагов: {steps}',
        'cost.topk.unpriced': 'без цены',
        'cost.session': 'вся сессия: {value}',
        'cost.zoom.reset': 'Сбросить масштаб',
        'cost.zoom.hint': 'колесо — масштаб · правая кнопка — сдвиг · выделение — отрезок · ←/→ — шаги · двойной клик — сброс',
        'cost.rates.enter': 'ввести ставки',
        'cost.rates.note': 'пиковые ставки за 1M токенов: льготная — половина, запись кэша считается промахом кэша. Сохранение пересчитывает всю историю сессии.',
        'cost.rates.miss': 'промах / вход',
        'cost.rates.hit': 'попадание / чтение',
        'cost.rates.output': 'выход',
        'cost.rates.save': 'Сохранить ставки',
        'cost.rates.saved': 'сохранено — история пересчитана',
        'cost.rates.invalid': 'каждая ставка должна быть неотрицательным числом',
        'cost.rates.failed': 'отклонено: {error}',
        'cost.steps': 'шагов: {steps}',
        'cost.session.label': 'сессия',
        'cost.session.copy': 'копировать id',
        'cost.session.copied': 'скопировано',
        'cost.export.title': 'Экспорт',
        'cost.export.detail': 'детализация',
        'cost.export.detail.costs': 'затраты',
        'cost.export.detail.full': 'полная',
        'cost.export.subagents': 'включить субагентов',
        'cost.export.download': 'Скачать NDJSON',
        'cost.export.busy': 'Читаю…',
        'cost.export.done': 'скачано',
        'cost.export.failed': 'экспорт не удался: {error}',
        'cost.export.warn': 'полный экспорт содержит текст сообщений, вызовов и рассуждений, обрезанный на 2000 символах; это обычный файл у вас, а не отправленная куда-то трасса',
        'cost.tab.session': 'Сессия',
        'cost.tab.subagents': 'Субагенты ({count})',
        'cost.tab.subagentsCount': 'Субагенты',
        'cost.tab.hint': 'итог в шапке — это только эта сессия на обоих табах',
        'cost.subagents.count': 'порождено: {count}',
        'cost.subagents.mark': 'породил {labels}',
        'cost.subagents.title': 'Субагенты, порождённые этой сессией',
        'cost.subagents.hint': 'ещё не прочитаны — итог сессии выше остаётся только её собственным',
        'cost.subagents.include': 'Включить субагентов',
        'cost.subagents.loading': 'читаю поддерево…',
        'cost.subagents.failed': 'поддерево не удалось прочитать: {error}',
        'cost.subagents.total': 'поддерево: {value}',
        'cost.subagents.full': 'прочитаны все сессии ниже',
        'cost.subagents.loadFull': 'Загрузить всю историю',
        'cost.subagents.fullHint': 'читает все сессии ниже, а не только прямых детей',
        'cost.subagents.step': 'Субагенты, порождённые здесь',
        'cost.subagents.stepTotal': 'поддерево этого шага: {value}',
        'cost.subagents.notLoaded': 'ещё не прочитан',
        'cost.subagents.diagnostics': 'не удалось прочитать сессий ниже: {count}',
        'cost.subagents.open': 'открыть',
        'cost.subagents.openHint': 'открыть эту сессию субагента с её Cost',
        'cost.subagents.totalUnknown': 'поддерево: ничего не прочитано',
        'cost.subagents.reason.corrupt': 'повреждённый лог',
        'cost.subagents.reason.unavailable': 'не читается',
        'cost.subagents.reason.unreadable': 'не удалось оценить',
        'cost.subagents.reason.unsupported': 'режим не поддержан',
        'cost.calibration': 'по счёту {value}',
        'cost.calibration.title': 'Между {from} и {to}, по {samples} сэмплам баланса: весь счёт, включая прочую активность — не только эта сессия',
        'cost.unpriced': 'без цены: {models}',
        'cost.bandNote': 'заливка — пиковые окна',
        'cost.clip': 'обрезано выше {value}',
        'cost.unclip': 'Снять обрезку',
        'cost.retry': 'Повторить',
        'cost.empty.steps': 'Шагов с usage пока нет — график заполнится по ходу сессии.',
        'cost.loading': 'читаю историю сессии…',
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
        'cost.tip.unpriced': 'без цены — для модели нет ставки',
        'cost.tip.share': '{share} от сессии',
        'cost.tip.interval': '{from}–{to}',
        'cost.inspector.title': 'Шаг {turn}.{step}',
        'cost.inspector.empty': 'Выбери шаг на графике, чтобы посмотреть детали.',
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
        'cost.findings.title': 'Находки',
        'cost.findings.legend': 'уверенность упорядочивает подозрение внутри оценки стоимости сессии — это не вероятность и не счёт к оплате',
        'cost.findings.empty': 'в этом диапазоне индикаторы ничего не нашли',
        'cost.findings.norm': 'сессия короче порога: её собственная норма ещё не установлена, поэтому говорят только правила',
        'cost.findings.partial': 'выходит за диапазон',
        'cost.findings.preset': 'детекция по пресету {preset} — пороги под курсором',
        'cost.findings.subtree': 'чтение поддерева: его собственные находки по этому графику',
        'cost.findings.confidence': 'уверенность {value} · {severity}',
        'cost.finding.at.step': 'ход {turn}, шаг {step}',
        'cost.finding.at.run': 'ход {turn}, шаги {from}–{to}',
        'cost.finding.at.turns': 'ходы {from}.{stepFrom}–{to}.{stepTo}',
        'cost.finding.at.compaction': 'ступень компакции',
        'cost.finding.severity.info': 'инфо',
        'cost.finding.severity.warn': 'предупреждение',
        'cost.finding.severity.alert': 'тревога',
        'cost.finding.preset': 'чувствительность «{preset}»',
        'cost.finding.preset.strict': 'строгая',
        'cost.finding.preset.balanced': 'сбалансированная',
        'cost.finding.preset.loose': 'мягкая',
        'cost.finding.ranking': 'уверенность {confidence} ({severity}) упорядочивает подозрение внутри оценки, а не счёт',
        'cost.finding.unknown': 'неизвестный индикатор {kind}',
        'cost.finding.kind.spike': 'всплеск стоимости',
        'cost.finding.kind.verbose-output': 'длинный ответ',
        'cost.finding.kind.context-growth': 'рост контекста',
        'cost.finding.kind.retry-storm': 'шторм повторов',
        'cost.finding.kind.cache-miss': 'промах кэша',
        'cost.finding.kind.tool-output-inflation': 'рост входа',
        'cost.finding.kind.post-compaction-spike': 'всплеск после компакции',
        'cost.finding.kind.expensive-subtree': 'дорогое поддерево',
        'cost.finding.kind.tariff-attributable': 'пиковый тариф',
        'cost.finding.kind.pricing-gap': 'пробел в ставках',
        'cost.finding.detect.spike': 'одна ступень сильно выше собственной медианы сессии',
        'cost.finding.detect.verbose-output': 'ответ намного длиннее собственной нормы сессии',
        'cost.finding.detect.context-growth': 'стоимость растёт вместе с контекстом на серии ступеней',
        'cost.finding.detect.retry-storm': 'ступень, борющаяся с повторами, или ход, полный повторяемых ступеней',
        'cost.finding.detect.cache-miss': 'контекст отправлен заново вместо переиспользования, хотя кэш уже работал',
        'cost.finding.detect.tool-output-inflation': 'большой результат инструмента, который следующая ступень читает как вход',
        'cost.finding.detect.post-compaction-spike': 'компакция и ступень, которой пришлось пересобрать контекст после неё',
        'cost.finding.detect.expensive-subtree': 'поддерево, которое стоит как сессия, которой принадлежит',
        'cost.finding.detect.tariff-attributable': 'деньги, которые добавило пиковое окно, а не работа',
        'cost.finding.detect.pricing-gap': 'модели без ставки в тарифном правиле, поэтому итог — нижняя граница',
        'cost.finding.spike.text': 'ступень стоила {cost} — {multiple} от медианы сессии {median}, выше порога {threshold} (MAD z {z}), {share} сессии',
        'cost.finding.verbose.text': '{value} выходных токенов против порога {threshold} (медиана выходных токенов сессии {median}, z {z})',
        'cost.finding.growth.text': 'стоимость выросла на {rise} над медианой сессии {median} за {steps} ступеней (R² {r2} к прямой, порог {threshold})',
        'cost.finding.retry.step': '{count} повторов внутри одной ступени (порог {threshold}; ступень стоила {cost})',
        'cost.finding.retry.turn': '{count} ступеней с повторами в ходе {turn} (порог {threshold}; всего {cost})',
        'cost.finding.cache.text': '{share} входных токенов на {steps} подряд идущих ступенях не взяты из кэша (порог {threshold})',
        'cost.finding.tool.text': 'следующая ступень принесла на {delta} входных токенов больше после {tools} (порог {threshold})',
        'cost.finding.compaction.text': 'компакция стоила {cost}, а следующая ступень — {value}× медианы сессии (порог {threshold}×, затенено {tokens} токенов)',
        'cost.finding.subtree.text': 'поддерево стоит {cost} — {share} оценки сессии {session}',
        'cost.finding.tariff.text': '{share} сессии ({delta} из {total}) — надбавка пикового окна',
        'cost.finding.gap.text': '{steps} ступеней несут {share} токенов без ставки: оценка сессии — нижняя граница',
        'cost.compaction.mark': 'компакция · {cost} · затенено {tokens} токенов',
        'cost.compaction.row': 'Компакция',
        'cost.compaction.body': 'компакция контекста · затенено {tokens} токенов',
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

      // The models worth a rate: the ones the reader already priced and the ones the
      // open session could not price. Anything else would be a guess about the future.
      const rateModels = [...new Set([
        ...Object.keys(state.payload?.fallbackRates ?? {}),
        ...(state.payload?.session?.unpriced ?? []),
      ])]

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
        rateModels.length === 0 ? null : h('div', { className: 'dshb_settings_block', key: 'rates' }, [
          h('div', { className: 'dshb_settings_title', key: 'title' }, t('settings.fallbackRates')),
          h(RateEntry, {
            key: `rates-${rateModels.join('|')}`,
            t,
            models: rateModels,
            rates: state.payload?.fallbackRates ?? {},
            // Rates are their own write: they are keyed by model and repriced at once,
            // so they do not wait for the Apply button above.
            onSave: (next) => store.saveSettings({ fallbackRates: next }),
          }),
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
    /** The three Tariff projections the Host prices every Step under. */
    const PROJECTIONS = ['fact', 'offPeak', 'peak']

    /** The rate fields of a fallback rate, in the order the editor shows them. */
    const RATE_KEYS = ['cacheMiss', 'cacheHit', 'output']

    /** How many rows the top list shows (D17). */
    const TOP_K = 10

    /** The money of one Step under a Tariff projection; `fact` is the Step itself. */
    function projectionOf(node, projection = 'fact') {
      if (projection === 'offPeak' || projection === 'peak') return node?.[projection] ?? node
      return node
    }

    /** The figure one Step contributes to a metric, under a Tariff projection. */
    function metricOf(node, metric = 'cost', projection = 'fact') {
      const buckets = node?.buckets ?? {}
      if (metric === 'output') return buckets.output ?? 0
      if (metric === 'cacheRead') return buckets.cacheRead ?? 0
      if (metric === 'cacheWrite') return buckets.cacheWrite ?? 0
      if (metric === 'tokens') {
        return (buckets.uncachedInput ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0)
      }
      return projectionOf(node, projection)?.cost ?? 0
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
      // The 95th percentile of a sorted list is the value one position above 95% of
      // its length, counted from one and clamped to the last entry.
      const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]
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

    /**
     * The Turns of the plot as pixel spans, for the band overlay the Turns top-K mode
     * shows. A Turn runs up to where the next one starts, so the bands tile the axis
     * and the edge between two of them is exactly the Turn boundary.
     *
     * @param points - the plotted points, in order, with their `x` in pixels.
     * @param width - the plot width, which bounds the last Turn.
     * @returns `[{ turn, from, to }]` in pixels.
     */
    function turnSpans(points, width) {
      const spans = []
      for (const point of points) {
        const last = spans[spans.length - 1]
        if (last === undefined || last.turn !== point.node.turn) {
          spans.push({ turn: point.node.turn, from: point.x, to: point.x })
        } else {
          last.to = point.x
        }
      }
      return spans.map((span, index) => ({
        turn: span.turn,
        from: span.from,
        to: spans[index + 1] === undefined ? width : spans[index + 1].from,
      }))
    }

    /** The totals the header and the tooltip shares are computed from. */
    function seriesSummary(nodes) {
      const totals = { fact: 0, offPeak: 0, peak: 0 }
      let tokens = 0
      const models = []
      const unpriced = []
      for (const node of nodes) {
        for (const projection of PROJECTIONS) totals[projection] += projectionOf(node, projection)?.cost ?? 0
        tokens += metricOf(node, 'tokens')
        for (const model of Object.keys(node.byModel ?? {})) if (!models.includes(model)) models.push(model)
        if (node.unpriced === true) {
          for (const model of Object.keys(node.byModel ?? {})) if (!unpriced.includes(model)) unpriced.push(model)
        }
      }
      return { total: totals.fact, totals, tokens, steps: nodes.length, models, unpriced }
    }

    /** The smallest share of the series a zoom may leave on screen. */
    const MIN_WINDOW = 0.004

    /** Whether a window still covers the whole series. */
    function isFullWindow(window) {
      return window === null || window === undefined || (window.from <= 0 && window.to >= 1)
    }

    /** A window as `{ from, to }` fractions of the series, never narrower than the floor. */
    function clampWindow(from, to) {
      // Snapped to a millionth: a window is compared, drawn and re-derived from the
      // pointer, and 0.09999999999999998 is not a fraction anyone wants to see.
      const snap = (value) => Math.round(value * 1e6) / 1e6
      const width = snap(Math.min(1, Math.max(MIN_WINDOW, to - from)))
      const start = snap(Math.min(Math.max(0, from), 1 - width))
      return { from: start, to: snap(start + width) }
    }

    /**
     * Zoom a window around a fraction of itself.
     *
     * @param window - the current window, `null` for the whole series.
     * @param factor - below 1 zooms in, above 1 zooms out.
     * @param anchor - where the zoom holds its place, 0 at the left edge, 1 at the right.
     */
    function zoomWindow(window, factor, anchor = 0.5) {
      const current = isFullWindow(window) ? { from: 0, to: 1 } : window
      const width = (current.to - current.from) * factor
      const at = current.from + (current.to - current.from) * anchor
      return clampWindow(at - width * anchor, at + width * (1 - anchor))
    }

    /** Slide a window by a fraction of its own width, clamped to the series. */
    function panWindow(window, delta) {
      const current = isFullWindow(window) ? { from: 0, to: 1 } : window
      const width = current.to - current.from
      return clampWindow(current.from + delta * width, current.to + delta * width)
    }

    /** The Findings the series payload carries: the client detects none of its own. */
    function findingsOf(payload) {
      return Array.isArray(payload?.findings) ? payload.findings : []
    }

    /** The glyph a Finding of each Indicator draws on the chart. */
    const FINDING_GLYPH = Object.freeze({
      spike: '▲',
      'verbose-output': '≡',
      'context-growth': '↗',
      'retry-storm': '↻',
      'cache-miss': '⊘',
      'tool-output-inflation': '⇥',
      'post-compaction-spike': '◆',
      'expensive-subtree': '⤷',
      'tariff-attributable': '◷',
      'pricing-gap': '?',
    })

    /** The three grades, so one ranking serves the badges and the list alike. */
    const SEVERITY_WEIGHT = Object.freeze({ info: 1, warn: 2, alert: 3 })

    /** How many badges the plot draws before the rest are left to the list (I19). */
    const MAX_BADGES = 24

    /** `severity × confidence`: the one order the badges and the list both use. */
    function findingRank(finding) {
      return (SEVERITY_WEIGHT[finding.severity] ?? 0) * (finding.confidence ?? 0)
    }

    /**
     * The effective thresholds as hover lines, one per Indicator.
     *
     * Every gate, floor and rate the Host detected under is named, in catalogue order,
     * so a reader can see the rule behind a verdict without the view editing it.
     */
    function thresholdLines(anomalies) {
      const thresholds = anomalies?.thresholds
      if (thresholds === null || thresholds === undefined || typeof thresholds !== 'object') return []
      return Object.entries(thresholds).map(([id, values]) => {
        const gates = Object.entries(values ?? {})
          .filter(([field]) => !['id', 'statistical', 'sampleFactor', 'completeness', 'maxSeverity'].includes(field))
          .map(([field, value]) => `${field}=${value}`)
          .join(' ')
        return `${id}: ${gates}`
      })
    }

    /** Where a Finding sits, as a short label: one Step, a run, or a Compaction step. */
    function findingPlace(t, finding) {
      const refs = finding.refs ?? {}
      if (refs.turnFrom === null || refs.turnFrom === undefined) return t('cost.finding.at.compaction')
      if (refs.from === refs.to) return t('cost.finding.at.step', { turn: refs.turnFrom, step: refs.stepFrom })
      if (refs.turnFrom === refs.turnTo) {
        return t('cost.finding.at.run', { turn: refs.turnFrom, from: refs.stepFrom, to: refs.stepTo })
      }
      return t('cost.finding.at.turns', {
        from: refs.turnFrom, stepFrom: refs.stepFrom, to: refs.turnTo, stepTo: refs.stepTo,
      })
    }

    /**
     * Which Findings touch the visible Steps, and which Steps carry a badge.
     *
     * Brushing, panning and zooming never refetch the series: the Findings the payload
     * carries are filtered here instead. A Finding is shown when at least one Step it
     * references is visible, and one that reaches beyond the window says so rather than
     * disappearing — hiding it would conceal exactly what the reader zoomed in to see.
     *
     * @param allNodes - every node of the series, as the payload served them.
     * @param sliceNodes - the nodes of the visible range.
     * @param findings - the Findings the payload carries.
     * @returns `{ rows, marks, at }`: the visible rows in payload order, the badge marks
     * capped by `severity × confidence`, and the Findings of each visible Step.
     */
    function overlayOf(allNodes, sliceNodes, findings) {
      const visibleAt = new Map()
      sliceNodes.forEach((node, index) => visibleAt.set(node, index))
      const rows = []
      const marks = new Map()
      const at = new Map()
      for (const finding of findings) {
        const last = allNodes.length - 1
        const from = Math.max(0, Math.min(last, finding.refs?.from ?? 0))
        const to = Math.max(from, Math.min(last, finding.refs?.to ?? from))
        const seen = []
        let hidden = 0
        for (let index = from; index <= to; index += 1) {
          const visible = visibleAt.get(allNodes[index])
          if (visible === undefined) hidden += 1
          else seen.push(visible)
        }
        if (seen.length === 0) continue
        rows.push({ ...finding, at: seen[0], partial: hidden > 0 })
        for (const index of seen) {
          const list = at.get(index)
          if (list === undefined) at.set(index, [finding])
          else list.push(finding)
        }
        if (finding.severity === 'info') continue
        for (const index of seen) {
          const mark = marks.get(index)
          if (mark === undefined) {
            marks.set(index, {
              index, kind: finding.kind, severity: finding.severity, confidence: finding.confidence, count: 1,
            })
            continue
          }
          mark.count += 1
          if (findingRank(finding) > findingRank(mark)) {
            mark.kind = finding.kind
            mark.severity = finding.severity
            mark.confidence = finding.confidence
          }
        }
      }
      const capped = [...marks.values()]
        .sort((a, b) => findingRank(b) - findingRank(a) || a.index - b.index)
        .slice(0, MAX_BADGES)
      return { rows, marks: capped, at }
    }

    /**
     * The last visible-range filter.
     *
     * A wheel zoom re-renders on every frame and the filter is a pure function of the
     * series and the window, so one entry is enough (design I24: the client filter is
     * memoised on `(from, to)`).
     */
    let overlayCache = null
    function overlayMemo(key, compute) {
      if (overlayCache !== null && overlayCache.key === key) return overlayCache.value
      const value = compute()
      overlayCache = { key, value }
      return value
    }

    /** The Findings of one node of the series, in payload order. */
    function findingsAt(findings, index) {
      if (!Number.isInteger(index) || index < 0) return []
      return findings.filter((finding) => index >= (finding.refs?.from ?? -1) && index <= (finding.refs?.to ?? -1))
    }

    /**
     * The slice of the series a window covers.
     *
     * The window is kept in fractions rather than instants so it survives an axis
     * switch: on the time axis it becomes an interval, on the Step-index axis a
     * contiguous run of Steps, and the totals and top-K always describe the same
     * part of the session.
     *
     * @returns `{ nodes, fromMs, toMs }` — the covered nodes and the time range the
     * plot spans (the window itself on the time axis, the slice's own extent otherwise).
     */
    function visibleSlice(nodes, window, axis = 'time') {
      const full = seriesWindow(nodes)
      if (isFullWindow(window) || nodes.length === 0) return { nodes, fromMs: full.fromMs, toMs: full.toMs }
      if (axis === 'index') {
        const last = nodes.length - 1
        const start = Math.max(0, Math.min(last, Math.round(window.from * last)))
        const end = Math.max(start, Math.min(last, Math.round(window.to * last)))
        return { nodes: nodes.slice(start, end + 1), fromMs: full.fromMs, toMs: full.toMs }
      }
      const span = full.toMs - full.fromMs
      const fromMs = full.fromMs + span * window.from
      const toMs = full.fromMs + span * window.to
      return { nodes: nodes.filter((node) => node.tStart >= fromMs && node.tStart <= toMs), fromMs, toMs }
    }

    /** The token buckets of several nodes, added up. */
    function sumBuckets(nodes) {
      const total = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const node of nodes) {
        const buckets = node.buckets ?? {}
        for (const key of Object.keys(total)) total[key] += buckets[key] ?? 0
      }
      return total
    }

    /**
     * The top rows of a visible range, ranked by the selected metric.
     *
     * `mode: 'turns'` folds the Steps of a Turn into one row and names the Step
     * that drove the Turn's rank, so a Turn row still answers "which Step was it".
     * A Step with nothing to rank (a zero under the metric) is not a top row.
     *
     * @param nodes - the Steps of the visible range.
     * @param options - `metric`, `projection`, `mode` (`steps`/`turns`) and `count`.
     * @returns rows, best first, each with the index of the Step it selects.
     */
    function topRows(nodes, options = {}) {
      const { metric = 'cost', projection = 'fact', mode = 'steps', count = 10, compactions = [] } = options
      const costOf = (node) => projectionOf(node, projection)?.cost ?? 0
      const rows = []
      if (mode === 'turns') {
        const groups = []
        const byTurn = new Map()
        nodes.forEach((node, index) => {
          let group = byTurn.get(node.turn)
          if (group === undefined) {
            group = { turn: node.turn, nodes: [], driver: index, driverValue: -1, tStart: node.tStart, tEnd: node.tEnd }
            byTurn.set(node.turn, group)
            groups.push(group)
          }
          group.nodes.push(node)
          if (node.tEnd !== null && node.tEnd !== undefined) group.tEnd = node.tEnd
          const value = metricOf(node, metric, projection)
          if (value > group.driverValue) {
            group.driverValue = value
            group.driver = index
          }
        })
        for (const group of groups) {
          const driver = nodes[group.driver]
          rows.push({
            key: `turn-${group.turn}`,
            index: group.driver,
            turn: group.turn,
            step: driver.step,
            tStart: group.tStart,
            tEnd: group.tEnd,
            steps: group.nodes.length,
            value: group.nodes.reduce((total, node) => total + metricOf(node, metric, projection), 0),
            cost: group.nodes.reduce((total, node) => total + costOf(node), 0),
            buckets: sumBuckets(group.nodes),
            models: [...new Set(group.nodes.flatMap((node) => Object.keys(node.byModel ?? {})))],
            call: (driver.calls ?? [])[0] ?? null,
            unpriced: group.nodes.some((node) => node.unpriced === true),
            inProgress: group.nodes.some((node) => node.ended === false),
          })
        }
        return rank([...rows, ...compactionRows(compactions, options)], count)
      }
      return rank([...nodes.map((node, index) => ({
        key: `${node.turn}.${node.step}`,
        index,
        turn: node.turn,
        step: node.step,
        tStart: node.tStart,
        tEnd: node.tEnd,
        steps: 1,
        value: metricOf(node, metric, projection),
        cost: costOf(node),
        buckets: node.buckets ?? {},
        models: Object.keys(node.byModel ?? {}),
        call: (node.calls ?? [])[0] ?? null,
        unpriced: node.unpriced === true,
        inProgress: node.ended === false,
      })), ...compactionRows(compactions, options)], count)
    }

    /**
     * A Compaction step as a top row of its own, ranked with the Steps.
     *
     * It is real money and belongs in the ranking, but it has no Step to select: its
     * row carries no index, is labelled as a compaction, and opens nothing (I7).
     */
    function compactionRows(compactions, options = {}) {
      const { metric = 'cost', projection = 'fact' } = options
      return compactions.map((node, position) => ({
        key: `compaction-${node.compaction?.id ?? position}`,
        index: -1,
        kind: 'compaction',
        compaction: node.compaction ?? null,
        turn: node.turn,
        step: node.step,
        tStart: node.tStart,
        tEnd: node.tEnd,
        steps: 0,
        value: metricOf(node, metric, projection),
        cost: projectionOf(node, projection)?.cost ?? 0,
        buckets: node.buckets ?? {},
        models: Object.keys(node.byModel ?? {}),
        call: null,
        unpriced: node.unpriced === true,
        inProgress: node.ended === false,
      }))
    }

    /**
     * Best first, the oldest first among equals, at most `count` rows.
     *
     * A Step whose model has no rate keeps its row even though it is worth nothing:
     * the spec puts an unpriced Step in the tooltip, in this list and on the chart,
     * and dropping it here would hide the one Step the reader has to price.
     */
    function rank(rows, count) {
      return rows
        .filter((row) => row.value > 0 || row.unpriced === true)
        .sort((a, b) => b.value - a.value || a.tStart - b.tStart)
        .slice(0, Math.max(0, count))
    }

    /**
     * Which of the three states the view is in.
     *
     * `empty-steps` and `empty-rates` are the two in-place empty states; the third
     * state, a failed read, is the error the route or the fetch reported.
     */
    function seriesState(status, payload, nodes, summary) {
      if (status === 'error') return 'error'
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
     * Label positions for the Step-index axis: points are spaced by index and each
     * tick is named by its `(Turn, Step)`, which is the only identity a Step has
     * once the chart stops being a timeline.
     */
    function indexTicks(nodes, count = 4) {
      if (nodes.length === 0) return []
      const ticks = []
      for (let index = 0; index <= count; index += 1) {
        const at = Math.round(((nodes.length - 1) * index) / count)
        const node = nodes[Math.min(nodes.length - 1, at)]
        ticks.push({ at, x: index / count, label: node === undefined ? '' : `${node.turn}.${node.step}` })
      }
      return ticks
    }

    /**
     * The pixel-space model of the chart.
     *
     * @param nodes - the per-Step records the route served.
     * @param options - `width`, `height`, `metric`, `projection`, `clip`, `axis` and
     * `window`: the `{ fromMs, toMs }` the X axis spans, which is the zoom window and
     * not necessarily the extent of `nodes`.
     * @returns points (with their Step), the decimated bars and marks, the
     * clipping threshold and the value the Y axis tops out at.
     */
    function buildPlot(nodes, options = {}) {
      const { width = 720, height = 240, metric = 'cost', projection = 'fact', clip = true, axis = 'time' } = options
      const { fromMs, toMs } = options.window ?? seriesWindow(nodes)
      const values = nodes.map((node) => metricOf(node, metric, projection))
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
        return { index, node, value, clipped, unpriced: node.unpriced === true, x, y: yOf(clipped ? threshold : value) }
      })
      const { bars, marks } = decimatePoints(points, Math.max(1, Math.floor(width)))
      // Everything the canvas draws is folded into one string: the same points can
      // paint differently when the clipping, the scale or the window moves, and the
      // draw effect must run for each of those even though the points are unchanged.
      const digest = [
        axis, metric, projection, points.length,
        Math.round(points.reduce((sum, point) => sum + point.value, 0) * 1e6),
        threshold === null ? 'none' : Math.round(threshold * 1e6),
        Math.round(max * 1e6),
        Math.round(fromMs), Math.round(toMs), width, height,
        points.reduce((count, point) => count + (point.unpriced ? 1 : 0), 0),
      ].join(':')
      return { points, bars, marks, threshold, max, axis: scale, mode: axis, metric, projection, fromMs, toMs, width, height, xOf, yOf, digest }
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

      // Markers: the newest point of each column, in the warning color when its
      // value is the clipped one rather than the real one.
      for (const mark of plot.marks) {
        context.beginPath()
        context.arc(mark.x, mark.y, 2.4, 0, Math.PI * 2)
        context.fillStyle = mark.clipped ? colors.clipped : colors.accent
        context.fill()
      }

      // Unpriced Steps: a warning square where they would sit, so "no rate applies"
      // is visible in the chart itself and not only in the header flag. A token
      // metric still plots its value; the square is drawn on top of it.
      context.strokeStyle = colors.clipped
      context.lineWidth = 1.5
      for (const point of plot.points) {
        if (point.unpriced !== true) continue
        context.beginPath()
        context.rect(point.x - 2.5, Math.min(point.y, baseline - 2.5) - 2.5, 5, 5)
        context.stroke()
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

    /** The shell keeps one conversation store per session under this key. */
    const CONVERSATION_STORE_KEY = 'dsh.conversation.chat'
    /**
     * The fields that store starts with, in the shell's own order.
     *
     * The shell rehydrates by replacing its whole state with the stored JSON, so a
     * record written here has to name every field: a partial one would leave the
     * composer's draft, and the restored selection, `undefined` rather than empty.
     */
    const CONVERSATION_STORE_DEFAULTS = Object.freeze({
      selection: null, draft: '', view: null, inspect: null,
    })
    /** This view's own id, as registered in the `conversation.view` slot. */
    const COST_VIEW_ID = 'dsh-balance-cost'

    /**
     * Ask the shell to restore the Cost tab for a session before it is opened.
     *
     * Activating a binding only works for a session that is already bound, and the
     * shell restores the view of a freshly opened session from the per-session store
     * it hydrates on mount — so the preference is written first, over the fields the
     * shell expects to find and whatever else the record already holds. It is a
     * browser-local preference, so a reader who prefers another tab there simply
     * switches it back.
     */
    function preferCostView(storage, sessionId, viewId) {
      const name = `${CONVERSATION_STORE_KEY}.${sessionId}`
      try {
        const raw = storage?.getItem?.(name)
        const stored = raw === null || raw === undefined || raw === '' ? {} : JSON.parse(raw)
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
        const record = { ...CONVERSATION_STORE_DEFAULTS, ...stored, view: viewId ?? COST_VIEW_ID }
        storage.setItem(name, JSON.stringify(record))
        return true
      } catch {
        return false
      }
    }

    /** The money precision every figure in the view and the export is printed at. */
    function round6(value) {
      return Math.round(value * 1e6) / 1e6
    }

    /** What one session's own Steps cost together, as the settle record reports it. */
    function childCostOf(payload) {
      return (payload?.nodes ?? []).reduce(
        (total, node) => total + (typeof node.cost === 'number' ? node.cost : (node.reports ?? []).reduce((sum, report) => sum + (report.cost ?? 0), 0)),
        0,
      )
    }

    /** The two levels of detail the export offers, `costs` first: it is the default. */
    const EXPORT_DETAILS = Object.freeze(['costs', 'full'])
    /** Text longer than this is cut and flagged, at the `full` level only (D31). */
    const EXPORT_TEXT_LIMIT = 2000
    /** One text field as the export writes it: cut at the limit, and said so. */
    function truncateText(value) {
      const text = typeof value === 'string' ? value : ''
      if (text.length <= EXPORT_TEXT_LIMIT) return { text, truncated: false }
      let cut = EXPORT_TEXT_LIMIT
      // The limit counts UTF-16 units, so a cut can land between the halves of one
      // character written as a surrogate pair. Taking one unit less keeps the text a
      // string of whole characters; a file is read by people, not by code points.
      const half = text.charCodeAt(cut - 1)
      if (half >= 0xd800 && half <= 0xdbff) cut -= 1
      return { text: text.slice(0, cut), truncated: true }
    }

    /**
     * The download name of one export (D29).
     *
     * Local time, because the reader is the one reading the clock: the file is a
     * note to themselves, not a record of an instant in a log.
     */
    function exportFileName(sessionId, at) {
      const given = at instanceof Date ? at : new Date(at ?? Date.now())
      // A clock the browser cannot read leaves the stamp empty rather than writing NaN
      // into a file name; the file itself still carries the instants of the session.
      const date = Number.isNaN(given.getTime()) ? new Date() : given
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
      // Every id the harness mints starts with "session-": the prefix says nothing
      // about which session this is, so the name drops it before taking 8 characters.
      const raw = typeof sessionId === 'string' ? sessionId.replace(/^session-/, '') : ''
      // Only what a file name may hold: a session id is a UUID today, and the name has
      // to stay a name whatever a future id holds.
      const id = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 8)
      return `dsh-balance-${id === '' ? 'unknown' : id}-${stamp}.cost-history.ndjson`
    }

    /**
     * Assemble the export stream (D45).
     *
     * The builder is a pure function of what the routes returned, so the whole
     * stream is a unit test and the Host stays the only place that prices anything.
     * Records are ordered by `t` and then `seq` — a merged parent/child stream is
     * linear by construction and can be split again by `session` and `depth` — and
     * `i` is stamped only after ordering, because it is the position in the file.
     *
     * @param input - the session, its series payload, its optional text records and
     *   its optional children (`{ id, depth, payload, text }`), plus the detail level.
     * @returns one NDJSON document, newline-terminated.
     */
    function costHistory({ sessionId, title, version, detail = 'costs', payload, text = [], children = [] }) {
      const level = EXPORT_DETAILS.includes(detail) ? detail : 'costs'
      const full = level === 'full'
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : []
      const currency = payload?.currency ?? ''
      const records = []
      const push = (record) => records.push(record)

      /**
       * Every record of one session, whether it is the exported one or a child.
       *
       * `seqOf` keeps the source sequence where the log gave one; the projection
       * stamps it on reports and calls, and a synthesized record falls back to the
       * Step it belongs to rather than inventing a number.
       */
      const addSession = (id, depth, series, words) => {
        const own = Array.isArray(series?.nodes) ? series.nodes : []
        const callsInText = new Set(words.filter((record) => record.type === 'tool_call').map((record) => record.callId))
        for (const node of own) {
          const at = (value) => (typeof value === 'number' ? value : node.tStart)
          // A Compaction step is money without a conversation: it never joins the
          // per-Step line, and in the stream it is its own record type, with the
          // usage the summary call paid for and the Step it is anchored to (I7, I8).
          if (node.kind === 'compaction') {
            const anchor = node.turn === null || node.turn === undefined
              ? null
              : { turn: node.turn, step: node.step ?? null }
            push({
              type: 'compaction',
              session: id,
              depth,
              seq: node.reports?.[0]?.seq ?? 0,
              t: node.tStart,
              turn: node.turn ?? null,
              step: node.step ?? null,
              id: node.compaction?.id ?? '',
              model: node.compaction?.model ?? '',
              tokens: node.buckets ?? node.reports?.[0]?.buckets ?? {},
              cost: {
                fact: node.cost ?? node.reports?.[0]?.cost ?? 0,
                offPeak: node.offPeak?.cost ?? node.reports?.[0]?.offPeak?.cost ?? 0,
                peak: node.peak?.cost ?? node.reports?.[0]?.peak?.cost ?? 0,
              },
              shadowedTokenCount: node.compaction?.shadowedTokenCount ?? 0,
              anchor,
            })
          }
          for (const report of node.reports ?? []) {
            push({
              type: 'usage',
              session: id,
              depth,
              seq: report.seq ?? 0,
              t: at(report.time),
              turn: node.turn,
              step: node.step,
              model: report.model,
              tokens: report.buckets,
              cost: {
                fact: report.cost ?? 0,
                offPeak: report.offPeak?.cost ?? 0,
                peak: report.peak?.cost ?? 0,
              },
            })
          }
          for (const lost of node.evicted ?? []) {
            push({
              type: 'retry',
              session: id,
              depth,
              seq: lost.seq ?? 0,
              t: at(lost.time),
              turn: node.turn,
              step: node.step,
              model: lost.model,
              tokens: lost.buckets,
              cost: {
                fact: lost.cost ?? 0,
                offPeak: lost.offPeak?.cost ?? 0,
                peak: lost.peak?.cost ?? 0,
              },
              billed: false,
            })
          }
          // The call list of the projection carries the name, the id and the short
          // preview; the `full` level takes the call from the log instead, where the
          // whole argument string lives — one record per call, never both. The match
          // is by call id: a text read that came back short must not drop the calls
          // the projection still knows about.
          for (const call of node.calls ?? []) {
            if (full && callsInText.has(call.callId)) continue
            push({
              type: 'tool_call',
              session: id,
              depth,
              seq: call.seq ?? 0,
              t: at(call.time),
              turn: node.turn,
              step: node.step,
              name: call.name,
              callId: call.callId,
            })
          }
        }
        // The Findings the Host detected over this series. A Finding cites the Step it
        // starts at, so that Step's own instant and sequence order it in the stream
        // rather than a clock of the builder's own.
        for (const finding of Array.isArray(series?.findings) ? series.findings : []) {
          const anchor = own[finding.refs?.from ?? -1] ?? own[0]
          push({
            type: 'indicator',
            session: id,
            depth,
            seq: anchor?.reports?.[0]?.seq ?? 0,
            t: anchor?.tStart ?? null,
            turn: anchor?.turn ?? null,
            step: anchor?.step ?? null,
            kind: finding.kind,
            refs: finding.refs,
            severity: finding.severity,
            confidence: finding.confidence,
            evidence: finding.evidence,
          })
        }
        for (const word of words) {
          const t = typeof word.t === 'number' ? word.t : null
          const base = { session: id, depth, seq: word.seq ?? 0, t, turn: word.turn, step: word.step }
          // The text field is named by what it holds — `text` for a message or a
          // result, `arguments` for a call — and the cut is flagged beside it.
          if (word.type === 'tool_call') {
            const cut = truncateText(word.arguments)
            push({ ...base, type: 'tool_call', name: word.name, callId: word.callId, arguments: cut.text, truncated: cut.truncated })
          } else if (word.type === 'tool_result') {
            const cut = truncateText(word.text)
            push({ ...base, type: 'tool_result', callId: word.callId ?? '', isError: word.isError === true, text: cut.text, truncated: cut.truncated })
          } else {
            const cut = truncateText(word.text)
            push({ ...base, type: word.type, text: cut.text, truncated: cut.truncated })
          }
        }
      }

      addSession(sessionId, 0, payload, full ? text : [])
      const spawnTimes = new Map()
      for (const node of nodes) {
        for (const child of node.children ?? []) {
          spawnTimes.set(child.id, {
            t: typeof child.createdAt === 'number' ? child.createdAt : node.tStart,
            turn: node.turn,
            step: node.step,
            mode: child.mode,
            label: child.label,
            seq: typeof child.seq === 'number' ? child.seq : null,
          })
        }
      }
      for (const child of children) {
        const spawn = spawnTimes.get(child.id) ?? {
          t: child.payload?.nodes?.[0]?.tStart ?? null,
          turn: null,
          step: null,
          mode: child.mode ?? 'unknown',
          label: child.label ?? '',
          seq: null,
        }
        const own = Array.isArray(child.payload?.nodes) ? child.payload.nodes : []
        const start = own[0]
        const end = own[own.length - 1]
        // A marker belongs to the session that spawned the child, which for a
        // grandchild is a child session, and never to the exported root by default.
        const owner = child.parentId ?? sessionId
        push({
          type: 'subagent_spawn',
          session: owner,
          depth: Math.max(0, (child.depth ?? 1) - 1),
          seq: spawn.seq,
          t: spawn.t,
          turn: spawn.turn,
          step: spawn.step,
          child: child.id,
          mode: spawn.mode,
          label: spawn.label,
        })
        addSession(child.id, child.depth ?? 1, child.payload, full ? (child.text ?? []) : [])
        push({
          type: 'subagent_settle',
          session: owner,
          depth: Math.max(0, (child.depth ?? 1) - 1),
          // Synthesized by the builder: there is no log event to cite.
          seq: null,
          t: end?.tEnd ?? end?.tStart ?? spawn.t,
          turn: end?.turn ?? null,
          step: end?.step ?? null,
          child: child.id,
          // Money is printed at six decimals everywhere else; a settle that summed
          // rounded rows must not add a float tail of its own.
          cost: round6(child.payload ? childCostOf(child.payload) : 0),
          currency,
        })
      }

      const ordered = records
        .map((record, index) => ({ record, index }))
        .sort((a, b) => {
          const at = a.record.t ?? Number.MAX_SAFE_INTEGER
          const bt = b.record.t ?? Number.MAX_SAFE_INTEGER
          if (at !== bt) return at - bt
          if ((a.record.seq ?? 0) !== (b.record.seq ?? 0)) return (a.record.seq ?? 0) - (b.record.seq ?? 0)
          return a.index - b.index
        })
        .map(({ record }) => record)

      const meta = {
        type: 'meta',
        session: sessionId,
        depth: 0,
        seq: payload?.seq ?? 0,
        t: nodes[0]?.tStart ?? null,
        plugin: version ?? null,
        title: title ?? '',
        currency,
        detail: level,
        models: [...new Set(nodes.flatMap((node) => (node.reports ?? []).map((report) => report.model)))],
        rule: payload?.rule ?? null,
        projections: ['fact', 'offPeak', 'peak'],
        subagents: children.length > 0,
      }
      const stream = [meta, ...ordered]
      return `${stream.map((record, i) => JSON.stringify({ i, ...record })).join('\n')}\n`
    }

    /**
     * Open another session on its Cost view.
     *
     * `uiWorkspace.openSession` is the documented way to open a session; on top of it
     * the Cost tab is requested twice — as the stored preference of that session (so
     * the shell mounts it there) and on the conversation binding once the session is
     * bound (so an already-open session switches at once). Both are guarded and silent:
     * if the shell offers neither, the session still opens on whichever tab it prefers,
     * which is a degraded jump rather than a dead button.
     */
    function openSessionCost({ workspace, conversation, storage, sessionId, viewId, attempts, delay, schedule }) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (workspace?.openSession === undefined) return false
      preferCostView(storage, sessionId, viewId)
      workspace.openSession(sessionId)
      let left = attempts ?? 20
      const tick = delay ?? 150
      const timer = schedule ?? setTimeout
      const activate = () => {
        let binding
        try {
          binding = conversation?.binding?.(sessionId)
        } catch {
          binding = undefined
        }
        if (binding?.activate !== undefined) {
          try {
            binding.activate(viewId ?? COST_VIEW_ID)
          } catch {
            // A binding that refuses to be driven leaves the session opened on
            // whatever tab it was on: the reader can pick Cost there.
          }
          return
        }
        left -= 1
        if (left > 0) timer(activate, tick)
      }
      timer(activate, 0)
      return true
    }

    /**
     * Read the subagent tree of one session.
     *
     * This is the only read the view makes outside its own session, and it happens
     * only when the reader asks: `full` walks every session below rather than the
     * direct children. The parent's own total is never touched by the answer.
     */
    async function readSubtree(sessionId, full) {
      const query = `sessionId=${encodeURIComponent(sessionId)}${full === true ? '&full=1' : ''}`
      const response = await fetch(`/dsh-balance/session-cost/children?${query}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok === false) throw new Error(payload.error ?? 'subtree-failed')
      return payload
    }

    /**
     * The series of any session, priced by the Host.
     *
     * The view reads its own session through its hook; the export needs a foreign
     * session's series when the reader asked to include the subtree, and it is the
     * same route and the same pricing (D25, D45).
     */
    async function readSeries(sessionId) {
      const response = await fetch(`/dsh-balance/session-cost?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok === false) throw new Error(payload.error ?? 'series-failed')
      return payload
    }

    /**
     * Remember a value per session, keeping only the `limit` most recently written.
     *
     * The client's per-session maps outlive every component that reads them, and a
     * page outlives any one reader's sessions, so without a bound they grow for as
     * long as the tab is open. Each caller below states what its limit is for.
     *
     * Recency is the order of writing, not of reading: the key is deleted before it
     * is set again, which moves a key a reader keeps coming back to to the newest
     * position. A read deliberately does not touch the order — the reads that exist
     * happen on mount, right before the write that follows them, so refreshing there
     * would only mean that a component which renders repeatedly pushes other
     * sessions out.
     *
     * @param cache - the `Map` to write into.
     * @param key - the session to remember.
     * @param value - what to remember for it.
     * @param limit - how many sessions to hold.
     */
    function rememberRecent(cache, key, value, limit) {
      cache.delete(key)
      cache.set(key, value)
      while (cache.size > limit) cache.delete(cache.keys().next().value)
    }

    /**
     * How many sessions keep their read prompts in memory.
     *
     * This is the heaviest of the three caches — it holds the words of a session, not
     * a couple of numbers — and the working set is one session at a time: the one
     * being read, plus a subagent the reader just followed into. Four is several
     * times that. Past it, a preview is the same `GET .../session-cost/text` the
     * first one made, for a session the reader is only now returning to.
     */
    const MAX_PROMPT_SESSIONS = 4

    /**
     * The prompts of one session, read once and kept for the inspector.
     *
     * The projection carries usage rather than messages, so the prompt of a Step is
     * read from the session's words the first time a reader asks for one; only the
     * user messages are kept, not the whole log, and only for the
     * `MAX_PROMPT_SESSIONS` sessions whose prompts were asked for most recently.
     */
    const sessionPrompts = new Map()

    /**
     * The prompt that started a Step's Turn.
     *
     * The user message of a Turn is written before its Steps, and carries no Turn or
     * Step of its own, so the newest message at or before the Step's own start is the
     * one the Step answered.
     *
     * @param sessionId - the session whose words to read.
     * @param node - the Step the inspector is showing.
     * @returns the prompt text, or `null` when the session has none before that Step.
     */
    async function promptForNode(sessionId, node = {}) {
      let prompts = sessionPrompts.get(sessionId)
      if (prompts === undefined) {
        const records = await readText(sessionId)
        prompts = (Array.isArray(records) ? records : [])
          .filter((record) => record.type === 'user_message' && typeof record.text === 'string' && record.text.trim() !== '')
          .map((record) => ({ t: typeof record.t === 'number' ? record.t : null, text: record.text }))
        rememberRecent(sessionPrompts, sessionId, prompts, MAX_PROMPT_SESSIONS)
      }
      const start = typeof node.tStart === 'number' ? node.tStart : null
      if (start === null) return prompts.length === 0 ? null : prompts[prompts.length - 1].text
      let found = null
      for (const prompt of prompts) {
        if (prompt.t === null || prompt.t <= start) found = prompt.text
        else break
      }
      return found
    }

    /** The words of one session, for the `full` level of the export (D46). */
    async function readText(sessionId) {
      const response = await fetch(`/dsh-balance/session-cost/text?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok === false) throw new Error(payload.error ?? 'text-failed')
      return Array.isArray(payload.records) ? payload.records : []
    }

    /**
     * Hand the assembled stream to the browser as a download.
     *
     * Nothing is written to the workspace or the harness home: the file goes where
     * the browser puts downloads, and the reader moves it (D11).
     */
    function saveTextFile(name, text) {
      if (typeof document === 'undefined' || typeof Blob === 'undefined') return false
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
      // The object URL is released on the next task either way, so a click that
      // throws cannot leave it behind; the click itself happens in this task.
      setTimeout(() => URL.revokeObjectURL(url), 0)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      try {
        link.click()
      } finally {
        link.remove()
      }
      return true
    }

    /**
     * The child lines of one Step, in spawn order.
     *
     * The catalog entry is what the Step carries; the money arrives only with the
     * subtree read, so a child that has not been read stays in the list with no
     * figure instead of disappearing or reading as free.
     *
     * @param node - a Step record, with `children` when it spawned subagents.
     * @param lines - the child lines of the session (may be empty).
     * @returns `{ lines, loaded, cost, steps }` for that Step.
     */
    function subtreeOf(node, lines) {
      const all = Array.isArray(lines) ? lines : []
      const byId = new Map(all.map((line) => [line.id, line]))
      // The subtree is walked through the loaded lines, not through the Steps'
      // catalog entries alone: `Load full history` returns grandchildren too, and a
      // session that spawned children of its own must show them under its step
      // rather than vanish from a panel whose total already counts them (D25).
      const byParent = new Map()
      for (const line of all) {
        const list = byParent.get(line.parentId)
        if (list === undefined) byParent.set(line.parentId, [line])
        else list.push(line)
      }
      const merged = []
      const seen = new Set()
      const add = (child, depth) => {
        if (child === null || child === undefined || seen.has(child.id)) return
        seen.add(child.id)
        const line = byId.get(child.id)
        merged.push(line === undefined
          ? { ...child, depth, loaded: false, cost: null, steps: null }
          : { ...child, ...line, depth, loaded: true })
        for (const grand of byParent.get(child.id) ?? []) add(grand, depth + 1)
      }
      for (const child of node?.children ?? []) add(child, 0)
      const loaded = merged.filter((line) => line.loaded)
      return {
        lines: merged,
        loaded: loaded.length,
        cost: loaded.reduce((total, line) => total + line.cost, 0),
        steps: loaded.reduce((total, line) => total + (line.steps ?? 0), 0),
      }
    }

    /**
     * Every Step of the session that spawned subagents, oldest first.
     *
     * This is what attributes a subtree cost to the Step that caused it (D25): the
     * group's money is the sum of the child lines below it, never the parent's.
     */
    function stepGroups(nodes, lines) {
      const groups = []
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if (!Array.isArray(node.children) || node.children.length === 0) continue
        groups.push({ key: `${node.turn}:${node.step}`, turn: node.turn, step: node.step, ...subtreeOf(node, lines) })
      }
      return groups
    }

    /**
     * Which way an arrow key moves the selection: -1 back, 1 on, 0 for anything else.
     *
     * The keys belong to the view, but a reader typing in the composer or in a settings
     * field must keep their caret, so a focused input leaves the arrows alone.
     */
    function arrowDelta(event) {
      if (event === null || event === undefined) return 0
      if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return 0
      const target = event.target ?? {}
      const tag = String(target.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true) return 0
      if (event.key === 'ArrowLeft') return -1
      if (event.key === 'ArrowRight') return 1
      return 0
    }

    /**
     * Where an arrow key lands, clamped to the visible slice.
     *
     * With nothing selected yet the right arrow enters at the first Step and the left
     * arrow at the last: the keys have to work before the reader clicks anything.
     */
    function nextSelection(index, delta, count) {
      if (count <= 0) return -1
      if (index < 0 || index >= count) return delta > 0 ? 0 : count - 1
      return Math.max(0, Math.min(count - 1, index + delta))
    }

    /**
     * How many sessions keep the Step the reader last opened.
     *
     * An entry is a `{ turn, step }` pair, so memory is not what the number is about —
     * what is lost by dropping one is the mark. A session that comes back unmarked is
     * in the state it is in for a session the reader never marked in, and every Step
     * is still on screen, so a reader who has marked a Step in sixteen other sessions
     * since is working in a way this view does not model.
     */
    const MAX_STEP_SESSIONS = 16

    /**
     * The Step the reader last opened, per session.
     *
     * The conversation mounts only the selected view, so jumping to Trajectory and
     * coming back rebuilds the Cost view from scratch — and the Step the jump came
     * from must still be the one that is marked, or the reader has to find it again.
     * This is page memory, not a setting: nothing here is written to the Host, and
     * only the `MAX_STEP_SESSIONS` most recent sessions are kept.
     *
     * A mounted view cannot lose its mark to an eviction: the map is read once, by the
     * `useState` initializer, and the mark on screen is that component's own state.
     * Dropping an entry costs the mark on a *later* mount of that session and nothing
     * else.
     */
    const lastStep = new Map()

    /**
     * The newest subtree read per session.
     *
     * Two reads can overlap — "subagents only" and then "everything below" — and the
     * slower one must not land on top of the newer answer. Like the marked Step, this
     * is page memory: it is what the view is doing right now, never a setting.
     *
     * This one is bounded by concurrency, not by size. A counter is only ever compared
     * against the read that is in flight, so `loadSubtree` releases it once that read
     * has landed and the map holds nothing for an idle session. A size bound here would
     * be the wrong rule in both directions: an eviction between a read starting and
     * its answer arriving would make the comparison read as "superseded" and drop the
     * answer the reader is waiting for, stranding the panel on "loading".
     */
    const subtreeReads = new Map()

    /**
     * The Cost view: the per-Step chart with its tooltip, the top list and the inspector.
     */
    function CostView(props) {
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const live = typeof props.useProjection === 'function' ? props.useProjection('dshBalanceCost') : undefined
      const series = useCostSeries(sessionId, live?.seq ?? 0)
      // The selection is the Step, not an index: the window can change under it and the
      // view can be rebuilt, and `{ turn, step }` still names the same Step.
      const [step, setStep] = react.useState(() => lastStep.get(sessionId) ?? null)
      const [clip, setClip] = react.useState(true)
      const [ratesOpen, setRatesOpen] = react.useState(false)
      // The visible window as fractions of the series; `null` means the whole session.
      // It is deliberately not persisted (D34): reopening the view shows everything.
      const [range, setRange] = react.useState(null)
      // Stored choices arrive with the payload; a click in this mount wins over them
      // and is written straight through the settings route.
      const [picked, setPicked] = react.useState({})
      const payload = series.payload
      const stored = payload?.prefs ?? {}
      const projection = picked.projection ?? stored.costProjection ?? 'fact'
      const metric = picked.metric ?? stored.costMetric ?? 'cost'
      const axis = picked.axis ?? stored.costAxis ?? 'time'
      // A Step that reported no usage has no point to draw; the empty state below
      // is what says so, instead of a chart of zeroes.
      const allNodes = Array.isArray(payload?.nodes) ? payload.nodes : []
      const withUsage = allNodes.filter((node) => node.hasUsage === true)
      // A Compaction step is money without a conversation: it counts in the session
      // estimate but is never a point of the per-Step cost line (I7).
      const nodes = withUsage.filter((node) => node.kind !== 'compaction')
      const compactions = allNodes.filter((node) => node.kind === 'compaction')
      const session = seriesSummary(withUsage)
      /**
       * The subtree read: idle until the reader asks for it, because it is the one
       * action that reads other sessions (D26).
       */
      const [subtree, setSubtree] = react.useState({ status: 'idle', lines: [], total: null, diagnostics: [], findings: [], full: false, error: null })
      const [copied, setCopied] = react.useState(false)
      const [exportDetail, setExportDetail] = react.useState('costs')
      const [exportSubagents, setExportSubagents] = react.useState(false)
      const [exportState, setExportState] = react.useState({ status: 'idle', error: null })
      const spawns = allNodes.reduce((count, node) => count + (Array.isArray(node.children) ? node.children.length : 0), 0)
      const groups = stepGroups(allNodes, subtree.lines)
      const currency = payload?.currency ?? live?.currency ?? 'USD'
      // The three empty states and the error are properties of the session, not of the
      // window: zooming into a quiet interval must not turn the view into an empty state.
      const state = seriesState(series.status, payload, nodes, session)
      // The window is a fraction of the series, so the totals, the chart and top-K all
      // describe the same part of it and the axis switch keeps the same window.
      const slice = visibleSlice(nodes, range, axis)
      const summary = seriesSummary(slice.nodes)
      // A Compaction step is ranked with the Steps but draws no point of their line: it
      // is visible while its own instant falls inside the range on screen. Its money
      // still belongs to the figure the header leads with, which is the same Σ.
      const sliceFrom = slice.nodes.length > 0 ? slice.nodes[0].tStart : slice.fromMs
      const sliceTo = slice.nodes.length > 0
        ? slice.nodes[slice.nodes.length - 1].tEnd ?? slice.nodes[slice.nodes.length - 1].tStart
        : slice.toMs
      const visibleCompactions = isFullWindow(range)
        ? compactions
        : axis === 'index'
          ? compactions.filter((node) => node.tStart >= sliceFrom && node.tStart <= sliceTo)
          : compactions.filter((node) => node.tStart >= slice.fromMs && node.tStart <= slice.toMs)
      const summaryMoney = seriesSummary([...slice.nodes, ...visibleCompactions])
      // The Findings the Host detected travel with the series; the client only filters
      // them to the visible range, and that filter is memoised on the window (I24).
      const findings = findingsOf(payload)
      const nodeAt = new Map(allNodes.map((node, index) => [node, index]))
      const overlay = overlayMemo([
        sessionId, payload?.seq ?? 0, payload?.anomalies?.preset ?? '',
        JSON.stringify(payload?.fallbackRates ?? {}),
        axis, range === null ? 'all' : `${range.from}:${range.to}`, findings.length, slice.nodes.length,
      ].join(':'), () => overlayOf(allNodes, slice.nodes, findings))
      // Without a payload there is no figure to lead with: a dash beats a `$0.00`
      // that would read as "this session cost nothing".
      const total = payload === null ? null : session.totals[projection] ?? session.total
      // The headline follows the selected projection and the visible range; the session
      // and the `fact` figures stay beside it, so neither is ever hidden by the other.
      const shown = payload === null ? null : summaryMoney.totals[projection] ?? summaryMoney.total
      const windowed = !isFullWindow(range)
      // Where the remembered Step sits in what is on screen; -1 when the window or the
      // series no longer holds it, which is how a stale memory simply stops marking.
      const selected = step === null
        ? -1
        : slice.nodes.findIndex((node) => node.turn === step.turn && node.step === step.step)
      const selectedNode = selected >= 0 && selected < slice.nodes.length ? slice.nodes[selected] : null
      const selectedFindings = findingsAt(findings, nodeAt.get(selectedNode) ?? -1)

      const choose = (pick, key, value) => {
        setPicked((current) => ({ ...current, [pick]: value }))
        // Persisting is a convenience, never a gate: a failed write must not cost the
        // reader the choice they just made in this mount.
        void Promise.resolve(store.saveSettings({ [key]: value })).catch(() => {})
      }

      /** Select a Step by its place in the visible slice, and remember which one it is. */
      const select = (index) => {
        const node = slice.nodes[index]
        if (node === undefined) {
          setStep(null)
          lastStep.delete(sessionId)
          return
        }
        const named = { turn: node.turn, step: node.step }
        rememberRecent(lastStep, sessionId, named, MAX_STEP_SESSIONS)
        setStep(named)
      }

      /** Write fallback rates and re-read the series, which is priced by them. */
      const saveRates = async (next) => {
        await store.saveSettings({ fallbackRates: next })
        series.retry()
      }

      /**
       * Assemble and download the history export.
       *
       * The stream is built here from what the routes return (D45): the session's
       * own series, its words at the `full` level, and — when the reader asked for
       * them — every session below it, read through the same routes the subtree
       * panel uses. Nothing is written anywhere but the browser's download (D11).
       */
      const runExport = async () => {
        setExportState({ status: 'busy', error: null })
        try {
          const detail = exportDetail
          const full = detail === 'full'
          const childLines = exportSubagents ? (await readSubtree(sessionId, true)).children ?? [] : []
          const children = []
          for (const line of childLines) {
            const childPayload = await readSeries(line.id)
            children.push({
              id: line.id,
              parentId: line.parentId ?? sessionId,
              depth: line.depth,
              label: line.label,
              mode: line.mode,
              payload: childPayload,
              text: full ? await readText(line.id) : [],
            })
          }
          const stream = costHistory({
            sessionId,
            title: payload?.title ?? '',
            version: VERSION,
            detail,
            payload,
            text: full ? await readText(sessionId) : [],
            children,
          })
          saveTextFile(exportFileName(sessionId, new Date()), stream)
          setExportState({ status: 'done', error: null })
        } catch (error) {
          setExportState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }

      /**
       * Read the subtree, either the direct children or every session below.
       *
       * The reader is told while it runs: this is the only read of foreign sessions
       * the view performs, and it can be slow on a wide tree.
       */
      const loadSubtree = async (full) => {
        const read = (subtreeReads.get(sessionId) ?? 0) + 1
        subtreeReads.set(sessionId, read)
        setSubtree((current) => ({ ...current, status: 'loading', error: null }))
        try {
          const answer = await readSubtree(sessionId, full)
          // Two reads can overlap ("subagents only" and "everything below"); the
          // newest one is the answer, and a slower older one is dropped.
          if (subtreeReads.get(sessionId) !== read) return
          setSubtree({
            status: 'ok',
            lines: Array.isArray(answer.children) ? answer.children : [],
            total: answer.total ?? null,
            diagnostics: Array.isArray(answer.diagnostics) ? answer.diagnostics : [],
            // The subtree reading is a reading of its own: the Host detects over the
            // session series with the subtree cost folded in, and its Findings — the
            // expensive subtree among them — belong to this reading, not the session's.
            findings: findingsOf(answer),
            full: answer.full === true,
            error: null,
          })
        } catch (error) {
          if (subtreeReads.get(sessionId) !== read) return
          setSubtree((current) => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }))
        } finally {
          // The counter has done its work: the read it named has landed or has been
          // dropped as the older of two, and nothing will compare against it again,
          // so an idle session holds nothing. The guard repeats the test above, so a
          // read that was superseded leaves the newer read's counter alone.
          if (subtreeReads.get(sessionId) === read) subtreeReads.delete(sessionId)
        }
      }

      /** Move the visible window; `null` returns to the whole session. */
      const setWindow = (next) => {
        setStep(null)
        lastStep.delete(sessionId)
        setRange(isFullWindow(next) ? null : next)
      }

      // Left/right walk the Steps of the visible slice. The listener sits on the
      // document because the plot is a canvas and never takes focus itself; it is
      // re-registered every render so it always closes over the current selection.
      react.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          const delta = arrowDelta(event)
          if (delta === 0 || slice.nodes.length === 0) return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          select(nextSelection(selected, delta, slice.nodes.length))
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      })

      // Which session this is, on a line of its own: the id is the handle the reader
      // passes on — to an agent, an export or a bug report — so it is shown in full,
      // selectable as one token, and copyable in one click.
      const sessionIdLine = h('div', { className: 'dshb_cost_sessionline', key: 'session-line' }, [
        h('span', { className: 'dshb_cost_sub', key: 'label' }, t('cost.session.label')),
        h('code', { className: 'dshb_cost_id', key: 'id', title: sessionId }, sessionId),
        h('button', {
          key: 'copy',
          className: 'dshb_btn',
          onClick: () => {
            const done = () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }
            try {
              void navigator.clipboard?.writeText(sessionId).then(done, () => {})
            } catch {
              // A shell without the clipboard API simply leaves the id to be selected.
            }
          },
        }, copied ? t('cost.session.copied') : t('cost.session.copy')),
      ])

      const head = h('div', { className: 'dshb_cost_head', key: 'head' }, [
        h('span', { className: 'dshb_cost_total', key: 'total' }, costText(shown, currency)),
        payload === null ? null : h('span', { className: 'dshb_cost_sub', key: 'label' }, t(`cost.proj.${projection}`)),
        payload === null || windowed
          ? null
          : h('span', { className: 'dshb_cost_sub', key: 'steps' }, t('cost.steps', { steps: summary.steps })),
        windowed
          ? h('span', { className: 'dshb_cost_sub', key: 'range' }, t('cost.steps', { steps: summary.steps }))
          : null,
        windowed ? h('span', { className: 'dshb_cost_sub', key: 'session' }, t('cost.session', { value: costText(total, currency) })) : null,
        payload === null || projection === 'fact'
          ? null
          : h('span', { className: 'dshb_cost_sub', key: 'fact' }, t('cost.fact', { value: costText(session.totals.fact, currency) })),
        payload?.peakIntervals?.length > 0 && axis === 'time'
          ? h('span', { className: 'dshb_cost_sub', key: 'bands' }, t('cost.bandNote'))
          : null,
        // The account-wide figure sits beside the session estimate and says what it
        // is: the samples cover every session and every other charge (D27).
        payload?.calibration
          ? h('span', {
            className: 'dshb_cost_sub',
            key: 'calibration',
            title: t('cost.calibration.title', {
              from: clock(payload.calibration.from) ?? '—',
              to: clock(payload.calibration.to) ?? '—',
              samples: payload.calibration.samples,
            }),
          }, t('cost.calibration', { value: costText(payload.calibration.delta, currency) }))
          : null,
        spawns > 0
          ? h('span', { className: 'dshb_cost_sub', key: 'subagents' }, t('cost.subagents.count', { count: spawns }))
          : null,
        session.unpriced.length > 0
          ? h('span', { className: 'dshb_flag', key: 'unpriced' }, [
            t('cost.unpriced', { models: session.unpriced.join(', ') }),
            ' ',
            h('button', {
              key: 'rates',
              className: 'dshb_btn',
              onClick: () => setRatesOpen((open) => !open),
            }, t('cost.rates.enter')),
          ])
          : null,
      ])

      const topk = picked.topk ?? stored.costTopK ?? 'steps'
      // Which reading sits beside the inspector. A stored tab is only honoured while
      // the session has something to show on it, so a session without subagents never
      // opens on an empty one.
      const storedTab = picked.tab ?? stored.costTab ?? 'session'
      const tab = storedTab === 'subagents' && spawns === 0 ? 'session' : storedTab
      /**
       * Which reading the Findings card describes: the session's, or — while the
       * Subagents tab is open and the subtree has been read — that reading's own
       * verdicts, which the Host computed over this same series (I26). The chart and
       * the per-Step line stay the session's either way.
       */
      const subtreeReading = tab === 'subagents' && subtree.status === 'ok'
      const reading = {
        subtree: subtreeReading,
        rows: subtreeReading ? overlayOf(allNodes, slice.nodes, subtree.findings).rows : overlay.rows,
      }
      const controls = h('div', { className: 'dshb_cost_controls', key: 'controls' }, [
        h(Segmented, {
          key: 'projection',
          label: t('cost.control.projection'),
          value: projection,
          onSelect: (value) => choose('projection', 'costProjection', value),
          options: PROJECTIONS.map((value) => ({ value, label: t(`cost.proj.${value}`) })),
        }),
        h(Segmented, {
          key: 'metric',
          label: t('cost.control.metric'),
          value: metric,
          onSelect: (value) => choose('metric', 'costMetric', value),
          options: ['cost', 'output', 'cacheRead', 'cacheWrite', 'tokens'].map((value) => ({ value, label: t(`cost.metric.${value}`) })),
        }),
        h(Segmented, {
          key: 'axis',
          label: t('cost.control.axis'),
          value: axis,
          onSelect: (value) => choose('axis', 'costAxis', value),
          options: [{ value: 'time', label: t('cost.axis.time') }, { value: 'index', label: t('cost.axis.index') }],
        }),
        h(Segmented, {
          key: 'topk',
          label: t('cost.control.topk'),
          value: topk,
          onSelect: (value) => choose('topk', 'costTopK', value),
          options: [
            { value: 'steps', label: t('cost.topk.steps') },
            { value: 'turns', label: t('cost.topk.turns') },
          ],
        }),
      ])

      if (state !== 'ok') {
        return h('div', { className: 'dshb_cost' }, [
          sessionIdLine,
          head,
          controls,
          h(CostEmpty, {
            key: 'empty',
            t,
            state,
            error: series.error,
            onRetry: series.retry,
            models: session.unpriced,
            rates: payload?.fallbackRates,
            onRates: saveRates,
          }),
        ])
      }

      const plot = buildPlot(slice.nodes, { clip, axis, metric, projection, window: { fromMs: slice.fromMs, toMs: slice.toMs } })
      const clipped = plot.points.some((point) => point.clipped)
      // A Compaction step is ranked with the Steps but draws no point of their line.
      const rows = topRows(slice.nodes, {
        metric, projection, mode: topk, count: TOP_K, compactions: visibleCompactions,
      })
      const note = h('div', { className: 'dshb_cost_note', key: 'note' }, [
        h('span', { key: 'clip' }, clipped ? `${t('cost.clip', { value: costText(plot.threshold, currency) })} ` : ''),
        clipped ? h('button', { key: 'unclip', className: 'dshb_btn', onClick: () => setClip(false) }, t('cost.unclip')) : null,
        windowed ? h('button', { key: 'reset', className: 'dshb_btn', onClick: () => setWindow(null) }, t('cost.zoom.reset')) : null,
        h('span', { key: 'hint' }, t('cost.zoom.hint')),
      ])

      return h('div', { className: 'dshb_cost' }, [
        sessionIdLine,
        head,
        controls,
        h(CostChart, {
          key: 'chart',
          t,
          nodes: slice.nodes,
          payload,
          clip,
          axis,
          metric,
          projection,
          currency,
          range,
          topk,
          onWindow: setWindow,
          total: shown,
          selected,
          onSelect: select,
          overlay,
          anomalies: payload?.anomalies ?? null,
          compactions,
        }),
        note,
        h(CostExport, {
          key: 'export',
          t,
          detail: exportDetail,
          subagents: exportSubagents,
          spawns,
          state: exportState,
          onDetail: setExportDetail,
          onSubagents: setExportSubagents,
          onRun: runExport,
        }),
        // The tabs switch what the panes below the chart describe. The subtree is a
        // tab of its own, never a row of the session's total (D25), and the strip
        // only appears when the session actually spawned something.
        spawns > 0
          ? h('div', { key: 'tabs', className: 'dshb_cost_tabrow' }, [
            h(CostTabs, {
              t,
              value: tab,
              spawns,
              onSelect: (value) => choose('tab', 'costTab', value),
            }),
            h('span', { key: 'hint', className: 'dshb_cost_note' }, t('cost.tab.hint')),
          ])
          : null,
        // The inspector and the reading beside it describe the same selection, so they
        // sit side by side: the Step reached from a row is read next to the row that
        // led there, and the Step that spawned a subtree is read next to that subtree.
        h('div', { className: 'dshb_cost_panes', key: 'panes' }, [
          h('div', { className: 'dshb_cost_pane', key: 'inspector' }, h(CostInspector, {
            t,
            node: selectedNode,
            currency,
            total,
            projection,
            peakIntervals: payload?.peakIntervals ?? [],
            inspectCall: props.inspectCall,
            loadPrompt: props.loadPrompt,
            subtree,
            onLoadSubtree: loadSubtree,
            onOpenSubtree: props.openSessionCost,
            findings: selectedFindings,
            anomalies: payload?.anomalies ?? null,
          })),
          h('div', { className: 'dshb_cost_pane', key: tab }, tab === 'subagents'
            ? h(Subagents, {
              t,
              currency,
              groups,
              spawns,
              state: subtree,
              onLoad: loadSubtree,
              onOpen: props.openSessionCost,
            })
            : h(TopK, {
              t,
              rows,
              mode: topk,
              currency,
              total,
              intervals: payload?.peakIntervals ?? [],
              selected,
              onSelect: select,
            })),
          // The third card of the band: the Findings of the visible range, scrollable
          // inside itself so the two readings beside it keep their height (I20).
          h('div', { className: 'dshb_cost_pane', key: 'findings' }, h(Findings, {
            t,
            rows: reading.rows,
            anomalies: payload?.anomalies ?? null,
            currency,
            steps: withUsage.length,
            subtree: reading.subtree,
            onSelect: select,
          })),
        ]),
        ratesOpen && session.unpriced.length > 0
          ? h(RateEntry, { key: 'rates', t, models: session.unpriced, rates: payload?.fallbackRates, onSave: saveRates })
          : null,
      ])
    }

    /**
     * The top rows below the chart: the ten heaviest Steps or Turns of the visible
     * range, each saying what it is — when it ran, which model paid, what it called,
     * where the tokens went, what it cost and how much of the session that is.
     */
    function TopK({ t, rows, mode, currency, total, intervals, selected, onSelect }) {
      const head = h('div', { className: 'dshb_cost_note', key: 'title' }, t('cost.topk.title'))
      if (rows.length === 0) {
        return h('div', { className: 'dshb_topk dshb_cost_card' }, [head, h('div', { className: 'dshb_cost_note', key: 'empty' }, t('cost.topk.empty'))])
      }
      return h('div', { className: 'dshb_topk dshb_cost_card' }, [
        head,
        ...rows.map((row, position) => h('div', {
          key: row.key,
          className: [
            'dshb_topk_row',
            row.index >= 0 && row.index === selected ? 'dshb_topk_row_on' : '',
            row.kind === 'compaction' ? 'dshb_topk_row_off' : '',
          ].filter((part) => part !== '').join(' '),
          onClick: row.index >= 0 ? () => onSelect(row.index) : undefined,
          role: row.index >= 0 ? 'button' : undefined,
        }, [
          h('span', { className: 'dshb_topk_head', key: 'head' }, [
            h('span', { className: 'dshb_topk_rank', key: 'rank' }, `#${position + 1}`),
            h('span', { key: 'turn' }, row.kind === 'compaction'
              ? t('cost.compaction.row')
              : t('cost.tip.turn', { turn: row.turn, step: row.step })),
            mode === 'turns' ? h('span', { className: 'dshb_cost_sub', key: 'steps' }, ` · ${t('cost.topk.ofSteps', { steps: row.steps })}`) : null,
            h('span', { className: 'dshb_cost_sub', key: 'when' }, ` · ${clock(row.tStart) ?? ''}`),
            // A row identifies itself the way the tooltip does, phase included.
            h('span', { className: 'dshb_cost_sub', key: 'phase' }, ` · ${t(`cost.tip.phase.${phaseOf(row.tStart, intervals)}`)}`),
          ]),
          h('span', { className: 'dshb_topk_money', key: 'money' }, `${costText(row.cost, currency)} · ${shareOf(row.cost, total)}`),
          h('span', { className: 'dshb_topk_body', key: 'body' }, [
            (row.models ?? []).join(', '),
            bucketLine(row.buckets),
            row.kind === 'compaction'
              ? t('cost.compaction.body', { tokens: compactNumber(row.compaction?.shadowedTokenCount ?? 0) })
              : '',
            row.call === null || row.call === undefined ? '' : `${row.call.name} ${row.call.preview.split('\n')[0]}`,
            row.unpriced ? t('cost.topk.unpriced') : '',
            row.inProgress ? t('cost.inspector.inProgress') : '',
          ].filter((part) => part !== '').join(' · ')),
        ])),
      ])
    }

    /**
     * The findings card: the third card of the band under the chart (I20).
     *
     * It scrolls inside itself rather than extending the page, so including indicators
     * never pushes the top-K list or the export controls away, and it says so plainly
     * when the visible range holds nothing — an empty card would read as a failure.
     */
    function Findings({ t, rows, anomalies, currency, steps, onSelect, subtree = false }) {
      const head = h('div', { className: 'dshb_cost_note', key: 'title' }, t('cost.findings.title'))
      const scope = subtree ? h('div', { className: 'dshb_cost_note', key: 'scope' }, t('cost.findings.subtree')) : null
      // The thresholds the Host detected under travel with the series: the card states
      // the preset and, on hover, every effective gate — read-only, because the preset
      // and the overrides are plugin configuration, not a view setting (I13).
      const effective = thresholdLines(anomalies)
      const presetLine = anomalies === null || anomalies === undefined
        ? null
        : h('div', {
          className: 'dshb_cost_note',
          key: 'preset',
          title: effective.length === 0 ? undefined : effective.join('\n'),
        }, t('cost.findings.preset', { preset: t(`cost.finding.preset.${anomalies.preset}`) }))
      const note = h('div', { className: 'dshb_cost_note', key: 'legend' }, t('cost.findings.legend'))
      if (rows.length === 0) {
        return h('div', { className: 'dshb_findings dshb_cost_card' }, [
          head,
          scope,
          presetLine,
          h('div', { className: 'dshb_cost_note', key: 'empty' }, t('cost.findings.empty')),
          steps > 0 && steps < 8 ? h('div', { className: 'dshb_cost_note', key: 'norm' }, t('cost.findings.norm')) : null,
          note,
        ])
      }
      return h('div', { className: 'dshb_findings dshb_cost_card' }, [
        head,
        scope,
        presetLine,
        h('div', { className: 'dshb_findings_list', key: 'list' }, rows.map((row, position) => {
          const text = findingText(t, row, { currency })
          return h('div', {
            key: `${row.kind}-${row.refs?.from ?? position}-${position}`,
            className: row.severity === 'alert'
              ? 'dshb_finding dshb_finding_alert'
              : row.severity === 'warn' ? 'dshb_finding dshb_finding_warn' : 'dshb_finding',
            title: findingExplain(t, row, { currency, anomalies }).join('\n'),
            onClick: () => onSelect(row.at),
            role: 'button',
          }, [
            h('span', { className: 'dshb_finding_head', key: 'head' }, [
              h('span', { key: 'glyph' }, FINDING_GLYPH[row.kind] ?? '·'),
              h('span', { key: 'kind' }, t(`cost.finding.kind.${row.kind}`)),
              h('span', { className: 'dshb_cost_sub', key: 'place' }, ` · ${findingPlace(t, row)}`),
              row.partial ? h('span', { className: 'dshb_finding_partial', key: 'partial' }, t('cost.findings.partial')) : null,
            ]),
            h('span', { className: 'dshb_cost_sub', key: 'conf' }, t('cost.findings.confidence', {
              value: row.confidence,
              severity: t(`cost.finding.severity.${row.severity}`),
            })),
            h('span', { className: 'dshb_finding_text', key: 'text' }, text),
          ])
        })),
        note,
      ])
    }

    /** One segmented control: a button per choice, the selected one on. */
    function Segmented({ label, options, value, onSelect }) {
      return h('span', { className: 'dshb_cost_seg' }, [
        h('span', { className: 'dshb_cost_segLabel', key: 'label' }, label),
        ...options.map((option) => h('button', {
          key: option.value,
          className: option.value === value ? 'dshb_seg dshb_seg_on' : 'dshb_seg',
          onClick: () => onSelect(option.value),
        }, option.label)),
      ])
    }

    /**
     * The export line: the detail level, whether to fold in the subtree, and the
     * download itself.
     *
     * The warning is not a dialog but a line that appears with the `full` level, so
     * the reader sees what a `full` export carries before pressing the button that
     * produces it (D31). Subagents are a separate choice because reading them reads
     * other sessions (D23).
     */
    function CostExport({ t, detail, subagents, spawns, state, onDetail, onSubagents, onRun }) {
      const busy = state.status === 'busy'
      return h('div', { className: 'dshb_export' }, [
        h('span', { className: 'dshb_cost_sub', key: 'title' }, t('cost.export.title')),
        h(Segmented, {
          key: 'detail',
          label: t('cost.export.detail'),
          value: detail,
          onSelect: onDetail,
          options: EXPORT_DETAILS.map((value) => ({ value, label: t(`cost.export.detail.${value}`) })),
        }),
        spawns > 0
          ? h('label', { className: 'dshb_export_check', key: 'subagents' }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: subagents,
              onChange: (event) => onSubagents(event.target.checked === true),
            }),
            ' ',
            t('cost.export.subagents'),
          ])
          : null,
        h('button', {
          key: 'run',
          className: 'dshb_btn',
          disabled: busy,
          onClick: () => { void onRun() },
        }, busy ? t('cost.export.busy') : t('cost.export.download')),
        state.status === 'done' ? h('span', { className: 'dshb_cost_sub', key: 'done' }, t('cost.export.done')) : null,
        state.status === 'error' ? h('span', { className: 'dshb_flag', key: 'failed' }, t('cost.export.failed', { error: state.error ?? '' })) : null,
        detail === 'full'
          ? h('span', { className: 'dshb_flag', key: 'warn' }, t('cost.export.warn'))
          : null,
      ])
    }

    /**
     * The under-chart tabs: the session's own figures, or the subagents it spawned.
     *
     * The choice only decides what is drawn below the chart. It never moves money:
     * the session total stays the session's own, and the subtree keeps its own
     * figure on its own tab (D25).
     */
    function CostTabs({ t, value, spawns, onSelect }) {
      const options = [
        { value: 'session', label: t('cost.tab.session') },
        { value: 'subagents', label: spawns > 0 ? t('cost.tab.subagents', { count: spawns }) : t('cost.tab.subagentsCount') },
      ]
      return h('div', { className: 'dshb_cost_tabs', role: 'tablist' }, options.map((option) => h('button', {
        key: option.value,
        role: 'tab',
        'aria-selected': option.value === value ? 'true' : 'false',
        className: option.value === value ? 'dshb_cost_tab dshb_cost_tabOn' : 'dshb_cost_tab',
        onClick: () => onSelect(option.value),
      }, option.label)))
    }

    /** Editable text of the rate rows: a model without a rate keeps an empty field. */
    function rateDraftOf(models, rates) {
      const draft = {}
      for (const model of models ?? []) {
        const rate = rates?.[model] ?? {}
        draft[model] = Object.fromEntries(RATE_KEYS.map((key) => [key, Number.isFinite(rate[key]) ? String(rate[key]) : '']))
      }
      return draft
    }

    /**
     * The fallback-rate editor: one row per model, peak rates per 1M tokens.
     *
     * A rate entered here reprices the whole history — the note says so before the
     * save, and the caller re-reads the series afterwards. Off-peak is half of these
     * and a cache write is billed as a cache miss, which is what the Host applies.
     */
    function RateEntry({ t, models, rates, onSave }) {
      const [draft, setDraft] = react.useState(() => rateDraftOf(models, rates))
      const [status, setStatus] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const list = models ?? []
      // Nothing to price: an editor without a model row would only be a stray button.
      if (list.length === 0) return null

      const field = (model, key, label) => h('label', { className: 'dshb_field', key }, [
        h('span', { key: 'l' }, label),
        h('input', {
          key: 'i',
          type: 'number',
          step: '0.001',
          value: draft?.[model]?.[key] ?? '',
          onChange: (event) => setDraft((current) => ({
            ...current,
            [model]: { ...(current?.[model] ?? {}), [key]: event.target.value },
          })),
        }),
      ])

      const save = async () => {
        const next = { ...(rates ?? {}) }
        for (const model of list) {
          const row = draft?.[model] ?? {}
          const filled = RATE_KEYS.filter((key) => String(row[key] ?? '').trim() !== '')
          if (filled.length === 0) {
            delete next[model]
            continue
          }
          const rate = {}
          for (const key of RATE_KEYS) {
            // An untouched field is not a rate of zero: Number('') is 0, which would
            // pass the checks below and quietly under-price the model. The spec wants
            // the row written only when every rate is a non-negative number.
            const text = String(row[key] ?? '').trim()
            const value = Number(text)
            if (text === '' || !Number.isFinite(value) || value < 0) {
              setStatus(t('cost.rates.invalid'))
              return
            }
            rate[key] = value
          }
          next[model] = rate
        }
        setBusy(true)
        setStatus('')
        try {
          await onSave(next)
          setStatus(t('cost.rates.saved'))
        } catch (cause) {
          setStatus(t('cost.rates.failed', { error: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dshb_rates' }, [
        h('div', { className: 'dshb_cost_note', key: 'note' }, t('cost.rates.note')),
        ...list.map((model) => h('div', { className: 'dshb_rates_row', key: model }, [
          h('span', { className: 'dshb_rates_model', key: 'm' }, model),
          field(model, 'cacheMiss', t('cost.rates.miss')),
          field(model, 'cacheHit', t('cost.rates.hit')),
          field(model, 'output', t('cost.rates.output')),
        ])),
        h('div', { className: 'dshb_cost_actions', key: 'actions' }, [
          status === '' ? null : h('span', { className: 'dshb_cost_note', key: 's' }, status),
          h('button', {
            key: 'save',
            className: 'dshb_btn dshb_btn_primary dshb_rates_save',
            disabled: busy,
            onClick: () => { void save() },
          }, t('cost.rates.save')),
        ]),
      ])
    }

    /** The in-flight read: a long session folds and prices for a moment, and must say so. */
    function Spinner({ label }) {
      return h('div', { className: 'dshb_spinner', role: 'status' }, [
        h('span', { className: 'dshb_spinner_ring', key: 'ring' }),
        h('span', { key: 'label' }, label),
      ])
    }

    /** The in-place empty and error states: they explain themselves, no blank plot. */
    function CostEmpty({ t, state, error, onRetry, models, rates, onRates }) {
      if (state === 'loading') return h('div', { className: 'dshb_cost_empty' }, h(Spinner, { label: t('cost.loading') }))
      const message = state === 'error'
        ? `${t('cost.empty.error')}${error === null || error === undefined ? '' : ` (${error})`}`
        : state === 'empty-rates'
          ? t('cost.empty.rates')
          : t('cost.empty.steps')
      return h('div', { className: 'dshb_cost_empty' }, [
        h('span', { key: 'text' }, message),
        state === 'error' ? h('button', { key: 'retry', className: 'dshb_btn', onClick: onRetry }, t('cost.retry')) : null,
        state === 'empty-rates' && (models ?? []).length > 0
          ? h(RateEntry, { key: 'rates', t, models, rates, onSave: onRates })
          : null,
      ])
    }

    function CostChart({ t, nodes, payload, clip, currency, total, axis, metric, projection, range, topk, onWindow, selected, onSelect, overlay = null, anomalies = null, compactions = [] }) {
      const boxRef = react.useRef(null)
      const canvasRef = react.useRef(null)
      const tooltipRef = react.useRef(null)
      const dragRef = react.useRef(null)
      const squelchRef = react.useRef(false)
      const [size, setSize] = react.useState({ width: 720, height: 240 })
      const [tip, setTip] = react.useState({ width: 0, height: 0 })
      const [hover, setHover] = react.useState(-1)
      const [brush, setBrush] = react.useState(null)
      const plot = buildPlot(nodes, { width: size.width, height: size.height, clip, axis, metric, projection })
      const intervals = payload?.peakIntervals ?? []

      /** The plot's box: the measured one when the DOM gives it, a left edge at 0 otherwise. */
      const boxRect = () => {
        const box = boxRef.current
        if (box !== null && box !== undefined && typeof box.getBoundingClientRect === 'function') {
          return box.getBoundingClientRect()
        }
        return { left: 0, width: plot.width, height: plot.height }
      }

      /** The pointer's position inside the plot, in pixels. */
      const localX = (event) => Math.max(0, Math.min(plot.width, event.clientX - boxRect().left))

      /** A pixel column as a fraction of the whole series, whatever the window shows. */
      const toFraction = (x) => {
        const width = plot.width > 0 ? plot.width : 1
        const current = isFullWindow(range) ? { from: 0, to: 1 } : range
        return current.from + (current.to - current.from) * (x / width)
      }

      const startDrag = (event) => {
        const x = localX(event)
        if (event.button === 2) {
          dragRef.current = { kind: 'pan', last: x }
          return
        }
        if (event.button !== 0) return
        dragRef.current = { kind: 'brush', start: x, moved: false }
        setBrush({ from: x, to: x })
      }

      const moveDrag = (event) => {
        const x = localX(event)
        setHover(nearest(event))
        const drag = dragRef.current
        if (drag === null || drag === undefined) return
        if (drag.kind === 'pan') {
          const width = plot.width > 0 ? plot.width : 1
          onWindow(panWindow(range, -(x - drag.last) / width))
          drag.last = x
          return
        }
        drag.moved = Math.abs(x - drag.start) > 4
        setBrush({ from: drag.start, to: x })
      }

      const endDrag = () => {
        const drag = dragRef.current
        dragRef.current = null
        const current = brush
        setBrush(null)
        if (drag === null || drag === undefined) return
        if (drag.kind !== 'brush' || drag.moved !== true || current === null) return
        // A brushed interval becomes the new window; the click that follows the drag
        // is squelched, because it would select a point of the range that just went away.
        squelchRef.current = true
        onWindow(clampWindow(
          Math.min(toFraction(Math.min(current.from, current.to)), toFraction(Math.max(current.from, current.to))),
          Math.max(toFraction(Math.min(current.from, current.to)), toFraction(Math.max(current.from, current.to))),
        ))
      }

      const wheel = (event) => {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const width = plot.width > 0 ? plot.width : 1
        onWindow(zoomWindow(range, event.deltaY > 0 ? 1.25 : 0.8, localX(event) / width))
      }

      react.useEffect(() => {
        const box = boxRef.current
        if (box === null || box === undefined) return undefined
        /**
         * Refuse the panel's scroll while the reader zooms.
         *
         * React hangs its own `wheel` on the root as a passive listener, where
         * `preventDefault` is ignored: the zoom below still works, but the panel
         * would scroll under the pointer at the same time. Only a native listener
         * can stop that, so one is attached here, and it does nothing else.
         */
        const stopScroll = (event) => {
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }
        const listening = typeof box.addEventListener === 'function'
        if (listening) box.addEventListener('wheel', stopScroll, { passive: false })
        const release = () => {
          if (listening && typeof box.removeEventListener === 'function') box.removeEventListener('wheel', stopScroll)
        }
        if (typeof box.getBoundingClientRect !== 'function') return release
        const measure = () => {
          const rect = box.getBoundingClientRect()
          if (rect.width > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) || 240 })
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(box)
          return () => {
            observer.disconnect()
            release()
          }
        }
        return release
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
        const x = localX(event)
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

      // Peak bands and Turn separators are facts about time: on the Step-index axis
      // they would place a window at a Step count, which means nothing.
      const bands = axis === 'time' ? bandRanges(intervals, plot.fromMs, plot.toMs).map((band, index) => h('div', {
        key: `band-${index}`,
        className: 'dshb_cost_band',
        style: { left: `${band.from * 100}%`, width: `${(band.to - band.from) * 100}%` },
      })) : []
      const separators = axis === 'time' ? turnSeparators(nodes, plot.fromMs, plot.toMs).map((separator, index) => h('div', {
        key: `sep-${index}`,
        className: 'dshb_cost_sep',
        style: { left: `${separator.x * 100}%` },
      })) : []
      // Turn bands answer "where does this Turn start and end" while the top list is
      // grouped by Turn; alternating shades keep the boundary readable without a legend.
      const turnBands = topk === 'turns' ? turnSpans(plot.points, plot.width).map((span, index) => h('div', {
        key: `turn-${span.turn}`,
        className: index % 2 === 0 ? 'dshb_cost_turn dshb_cost_turn_alt' : 'dshb_cost_turn',
        style: { left: `${span.from}px`, width: `${Math.max(0, span.to - span.from)}px` },
      }, h('span', { className: 'dshb_cost_turnLabel', key: 'label' }, `T${span.turn}`))) : []
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
      const ticks = (axis === 'index' ? indexTicks(nodes) : plotTicks(plot.fromMs, plot.toMs)).map((tick, index) => h('span', {
        key: `tick-${index}`,
        className: 'dshb_cost_tick',
        style: { left: `${tick.x * 100}%` },
      }, tick.label ?? clock(tick.at) ?? ''))

      // A hover index that is not an integer cannot name a point: the view is driven
      // by pointer events, but it must never index the array with a stray value.
      const hovered = Number.isInteger(hover) && hover >= 0 && hover < plot.points.length ? plot.points[hover] : null
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
      }, tooltipLines(hovered.node, {
        t,
        currency,
        total,
        intervals,
        projection,
        findings: overlay === null ? [] : overlay.at.get(hovered.index) ?? [],
        anomalies,
      })
        .map((line, index) => h('div', { key: `line-${index}` }, line)))

      const marker = selected >= 0 && selected < plot.points.length ? h('div', {
        key: 'marker',
        className: 'dshb_cost_mark',
        style: { left: `${plot.points[selected].x}px`, top: `${plot.points[selected].y}px` },
      }) : null

      // A Step that spawned subagents says so on the chart: the child's money never
      // enters the plot, but the spawn is a fact about this Step.
      const spawns = plot.points
        .filter((point) => Array.isArray(point.node.children) && point.node.children.length > 0)
        .map((point) => h('div', {
          key: `spawn-${point.index}`,
          className: 'dshb_cost_spawn',
          title: t('cost.subagents.mark', { labels: point.node.children.map((child) => child.label === '' ? child.id.slice(0, 8) : child.label).join(', ') }),
          style: { left: `${point.x}px`, top: `${point.y}px` },
        }))

      // The brushed interval, drawn while the pointer drags it. It is discarded on
      // release (the window becomes the range) and never stored anywhere (D34).
      const selection = brush === null ? null : h('div', {
        key: 'brush',
        className: 'dshb_cost_brush',
        style: {
          left: `${Math.min(brush.from, brush.to)}px`,
          width: `${Math.abs(brush.to - brush.from)}px`,
        },
      })

      // The Indicator badges: one per Step, the glyph of the most severe Finding it
      // carries plus the count of the others. An `info` Finding draws none (I19).
      const badges = overlay === null ? [] : overlay.marks.flatMap((mark) => {
        const point = plot.points[mark.index]
        if (point === undefined) return []
        const explained = (overlay.at.get(mark.index) ?? []).filter((finding) => finding.kind === mark.kind)
        const title = explained.length === 0
          ? t(`cost.finding.kind.${mark.kind}`)
          : findingExplain(t, explained[0], { currency, anomalies }).join('\n')
        return [h('button', {
          key: `badge-${mark.index}`,
          type: 'button',
          className: `dshb_cost_badge dshb_cost_badge_${mark.severity}`,
          title,
          style: { left: `${point.x}px`, top: `${point.y}px` },
          onClick: (event) => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            onSelect(mark.index)
          },
        }, [
          h('span', { key: 'glyph' }, FINDING_GLYPH[mark.kind] ?? '·'),
          mark.count > 1 ? h('span', { key: 'count', className: 'dshb_cost_badgeCount' }, String(mark.count)) : null,
        ])]
      })

      // A Compaction step draws no point of the cost line, but it is real money: it
      // gets one mark of its own at its own instant, never a Step's column (I7).
      const compactionMarks = compactions.flatMap((node, index) => {
        if (plot.points.length === 0) return []
        let at = null
        if (plot.mode === 'index') {
          const point = plot.points.find((entry) => entry.node.tStart >= node.tStart) ?? plot.points[plot.points.length - 1]
          at = point.x
        } else if (node.tStart >= plot.fromMs && node.tStart <= plot.toMs) {
          at = plot.xOf(node.tStart)
        }
        if (at === null) return []
        return [h('div', {
          key: `compaction-${node.compaction?.id ?? index}`,
          className: 'dshb_cost_compaction',
          title: t('cost.compaction.mark', {
            cost: costText(node.cost ?? 0, currency),
            tokens: compactNumber(node.compaction?.shadowedTokenCount ?? 0),
          }),
          style: { left: `${at}px` },
        })]
      })

      return h('div', null, [
        h('div', { key: 'chart', className: 'dshb_cost_chart' }, [
          h('div', { key: 'yaxis', className: 'dshb_cost_yaxis' }, yLabels),
          h('div', {
            key: 'plot',
            className: 'dshb_cost_plot',
            ref: boxRef,
            onMouseMove: moveDrag,
            onMouseLeave: () => setHover(-1),
            onMouseDown: startDrag,
            onMouseUp: endDrag,
            onWheel: wheel,
            onContextMenu: (event) => { if (typeof event.preventDefault === 'function') event.preventDefault() },
            onDoubleClick: () => onWindow(null),
            onClick: (event) => {
              // A click that ended a brush must not also select a point of the range
              // that the brush just replaced.
              if (squelchRef.current) {
                squelchRef.current = false
                return
              }
              const index = nearest(event)
              if (index >= 0) onSelect(index)
            },
          }, [
            ...turnBands,
            ...bands,
            ...gridlines,
            h('canvas', { key: 'canvas', className: 'dshb_cost_canvas', ref: canvasRef }),
            ...separators,
            selection,
            ...spawns,
            marker,
            ...compactionMarks,
            ...badges,
            tooltip,
          ]),
        ]),
        h('div', { key: 'axis', className: 'dshb_cost_axis', style: { marginLeft: 64 } }, ticks),
      ])
    }

    /** A share as a percentage, at the precision its own size deserves. */
    function percentText(share) {
      const value = (share ?? 0) * 100
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`
    }

    /** A ratio as `4.2×`, which is how a spike names its distance from the median. */
    function multipleText(value, base) {
      if (!(base > 0) || !Number.isFinite(value)) return '—'
      return `${(value / base).toFixed(1)}×`
    }

    /**
     * The numbers behind one Finding, in the reader's language.
     *
     * The Host reports structured evidence (I23) and every sentence is built here, so
     * the Russian UI gets Russian sentences: the numbers, the threshold they cleared
     * and the baseline they were measured against are all named.
     */
    function findingText(t, finding, options = {}) {
      const { currency = 'USD' } = options
      const e = finding.evidence ?? {}
      const money = (value) => costText(value ?? 0, currency)
      const tokens = (value) => compactNumber(value ?? 0)
      const z = (value) => (value === null || value === undefined ? '—' : String(value))
      switch (finding.kind) {
        case 'spike':
          return t('cost.finding.spike.text', {
            cost: money(e.value),
            multiple: multipleText(e.value, e.median),
            median: money(e.median),
            threshold: money(e.threshold),
            z: z(e.z),
            share: percentText(e.share),
          })
        case 'verbose-output':
          return t('cost.finding.verbose.text', {
            value: tokens(e.value), threshold: tokens(e.threshold), median: tokens(e.median), z: z(e.z),
          })
        case 'context-growth':
          return t('cost.finding.growth.text', {
            rise: money(e.value), median: money(e.median), steps: e.steps, r2: z(e.r2), threshold: money(e.threshold),
          })
        case 'retry-storm':
          return e.metric === 'retriedSteps'
            ? t('cost.finding.retry.turn', { count: e.value, threshold: e.threshold, turn: e.turn, cost: money(e.cost) })
            : t('cost.finding.retry.step', { count: e.value, threshold: e.threshold, cost: money(e.cost) })
        case 'cache-miss':
          return t('cost.finding.cache.text', {
            share: percentText(e.value), steps: e.steps, threshold: percentText(e.threshold),
          })
        case 'tool-output-inflation':
          return t('cost.finding.tool.text', {
            delta: tokens(e.value), threshold: tokens(e.threshold), tools: (e.tools ?? []).join(', '),
          })
        case 'post-compaction-spike':
          return t('cost.finding.compaction.text', {
            cost: money(e.compactionCost),
            value: Number(e.value ?? 0).toFixed(1),
            threshold: String(e.threshold),
            tokens: tokens(e.shadowedTokenCount),
          })
        case 'expensive-subtree':
          return t('cost.finding.subtree.text', {
            share: percentText(e.value), cost: money(e.subtreeCost), session: money(e.sessionCost),
          })
        case 'tariff-attributable':
          return t('cost.finding.tariff.text', {
            share: percentText(e.value), delta: money(e.delta), total: money(e.total),
          })
        case 'pricing-gap':
          return t('cost.finding.gap.text', {
            share: percentText(e.value), steps: e.steps, tokens: tokens(e.unpricedTokens),
          })
        default:
          return t('cost.finding.unknown', { kind: String(finding.kind) })
      }
    }

    /**
     * The lines that explain one Finding: what its Indicator detects, the numbers that
     * cleared which threshold, the preset in force, and the sentence that confidence is
     * a ranking aid rather than a probability (I22).
     */
    function findingExplain(t, finding, options = {}) {
      const rows = [
        t(`cost.finding.detect.${finding.kind}`),
        findingText(t, finding, options),
      ]
      const preset = options.anomalies?.preset
      if (preset !== undefined && preset !== null) {
        rows.push(t('cost.finding.preset', { preset: t(`cost.finding.preset.${preset}`) }))
      }
      rows.push(t('cost.finding.ranking', {
        confidence: finding.confidence,
        severity: t(`cost.finding.severity.${finding.severity}`),
      }))
      return rows
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
     * @param options - `t`, `currency`, the session total, the peak intervals and
     * the Tariff projection the money is shown under.
     * @returns one string per line.
     */
    function tooltipLines(node, options = {}) {
      const { t = (key) => key, currency = 'USD', total = 0, intervals = [], projection = 'fact', findings = [], anomalies = null } = options
      const models = Object.keys(node.byModel ?? {}).join(', ')
      const head = t('cost.tip.turn', { turn: node.turn, step: node.step })
      const money = projectionOf(node, projection)?.cost ?? 0
      const lines = [
        models === '' ? head : `${head} · ${models}`,
        `${clock(node.tStart) ?? ''} · ${t(nodePhase(node, intervals))}`,
        bucketLine(node.buckets),
        `${costText(money, currency)} · ${t('cost.tip.share', { share: shareOf(money, total) })}`,
      ]
      // The `fact` figure never disappears behind a projection, the retry count is
      // the one thing the money deliberately drops, and an unpriced Step says so.
      if (projection !== 'fact') lines.push(`${t('cost.proj.fact')}: ${costText(node.cost ?? 0, currency)}`)
      if (node.unpriced === true) lines.push(t('cost.tip.unpriced'))
      if (node.retries > 0) lines.push(t('cost.inspector.retries', { count: node.retries }))
      // What the Indicators found on this Step, named where the reader is already
      // looking. The full explanation stays in the inspector and the findings list.
      for (const finding of findings.slice(0, 3)) {
        lines.push(`${FINDING_GLYPH[finding.kind] ?? '·'} ${t(`cost.finding.kind.${finding.kind}`)} · ${findingText(t, finding, { currency })}`)
      }
      if (findings.length > 0) {
        const ranking = t('cost.finding.ranking', {
          confidence: findings[0].confidence,
          severity: t(`cost.finding.severity.${findings[0].severity}`),
        })
        const preset = anomalies?.preset
        lines.push(preset === undefined || preset === null
          ? ranking
          : `${t('cost.finding.preset', { preset: t(`cost.finding.preset.${preset}`) })} · ${ranking}`)
      }
      return lines
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
     * The subagent subtree of one session, read only when asked.
     *
     * The panel never mixes its figures into the header: every number here belongs
     * to the child sessions, and the header stays the session's own total (D25).
     */
    /**
     * The one-click jump into a child session's own Cost view.
     *
     * A subagent is a session of its own, so the reader follows the money instead of
     * retyping an id; without an owner action the button is simply absent.
     */
    function SubagentOpen({ t, id, onOpen }) {
      if (typeof onOpen !== 'function' || typeof id !== 'string' || id === '') return null
      return h('button', {
        className: 'dshb_btn',
        key: 'open',
        title: t('cost.subagents.openHint'),
        onClick: () => onOpen(id),
      }, t('cost.subagents.open'))
    }

    function Subagents({ t, currency, groups, spawns, state, onLoad, onOpen }) {
      const head = h('div', { className: 'dshb_cost_note', key: 'title' }, [t('cost.subagents.title'), ' ', `(${spawns})`])
      const actions = []
      if (state.status === 'loading') {
        actions.push(h('span', { className: 'dshb_cost_note', key: 'loading' }, t('cost.subagents.loading')))
      } else if (state.status === 'idle') {
        actions.push(h('span', { className: 'dshb_cost_note', key: 'hint' }, t('cost.subagents.hint')))
        actions.push(h('button', {
          key: 'include',
          className: 'dshb_btn',
          onClick: () => { void onLoad(false) },
        }, t('cost.subagents.include')))
      } else if (state.status === 'error') {
        actions.push(h('span', { className: 'dshb_flag', key: 'failed' }, t('cost.subagents.failed', { error: state.error ?? '' })))
        actions.push(h('button', {
          key: 'retry',
          className: 'dshb_btn',
          onClick: () => { void onLoad(state.full) },
        }, t('cost.retry')))
      } else {
        // A zero here would claim the subtree cost nothing; the figure appears only
        // once something was actually read (D26).
        actions.push(h('span', { className: 'dshb_cost_sub', key: 'total' }, state.lines.length === 0
          ? t('cost.subagents.totalUnknown')
          : t('cost.subagents.total', { value: costText(state.total?.cost ?? 0, currency) })))
        actions.push(state.full
          ? h('span', { className: 'dshb_cost_note', key: 'full' }, t('cost.subagents.full'))
          : h('button', {
            key: 'full',
            className: 'dshb_btn',
            title: t('cost.subagents.fullHint'),
            onClick: () => { void onLoad(true) },
          }, t('cost.subagents.loadFull')))
        if (state.diagnostics.length > 0) {
          actions.push(h('span', { className: 'dshb_flag', key: 'diagnostics' }, t('cost.subagents.diagnostics', { count: state.diagnostics.length })))
        }
      }

      // A branch that could not be read is named, with the reason the Host gave:
      // "1 session could not be read" alone leaves the reader unable to tell which.
      const broken = state.status === 'ok'
        ? state.diagnostics.map((row) => h('div', { className: 'dshb_sub_row dshb_sub_broken', key: `broken-${row.id}` }, [
          h('span', { className: 'dshb_sub_label', key: 'label' }, row.id.slice(0, 8)),
          h('span', { className: 'dshb_sub_reason', key: 'reason' }, t(`cost.subagents.reason.${row.reason}`, { reason: row.reason })),
        ]))
        : []

      // The spawn list comes from the session's own catalog facts, so it is drawn
      // before anything is read: only the money waits for the explicit ask, and an
      // unread child says so instead of reading as free.
      const body = groups.flatMap((group) => [
        h('div', { className: 'dshb_sub_head', key: `${group.key}-head` }, [
          t('cost.tip.turn', { turn: group.turn, step: group.step }),
          ' ',
          // The head carries an aggregate, and nothing else: a group of one line would
          // repeat that line's own figure right above it, and an unread group has no
          // figure at all — its lines already say they were not read.
          group.loaded === 0 || group.lines.length < 2
            ? null
            : h('span', { className: 'dshb_sub_money', key: 'money' }, costText(group.cost, currency)),
        ]),
        ...group.lines.map((line) => h('div', {
          className: 'dshb_sub_row',
          key: `${group.key}-${line.id}`,
          style: { paddingLeft: `${line.depth * 12}px` },
        }, [
          h('span', { className: 'dshb_sub_label', key: 'label' }, `${line.label === '' || line.label === undefined ? line.id.slice(0, 8) : line.label} · ${line.mode}`),
          // Money and button share one right-aligned group, so the buttons line up in
          // a column instead of stepping in and out with the length of each figure.
          h('span', { className: 'dshb_sub_right', key: 'right' }, [
            h('span', { className: 'dshb_sub_money', key: 'money' }, line.loaded
              ? `${costText(line.cost, currency)} · ${t('cost.steps', { steps: line.steps })}`
              : t('cost.subagents.notLoaded')),
            h(SubagentOpen, { key: 'open', t, id: line.id, onOpen }),
          ]),
        ])),
      ])

      return h('div', { className: 'dshb_subagents dshb_cost_card' }, [head, ...actions, ...body, ...broken])
    }

    /**
     * The inspector of one Step.
     *
     * The projection holds usage, not messages, so the prompt that started the Step's
     * Turn is not part of it: the inspector says so and reads the session's words only
     * when the reader asks, with the explicit `Load older` action.
     */
    function CostInspector({ t, node, currency, total, projection = 'fact', peakIntervals, inspectCall, loadPrompt, subtree = null, onLoadSubtree = null, onOpenSubtree = null, findings = [], anomalies = null }) {
      const [prompt, setPrompt] = react.useState({ key: null, status: 'idle', error: null, text: null })
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

      // The prompt belongs to the Step it was read for: a new selection starts over
      // rather than showing the words of the Step before it.
      const promptKey = `${node.turn}.${node.step}`
      const shownPrompt = prompt.key === promptKey ? prompt : { key: promptKey, status: 'idle', text: null, error: null }
      const load = async () => {
        if (typeof loadPrompt !== 'function') return
        setPrompt({ key: promptKey, status: 'loading', text: null, error: null })
        try {
          const text = await loadPrompt(node)
          const answered = typeof text === 'string' ? text.trim() : ''
          setPrompt({ key: promptKey, status: answered === '' ? 'empty' : 'loaded', text: answered, error: null })
        } catch (error) {
          setPrompt({ key: promptKey, status: 'failed', text: null, error: error instanceof Error ? error.message : String(error) })
        }
      }

      // The token/cost table: one column per bucket, in and out first, and the
      // money the Step paid for each of them underneath its token count. The money
      // follows the selected Tariff projection, so the Σ row equals the figure the
      // chart and the header lead with.
      const rows = [
        { key: 'uncachedInput', label: t('cost.bucket.in') },
        { key: 'output', label: t('cost.bucket.out') },
        { key: 'cacheRead', label: t('cost.bucket.cacheRead') },
        { key: 'cacheWrite', label: t('cost.bucket.cacheWrite') },
      ]
      const buckets = node.buckets ?? {}
      const money = projectionOf(node, projection)
      const costs = money?.costByBucket ?? {}
      const stepCost = money?.cost ?? 0
      const totalTokens = (buckets.uncachedInput ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0)
      const digits = costColumnDigits([...rows.map((row) => costs[row.key] ?? 0), stepCost])
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
          line('total', t('cost.bucket.total'), totalTokens, stepCost),
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
          h('span', { key: 'sv' }, shareOf(stepCost, total)),
          projection === 'fact' ? null : h('span', { className: 'k', key: 'pk' }, t('cost.control.projection')),
          projection === 'fact' ? null : h('span', { key: 'pv' }, t(`cost.proj.${projection}`)),
        ]),
        table,
        flags.length === 0 ? null : h('div', { className: 'dshb_flag', key: 'flags' }, flags.join(' · ')),
        // What the Indicators make of this Step, with the numbers that cleared which
        // threshold and the preset they were detected under (I22).
        findings.length === 0 ? null : h('div', { className: 'dshb_finding_detail', key: 'findings' },
          findings.flatMap((finding) => [
            h('div', { className: 'dshb_finding_detailHead', key: `${finding.kind}-head` }, [
              h('span', { key: 'glyph' }, FINDING_GLYPH[finding.kind] ?? '·'),
              h('span', { key: 'kind' }, ` ${t(`cost.finding.kind.${finding.kind}`)}`),
              h('span', { className: 'dshb_cost_sub', key: 'conf' }, ` · ${t('cost.findings.confidence', {
                value: finding.confidence,
                severity: t(`cost.finding.severity.${finding.severity}`),
              })}`),
            ]),
            ...findingExplain(t, finding, { currency, anomalies }).map((line, index) => h('div', {
              className: 'dshb_cost_note',
              key: `${finding.kind}-line-${index}`,
            }, line)),
          ])),
        // The Turn's prompt comes before the calls: it is the context the calls
        // belong to, and the projection carries usage rather than messages — hence
        // the explicit "load older" action instead of hidden auto-loading.
        h('div', { className: 'dshb_cost_note', key: 'prompt-title' }, t('cost.inspector.prompt')),
        h('div', { className: 'dshb_cost_note', key: 'prompt' }, [
          h('span', {
            key: 'text',
            className: shownPrompt.status === 'loaded' ? 'dshb_cost_prompt' : undefined,
          }, shownPrompt.status === 'loaded'
            ? shownPrompt.text
            : shownPrompt.status === 'failed' ? t('cost.inspector.loadFailed') : t('cost.inspector.noPrompt')),
          shownPrompt.status === 'loading'
            ? h('span', { key: 'given', className: 'dshb_cost_note' }, t('cost.inspector.loading'))
            : shownPrompt.status === 'loaded' || shownPrompt.status === 'empty'
              ? null
              : h('button', {
                key: 'older',
                className: 'dshb_btn',
                disabled: typeof loadPrompt !== 'function',
                onClick: () => { void load() },
                style: { marginLeft: 8 },
              }, t('cost.inspector.loadOlder')),
        ]),
        h('div', { className: 'dshb_cost_note', key: 'calls-title' }, t('cost.inspector.calls')),
        calls.length === 0
          ? h('div', { className: 'dshb_cost_note', key: 'no-calls' }, t('cost.inspector.noCalls'))
          : h('div', { className: 'dshb_cost_kv', key: 'calls' }, calls.flatMap((call) => [
            h('span', { className: 'k', key: `${call.callId}-n` }, call.name),
            h('span', { className: 'dshb_cost_preview', key: `${call.callId}-p` }, call.preview),
          ])),
        // The Steps this one spawned: the subtree cost is attributed here, beside
        // the Step that caused it, and never added to the Step's own figure (D25).
        ...(Array.isArray(node.children) && node.children.length > 0 ? (() => {
          const own = subtreeOf(node, subtree?.lines ?? [])
          return [
            h('div', { className: 'dshb_cost_note', key: 'subagents-title' }, t('cost.subagents.step')),
            h('div', { className: 'dshb_cost_kv', key: 'subagents' }, own.lines.flatMap((line) => [
              h('span', { className: 'k', key: `${line.id}-n` }, `${line.label === '' ? line.id.slice(0, 8) : line.label} · ${line.mode}`),
              h('span', {
                key: `${line.id}-c`,
                className: 'dshb_kv_open',
                title: line.id,
              }, [
                h('span', { key: 'money' }, line.loaded ? costText(line.cost, currency) : t('cost.subagents.notLoaded')),
                h(SubagentOpen, { key: 'open', t, id: line.id, onOpen: onOpenSubtree }),
              ]),
            ])),
            own.loaded === 0 && typeof onLoadSubtree === 'function' && subtree?.status !== 'loading'
              ? h('button', {
                key: 'subagents-load',
                className: 'dshb_btn',
                onClick: () => { void onLoadSubtree(false) },
              }, t('cost.subagents.include'))
              : null,
            own.loaded > 0
              ? h('div', { className: 'dshb_cost_note', key: 'subagents-total' }, t('cost.subagents.stepTotal', { value: costText(own.cost, currency) }))
              : null,
          ]
        })() : []),
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
           * The prompt that started a Step's Turn, for the inspector's preview.
           *
           * The chart itself needs the projection, not the messages; this reads the
           * session's words and is only ever called from the explicit action.
           */
          loadPrompt: (node) => promptForNode(sessionId, node),
          /**
           * Follow a spawned subagent into its own Cost view.
           *
           * The child is another session, so this leaves the current view: the shell
           * opens the session and the Cost tab is activated once it is bound.
           */
          openSessionCost: (childId) => openSessionCost({
            workspace: ctx.get('uiWorkspace'),
            conversation: ctx.get('uiConversation'),
            storage: typeof localStorage === 'undefined' ? undefined : localStorage,
            sessionId: childId,
          }),
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
      costColumnDigits, costCell, indexTicks, projectionOf, Segmented, RateEntry, rateDraftOf,
      TopK, topRows, visibleSlice, sumBuckets, zoomWindow, panWindow, clampWindow, isFullWindow, turnSpans,
      arrowDelta, nextSelection, subtreeOf, stepGroups, Subagents, SubagentOpen, openSessionCost, preferCostView,
      costHistory, exportFileName, truncateText, EXPORT_DETAILS, CostExport, saveTextFile, readSeries, readText, promptForNode,
      rememberRecent, sessionPrompts, lastStep, subtreeReads, MAX_PROMPT_SESSIONS, MAX_STEP_SESSIONS,
      valueAxis, compactNumber, tickLabel, tooltipLines,
      Findings, findingsOf, overlayOf, overlayMemo, findingsAt, findingText, findingExplain, thresholdLines,
      findingPlace, findingRank, MAX_BADGES, FINDING_GLYPH, compactionRows, percentText,
    }
    return module.exports
  },
})
