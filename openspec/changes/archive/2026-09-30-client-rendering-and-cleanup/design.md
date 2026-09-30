# Design

## Context

The facts that shape the approach, all measured on `client/client.js` at `47d46f0`:

- `clock(ts)` (`:913`) and `dayLabel(key)` (`:931`) are the only two places the panel builds
  a time or a date by hand. `clock` has seven call sites (`:1582`, `:1591`, `:3570`,
  `:3571`, `:3809`, `:4273`, `:4543`, `:4782`, `:4783`); `dayLabel` has one (`:1679`).
- The locale machinery the file already uses is three calls:
  `toLocaleDateString(undefined, { weekday: 'short' })` at `:1394`,
  `toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })` at `:1407`, and
  a bare `toLocaleString()` for credits at `:1740`.
- `dayLabel` receives a day *key* — `YYYY-MM-DD` in the ledger's own `dayZone`, not an
  instant. `new Date('2026-09-18')` parses that as UTC midnight, which in any negative offset
  is the previous local day, and the table would show the 17th for the 18th. The parts have
  to be handed to the `Date` constructor as local components.
- The peak panel's options are `{ hour: '2-digit', minute: '2-digit' }`. They render
  `05:07 PM` under `en-US` and `17:07` under `ru`/`en-GB`, which is what the two call sites
  that already use them show. Adopting the same options in `clock()` means one clock in the
  file rather than two, and the peak row stops being the only locale-aware one.
- The chart axis (`:4273`) prints `clock(tick.at)` for five ticks, and the tooltip (`:4543`)
  prints one per hover. A weekday name or a seconds field would be a visible change on both
  for no reader benefit; a third option would only matter to a locale that puts the meridiem
  first, which `hour: '2-digit'` already accommodates.
- The Day column is a `dd.mm` today and the surrounding table is two columns wide. A day and
  a month in the browser's order and separators is the same width as the string it replaces
  in every locale the file ships copy for, and it is what `window.days`'s "N days" style
  already reads like.
