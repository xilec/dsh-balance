# Tasks

## 1. Locale times and dates

- [x] 1.1 In `client/client.js`, rewrite `clock()` as
  `toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })` over `new Date(ts)`,
  keeping its `null` for a non-instant or non-positive input, and say in the JSDoc why those
  options and why no seconds
- [x] 1.2 Rewrite `dayLabel(key)` as `toLocaleDateString(undefined, { day: '2-digit',
  month: '2-digit' })` over a `Date` built from the key's own parts as *local* components, so a
  calendar day in the ledger's zone is not shifted west of Greenwich, and say so in the JSDoc
- [x] 1.3 Point the peak panel's two `formatRemaining(… ?? 0)` call sites and the Summary's at
  the new `remainingText()` helper from task 2.3, and leave the credits tab and the peak panel's
  `toLocaleTimeString` alone — they were already right
- [x] 1.4 In `test/client.test.js`, replace the `\d{2}:\d{2}` assertion on the tooltip line with
  an assertion against `toLocaleTimeString` for the same instant, and add a case pinning the Days
  table's date cell to `toLocaleDateString` for the same day key

## 2. Rendering and accessibility

- [x] 2.1 In `Readout`, set the pill's `aria-label` to the same `legend` the `title` shows, and
  delete `readout.aria` from both dictionaries
- [x] 2.2 Add `remainingText(ms)`: `—` for a nullish wait, `formatRemaining(ms)` otherwise, with
  the `'—'` glyph justified in the JSDoc; route the chip, `peakLines` and the Summary's
  next-change row through it so no call site writes `?? 0`
- [x] 2.3 Add a pure `panelOffset({ anchorLeft, width, viewportWidth, margin })` returning the
  pixel `left` a panel is drawn at, clamped into the window, and JSDoc the three numbers it needs
- [x] 2.4 Give the `Popover` a measuring effect that sets its `left` from `panelOffset` and
  re-measures on window `resize`; give the peak chip's panel the same treatment through a ref on
  its anchor
- [x] 2.5 In `test/client.test.js`, assert the pill's `aria-label` equals its `title` and both
  carry the legend; assert a payload with no `untilMs` renders `—` and not `0s`; assert
  `panelOffset` for a narrow window, a wide window and a panel wider than the window, and assert
  the rendered `dshb_popover` carries the clamped `left`

## 3. Dead code and the settings it left behind

- [x] 3.1 Delete `statusLevel` and its entry in `__internals`
- [x] 3.2 Relabel `settings.warning` / `settings.danger` in both dictionaries as reserved and add
  a `settings.reserved` note, rendered under the grid, saying that no surface colours the balance
  by the two thresholds
- [x] 3.3 Correct the two `warningThreshold` / `dangerThreshold` schema comments in
  `src/index.js`, which claim the chip turns amber and red
- [x] 3.4 Fold the Findings call sites of `percentText` into `shareOf(x, 1)`, delete
  `percentText` and its internals entry, and keep `(share ?? 0)` inside `shareOf`
- [x] 3.5 Drop the dead `?? {}` in `Settings`' draft initializer
- [x] 3.6 Fix the comment above the Cost view's grid: it says two columns and the rule below it
  is three
- [x] 3.7 In `test/client.test.js`, assert the Settings tab renders the reserved note and both
  reserved labels, and that `__internals` no longer exports `statusLevel` or `percentText`

## 4. Per-frame work

- [x] 4.1 Make `useNow(0)` open no interval, and pass `forNewSession`-conditional `0` from the
  peak chip so a chip that renders nothing keeps no clock
- [x] 4.2 Rewrite the Cost view's arrow-key effect to close over a ref holding `slice.nodes`,
  `selected` and `select`, registered once, with a JSDoc saying why no dependency array can be
  correct here
- [x] 4.3 In `CostView`, replace the outer `buildPlot` with the two figures the clip note needs —
  `clipThreshold` over the mapped values and whether any value exceeds it — and keep `buildPlot`
  for the chart
- [x] 4.4 Turn `overlayMemo` into a `Map` keyed on the same string, bounded to a named constant
  of entries with the oldest dropped; route the subtree reading's `overlayOf` call through it too
- [x] 4.5 Replace `Math.max(0, ...capped)` in `buildPlot` with a loop that stops at the first
  positive maximum
- [x] 4.6 In `test/client.test.js`: assert a chip that renders nothing arms no `setInterval`; assert
  the arrow-key listener count is stable across ten renders; assert the clip note's threshold and
  clipped flag are what the chart's plot says; assert two keys survive each other in the memo and
  that the map stays bounded; assert `buildPlot` over 130 000 nodes does not throw

## 5. The Findings row's selection

- [x] 5.1 In `overlayOf`, name the row's `at` as the visible position of `refs.from` when that
  Step is in range and the first visible referenced Step otherwise, with a JSDoc on the fallback
- [x] 5.2 In `test/client.test.js`, assert a row whose `refs.from` is visible selects it, a row
  whose `refs.from` is scrolled off selects the first referenced Step still in range and is marked
  partial, and a row with nothing in range is not listed

## 6. Gates

- [x] 6.1 `npm test` in the worktree: all green, no test count reduction
  — 336/336, nine more than the 327 on `origin/main`; nothing pre-existing was rewritten but the
  one tooltip assertion that pinned `\d{2}:\d{2}`, which asserted the bug this change removes
- [x] 6.2 The determinism proof: `npm test`; `node --test test/clock-shift.test.js`; five `TZ`
  values; six concurrent copies of the suite
  — all green at `UTC`, `America/Los_Angeles`, `Europe/Berlin`, `Asia/Kolkata`,
  `Pacific/Kiritimati` and under six concurrent copies; the day-key assertion is written against
  the platform's own formatting, so it is the same check in every zone
- [x] 6.3 `nix flake check` in the worktree
- [x] 6.4 knip + jscpd clean in a scratch copy with its own `node_modules`
- [x] 6.5 `openspec validate --all`: failed 0
