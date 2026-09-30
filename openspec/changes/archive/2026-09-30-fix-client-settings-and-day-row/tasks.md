# Tasks

## 1. Stop a poll from eating the Settings draft

- [x] 1.1 In `Settings` (`client/client.js`), replace the whole-draft `setDraft(settingsOf(...))`
  in the `useEffect` on `[state.payload]` with a per-field seed: keep a `touched` set, and copy a
  field into the draft only while that field is untouched; record a field in the set on its
  `onChange`, and clear the set after a successful `apply`, so the payload the write produced
  re-seeds everything
  — done: `touched` is a state object of the keys the reader has typed in, the effect walks
  `settingsOf()` and copies a field over only when that field is untouched, `onChange` marks the
  key, and `apply` clears the whole set on success so the post-write payload re-seeds the tab
- [x] 1.2 Test it in `test/client.test.js`: type a currency, drive two payload updates with a
  different `currencyPreference`, and assert the input still holds the typed value; then assert
  an untouched field followed the payload, and that a successful apply re-seeds the touched field
  from what the Host stored
  — done: `a poll does not replace what the reader is typing in the settings tab` types `EUR`,
  asserts it survives two polls carrying a different `clientPollIntervalMs`, asserts the untouched
  day zone follows a payload that changed it, and asserts the saved draft is `EUR`/the new zone
  afterwards; on the pre-fix `client.js` it fails on the first poll (`'USD'`, not `'EUR'`)

## 2. Re-arm the poller when the cadence changes

- [x] 2.1 In `createStore` (`client/client.js`), add a `reschedule` that clears the armed timer
  and then calls `schedule`, leaving `schedule`'s single-timer guard in place
  — done: `reschedule` returns early when there are no subscribers (nothing to poll for, and
  `subscribe`'s disposer is what drops the last timer), otherwise clears `timer` and calls
  `schedule`, which still refuses to arm a second one
- [x] 2.2 Call it from `saveSettings` after the write and its re-read, and from `setSessionId`
  after the session read, so a written cadence and a session switch both take effect at once;
  note in the code comment that an in-flight read is neither cancelled nor awaited
  — done: both call sites go through `reschedule`, and the JSDoc above it says that an in-flight
  read settles as usual and its own `schedule` finds the timer already armed
- [x] 2.3 Test it in `test/client.test.js` against a fresh `createStore()` with a controlled
  `setTimeout`: assert the first read arms the Host's cadence, that a `saveSettings` writing a
  different cadence re-arms with the new interval, and that exactly one timer is ever armed
  — done: `a written cadence and a session switch re-arm the poller, and only once` watches
  `setTimeout`/`clearTimeout`, and asserts `armed` is `[15000]`, then `[15000, 45000]` after the
  write, then one more arm after the session switch, with one `clearTimeout` per re-arm and none
  left after `stop()`; on the pre-fix `client.js` it fails on the re-arm assertion

## 3. Refuse a second edit while a day row is in flight

- [x] 3.1 In `DaysTable` (`client/client.js`), add an `inFlight` ref and a `begin`/`end` pair
  around the write; make `commit` return early when the row is already in flight; set
  `disabled` on the row's input from `busy`; route the reset control's own write through the same
  pair so a double click cannot post twice
  — done: `begin` claims the row in the ref and returns false for a second claim, `commit` starts
  with `if (!begin(row)) return`, the input carries `disabled: busy === row.key`, and the reset
  button's `onClick` opens with the same `if (!begin(row)) return`
- [x] 3.2 Test it in `test/client.test.js`: press `Enter` twice on one row and assert one
  override post, that the input is disabled while the write is outstanding, and that the reset
  control posts once for two presses
  — done: `a day row whose write is in flight is not written a second time` presses `Enter` twice
  from one render, asserts a single `{date, amount: 1.25}` post, that the input is `disabled` and
  that a blur afterwards writes nothing more, and that two clicks on reset post one removal; on
  the pre-fix `client.js` it fails with two corrections

## 4. Let `Escape` belong to the field

- [x] 4.1 Lift the target-tag test out of `arrowDelta` into a shared `editingTarget(event)`, and
  have `arrowDelta` call it so the Cost view's arrow behaviour is unchanged
  — done: `editingTarget` holds the tag test with the reasoning, `arrowDelta` calls it after the
  modifier check, and the export list gained the new name
- [x] 4.2 In `Readout`'s document-level `Escape` handler, skip the event when `editingTarget`
  says the reader is typing, so discarding a day-row edit does not close the panel
  — done: the handler is now `if (event.key === 'Escape' && !editingTarget(event)) setOpen(false)`
- [x] 4.3 Test it in `test/client.test.js`: dispatch `Escape` at a `day-row` input and at the
  panel, and assert the panel survives the first and closes on the second; assert
  `editingTarget` on each target kind and that `arrowDelta` still returns 0 for them
  — done: `Escape in a day row discards the edit without closing the panel` stands a document
  stub up, presses the key at `{tagName: 'INPUT'}` then at `{tagName: 'div'}` and asserts one
  dialog then none; the existing arrow test gained the `editingTarget` cases and keeps every
  `arrowDelta` assertion it had. On the pre-fix `client.js` the panel test fails at the first
  press (0 dialogs, not 1) and the arrow test fails on the missing `editingTarget`

## 5. Report a failed manual refresh

- [x] 5.1 In `Popover` (`client/client.js`), hold a refresh status, clear it at the start of each
  attempt, and set it to the error message when `store.forceRefresh()` rejects; render it as a
  `dshb_flag` line beside the refresh button, the way the export line reports its outcome
  — done: `refreshError` state, cleared in the click handler before the call and set in the
  rejection, rendered as a `dshb_flag` span between the button and the version line
- [x] 5.2 Add `common.refreshFailed` to the English and Russian tables with the same shape as
  `cost.export.failed`
  — done: `refresh failed: {error}` / `не удалось обновить: {error}`, and the locale test that
  compares the two key sets still passes
- [x] 5.3 Test it in `test/client.test.js`: make the refresh route answer with an error and assert
  the rendered footer carries the reason, and that a later attempt clears it
  — done: `a refused manual refresh says so in the footer, and the next attempt clears it` adds a
  `refuse` list to the fetch stub, presses the footer's button and asserts the reason is in the
  footer text, then re-presses it against a working stub and asserts nothing is left; on the
  pre-fix `client.js` the footer carries no reason at all

## 6. Verify

- [x] 6.1 `npm test` green, no reduction in the number of tests — 303 pass, 0 fail (298 before)
- [x] 6.2 Each new case fails against the pre-fix code (checked in a scratch copy, not in the
  worktree), for the reason the finding names — verified by putting `origin/main`'s
  `client/client.js` under the branch's tests in a scratch tree: six cases fail, one per finding
  plus the `editingTarget` assertions, each on its own assertion message
- [x] 6.3 Determinism: `npm test`; `node --test test/clock-shift.test.js`; five `TZ` values; six
  concurrent copies of the whole suite — 303/303 in every case, six concurrent copies all 303/303
- [x] 6.4 `nix flake check` in the worktree — all checks passed
- [x] 6.5 knip + jscpd clean in the scratch copy — knip silent, jscpd 0 clones
- [x] 6.6 `openspec validate --all` with zero failures — 7 passed, 0 failed