- The popover is `position: absolute` inside `.dshb_anchor`, with `left: 0` from the
  stylesheet and `width: min(560px, 92vw)`. The chip's panel is the same shape at
  `width: max-content` with `max-width: min(440px, 88vw)`. Both already have a ref in reach
  (`panelRef` in `Popover`; the chip's anchor is the one it renders), and the file already
  measures elements in an effect for the panel's pinned height.
- The `Readout`'s accessible name and its tooltip are the same `legend` string, computed once
  at `:1277`. Only the `aria-label` prefixes it with `readout.aria`, a key that exists in
  both dictionaries solely for that prefix.
- `formatRemaining(peak.untilMs ?? 0)` at `:1582` is the only place a `?? 0` reaches it.
  The file's missing-figure placeholder is `'—'`, used at `:1351` for the same value on the
  chip, at `:892` in `duration`, and in `money`.
- `statusLevel` is exported at `:4960` and referenced nowhere else. `warningThreshold` and
  `dangerThreshold` are read by `settingsOf` (`:1045`), written by the tab (`:1821`, `:1822`),
  posted through `apply` (`:1796`), validated by the Host (`src/index.js:187`) and carried in
  `balance.thresholds` (`src/index.js:1042`). The README already says they are "stored and
  relayed, but no surface colours the balance by them".
- The Settings labels are `settings.warning` = "Amber below" and `settings.danger` = "Red
  below" — the exact claim `statusLevel` was the dead remnant of.
- `useNow(intervalMs)` (`:1220`) is used by the chip only. The bail-out at `:1347` needs
  `local`, which needs `nowMs`; the `forNewSession` half of the condition does not.
- The arrow-key effect at `:3512` closes over `slice.nodes`, `selected` and `select`, all of
  which change on every pan frame — so a dependency array cannot be made correct without
  re-registering per frame. A ref holding the same three values can.
- `buildPlot` is called at `:3661` with no `width`/`height` (the 720×240 defaults) and at
  `:4101` with the measured size. The outer call exists for two fields: `threshold` and
  whether any point is clipped. Both are `clipThreshold(values)` and a comparison against
  `values` — the same O(n) map, but no decimation, no point objects and no digest.
- `overlayMemo` is one module-level `{ key, value }`. The Cost view builds one key from the
  session id, the payload sequence, the preset, the fallback rates, the axis, the window and
  the finding count, so two bound views of two sessions hold two different keys and the
  second render of the first evicts the first's answer. A `Map` keyed the same way fixes it;
  a component-local cache would need the same key built in the component and would not help
  the subtree reading, which calls `overlayOf` directly at `:3607`.
- `Math.max(0, ...capped)` spreads `capped`, one argument per plotted value. V8's limit is
  around 125 000 arguments; `historyDays` is capped at 400 for the *ledger*, but a session
  series is not capped at all, and the chart plots every node it is given.
- `refs.from` is the first node index of a Finding's range and `at` is an index into the
  *visible slice*. `overlayOf` fills `seen` by walking `from … to` in order, so `seen[0]` is
  the first visible referenced Step, which is `refs.from` whenever `refs.from` is itself
  visible. The two branches are therefore the same code path today; what is missing is that
  neither the code nor the spec says what happens when `refs.from` is off screen.

## Goals / Non-Goals

**Goals:**

- One clock and one date formatter in the file, both in the browser's locale, both as
  compact as what they replace.
- The pill's accessible name to be the string a sighted reader reads on hover.
- A missing figure to render as the placeholder the rest of the file uses, never as `0s`.
- Both anchored panels to stay inside the viewport, on mount and after a resize.
- One share helper, one truth about the reserved thresholds, no dead exports, no comments
  that contradict the code under them.
- Four O(n)-per-render costs removed and a test that proves each one is gone.

**Non-Goals:**

- Not colouring anything by the two thresholds. That is a feature: it would need a colour
  vocabulary, a decision about which surfaces show it, and a spec change to *Money, time and
  copy*. The two settings stay stored, editable and relayed, and the tab says so.
- Not dropping the two thresholds from the Settings tab. The Host validates them, the README
  documents them and the spec says the tab offers them; removing a working input is a
  different change with its own migration question.
- Not changing any stored state, payload shape or HTTP route.
- Not memoising `buildPlot` itself. It depends on the measured width, which the outer
  component does not have; the fix is to stop needing it there.
- Not re-touching the Settings draft-survives-polls behaviour or the per-row in-flight claim.
  Both are recent and both stay.

## Decisions

**`clock()` is `toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })`.**
Three option sets were candidates: `{ hour: 'numeric', minute: '2-digit' }`,
`{ hour: '2-digit', minute: '2-digit' }` and the default full time. The first drops the
leading zero in the 24-hour locales, which makes the chart's five axis ticks ragged; the
third prints seconds, which change every frame the tooltip is open. The chosen set is the one
`peakLines` already uses at `:1407`, so the peak row and the rest of the file agree, and
`en-US`'s meridiem comes along for free without a special case.

**`dayLabel()` is `toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })` over
a locally-built `Date`.** The key is a calendar day in the ledger's zone, not an instant, so
`new Date(key)` would shift it a day west of Greenwich; the parts go to the constructor as
local components instead. The year is left out: the ledger is a rolling window of at most
400 rows, the oldest of which is the only one that could need it, and the panel already puts
"so far this month" next to it. A numeric `month` would be locale-defying; `2-digit` is what
the file's `window.days` and its credits list already read like.

**The `aria-label` is the legend, and `readout.aria` is deleted from both dictionaries.**
The spec asks for the same string, and the prefix is the only difference. Leaving a key in
two dictionaries that nothing reads is how `readout.aria` got there.

**`remainingText(ms)` renders `'—'` for a nullish wait.** Not a zero, not `0s`, and not a
guard at the call site: three call sites already disagree about the same value (`:1351`
checks for null, `:1408` writes `?? 0`, `:1582` writes `?? 0`), so the rule belongs in one
helper. `'—'` is the file's own missing-figure glyph, used by `duration` and by `money`.

**Both panels get their `left` from one pure `panelOffset()` and one measuring effect.** The
alternative — CSS `max-width: 100vw` plus a transform — cannot know where the anchor is. A
second alternative, measuring in a `ResizeObserver` on the anchor, is more machinery than a
window `resize` listener for a value that only moves when the window does. The helper is
pure and takes the three numbers it needs (anchor left, panel width, viewport width) so the
test can assert the geometry the way the file's other geometry tests do, with no DOM.

**`statusLevel` is deleted and the thresholds are marked reserved in the copy.** Deleting
the function leaves the tab offering two inputs that nothing reads, which is the review's
own complaint about the `src/index.js` comment. Wiring the function back up is the other
honest option and was rejected: no requirement asks a surface to colour the balance, the
README already documents the opposite, and the peak chip's colour is the tariff phase by
design — a balance colour would put two meanings on one chip. So the tab keeps both fields,
their labels stop promising a colour (`"Warning below (reserved)"`), a note says no surface
colours the balance by them yet, and the Host's two comments are corrected to the same
sentence the README uses.

**`shareOf(value, total)` is the only share helper.** The two differ in their argument shape
and in one edge: `percentText(undefined)` rendered `0%` because it defaulted the value to
zero, while `shareOf(1, 0)` renders `0%` because the total is zero. Folding the Findings
call sites into `shareOf(x, 1)` keeps the zero-total guard and the `(share ?? 0)` default in
one place, so `percentText` goes and `0%` still means "nothing to divide by".

**The chip's clock is gated, not moved.** The bail-out needs `local`, which needs `nowMs`, so
the `if` cannot move above the hook. `useNow(0)` is the gate: the effect opens no interval
and the value stays at mount time, which is what a component that renders nothing needs. The
store subscription stays where it is — it is one shared `useSyncExternalStore` whose cost is
a `Set` membership, not a timer, and moving it above the bail-out would mean not reading the
payload a visible chip needs.

**The arrow-key listener is registered once and reads a ref.** A dependency array over
`slice.nodes`/`selected`/`select` would re-register on every pan frame, which is the thing
being fixed. The ref is written on every render and read only inside the event handler, so
the handler is fresh and the registration is not.

**The outer component asks `clipThreshold()` for the two fields it needs.** It builds no
points, no bars, no digest and no `xOf`/`yOf` closures; it maps the values once, clips once
and compares once. `buildPlot` keeps its own call for the chart, which needs the measured
width, and the note renders the same `threshold` and the same "is anything clipped" answer it
renders today.

**`overlayMemo` is a `Map` bounded to a small number of entries, keyed on the same string.**
Keying a `Map` fixes the eviction between two bound views, which is the bug. A `Map` with no
bound would be a leak keyed by a string that contains a session id and a window fraction, so
it drops its oldest entry past a fixed count. Moving the cache into the component was
rejected for the reason above: the subtree reading at `:3607` calls `overlayOf` outside the
chart's component tree, and it is the same computation on the same nodes.

**`Math.max(0, ...capped)` becomes a loop.** A `reduce` would read as a fold over an array
that is already a fold's result; a `for` loop over `capped` with an early exit at the first
positive maximum is the same three lines and cannot overflow the argument list.

**`at` is derived from `refs.from`, falling back to the first visible referenced Step.**
Reading the loop again, `seen[0]` is already `refs.from` whenever `refs.from` is visible, so
this is a naming change plus a spec scenario rather than a behaviour change — and saying so
is the point. The fallback is not a guess: a Finding whose whole range sits left of the
window is not listed at all (`:2189`), so a listed row always has at least one visible
referenced Step to fall back to. The spec now says both, so the next reader does not have to
re-derive it from the loop.

## Risks / Trade-offs

- `clock()` returning a locale string means a test that asserts `\d{2}:\d{2}` on a tooltip
  line fails. One such assertion exists (`:1609`); it is updated to assert the shape the
  locale produces rather than a fixed string, because a test that pins `17:07` is a test that
  breaks on a machine whose locale is `en-US`.
- `dayLabel()` now depends on the ambient locale, so the Days table's rendered text changes
  per machine. The assertion compares against `toLocaleDateString` for the same key rather
  than a literal, which is the only form of that assertion that survives `TZ` and `LANG`.
- Clamping moves a panel that would have hung off the edge into the window, which is the
  intended change; on a wide window `panelOffset` returns `0` and the stylesheet's `left: 0`
  stands, so nothing moves that does not have to.
- Marking the thresholds reserved changes two labels and adds a note in two dictionaries. A
  reader who set a threshold to get a colour gets told, in the tab, that there is no colour —
  which is what the README has said all along.
- The `Map` in `overlayMemo` is module state like the slot it replaces. It is bounded, and
  the bound is a named constant, so the page-lifetime cost is a fixed number of overlay
  objects rather than one that grows with panning.
