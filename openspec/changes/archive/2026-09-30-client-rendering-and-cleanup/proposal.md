# Proposal

## Why

A review of `client/client.js` — the whole browser half, 4976 lines in one file — found
fifteen items in three classes. Only one of them is a bug a reader would call a bug; the
rest are a spec the code does not keep, code nothing calls, and per-frame work no reader
can see.

**The spec the code does not keep.** `openspec/specs/balance-panel/spec.md` says under
*Money, time and copy*: "Times and dates MUST use the browser's locale". Two helpers break
it. `clock()` (`client/client.js:913`) builds `HH:MM` from `getHours()` and is the only
clock in the top list, the chart axis, the tooltip, the inspector and the peak row, so an
`en-US` reader sees 24-hour times on a screen that formats its credits tab and its peak
panel in the locale. `dayLabel()` (`:931`) builds `dd.mm` by hand and is the Days table's
date column. The same requirement says the readout's "accessible name MUST be the same
legend the tooltip shows" — the pill renders `` `${t('readout.aria')}: ${legend}` ``, so a
screen reader announces a string no sighted reader can ever see. The Summary's next-change
row renders `formatRemaining(peak.untilMs ?? 0)`, which prints a literal `0s` for a payload
that carries no countdown — the spec's "MUST render a missing figure as a placeholder
rather than a zero", with the placeholder the rest of the file already uses. And the panel
and the below-chip panel are anchored with a hard-coded `left: 0`, so on a narrow window
the panel hangs off the right edge next to the very pill it belongs to; the spec says the
panel opens above the composer line and says nothing about the window it must stay inside.

**Code nothing calls.** `statusLevel()` (`:936`) is dead: no call site, no test, and it
colours nothing. Its two inputs are alive, though — the Host stores `warningThreshold` and
`dangerThreshold` and the Settings tab writes them — so the panel offers two controls whose
labels promise a colour that no surface produces, and `src/index.js:87` says in a comment
that the chip "turns amber" below one of them, which contradicts both the README and the
code. `percentText()` (`:4419`) and `shareOf()` (`:4519`) are the same function called with
different arguments, and `settingsOf(state.payload) ?? {}` (`:1747`) guards against a
nullish that `settingsOf` can never return. The comment above the Cost view's grid
(`:222`) says "Two content columns and no more" directly above a three-column rule.

**Per-frame work.** The floating chip calls `useNow(1000)` and subscribes to the store
*before* the `if (isFreshSession !== forNewSession) return null` bail-out (`:1330`, `:1347`),
so a chip that renders nothing ticks a one-second interval for the life of the session. The
Cost view's arrow-key effect (`:3512`) has no dependency array, so it removes and re-adds a
`document` keydown listener on every render — and a pan re-renders at frame rate.
`buildPlot()` is computed twice per render for one plot (`:3661` and `:4101`), two O(n) maps
and two decimations. `overlayMemo` (`:2227`) is one module-level slot, so two bound Cost
views evict each other every render and the filter recomputes per frame. And
`Math.max(0, ...capped)` (`:2449`) spreads an unbounded array and throws past roughly 125 000
elements.

One item is a spec that was already kept: a Findings row selects `row.at`, the first
*visible* referenced Step, while `openspec/specs/cost-anomaly-indicators/spec.md` says
activating a row SHALL select the Step it *starts at*. Reading the code closely, the two
agree — the loop that fills `at` starts at `refs.from` — so the code states a rule it does
not happen to break, and the spec does not say what happens when that Step is off screen.

## What Changes

- **Locale.** `clock()` becomes a `toLocaleTimeString` call and `dayLabel()` a
  `toLocaleDateString` call over a local-time `Date` built from the key's own parts, so a
  calendar day is formatted for the browser's locale without a UTC parse shifting it. The
  options are the ones the peak panel already uses at `:1407` — `hour`/`minute` as 2-digit
  numbers and nothing else — because a chart axis and a tooltip are places where a third
  field and a long month name cost more than they say.
- **The accessible name is the legend.** The pill's `aria-label` is the legend the tooltip
  shows, and the now-unreferenced `readout.aria` string leaves both dictionaries.
- **A missing countdown is a dash.** `remainingText()` renders `—` for a nullish wait, and
  the chip, the peak panel and the Summary row all go through it.
- **The panel stays in the window.** One pure `panelOffset()` and one measuring effect give
  both anchored panels a `left` in pixels clamped to the viewport, re-measured on resize.
- **`statusLevel` is deleted and the two thresholds are marked reserved.** The Settings tab
  keeps offering both — the Host stores and validates them, and the spec says the tab offers
  them — but their labels and a new note say plainly that no surface colours the balance by
  them yet. `src/index.js`'s two comments are corrected to match.
- **Two share helpers become one.** `shareOf(value, total)` is the only one, and the
  Findings call sites pass a total of 1.
- **The dead `?? {}` and the wrong comment go.**
- **The per-frame work goes.** The chip's clock is gated on a boolean, the arrow-key
  listener is registered once and reads the selection through a ref, the outer component
  asks for the two clip figures instead of building a second plot, `overlayMemo` becomes a
  bounded `Map` keyed on the same key (and the subtree reading stops recomputing its own
  overlay un-memoised), and the spread becomes a loop.
- **A Findings row names the Step it starts at.** `at` is derived from `refs.from`
  explicitly, with the first visible referenced Step as the stated fallback, and the spec
  gains the scenario that says what happens when neither is on screen.

## Capabilities

### Modified Capabilities

- `balance-panel`: the Settings tab marks the two balance thresholds as reserved, and a new
  requirement says an anchored panel is kept inside the viewport.
- `cost-anomaly-indicators`: the Findings list says what a row selects when the Step the
  Finding starts at is outside the visible range.

Nothing else in either capability changes: the locale, the accessible name and the missing
countdown are requirements the panel already states and the code did not keep, so they are
conformance fixes and not spec changes.

## Impact

- `client/client.js`: the helpers named above, the panel/chip measurement, the two
  dictionaries, and the internals list.
- `src/index.js`: two schema comments that contradict the README.
- `test/client.test.js`: a new test per behavioural item; the existing suite is untouched
  apart from the tooltip assertion that hard-coded a 24-hour clock and the two dictionaries'
  dropped key.
- No new dependency, no payload change, no HTTP change, no stored state.
