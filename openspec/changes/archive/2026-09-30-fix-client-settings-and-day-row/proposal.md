# Proposal

## Why

Five things in the browser half do not do what `openspec/specs/balance-panel/spec.md` requires
of them, and three of them lose the reader’s work:

- Every poll replaces the whole Settings draft, so a half-typed currency or cadence is gone
  before Apply: a value that cannot survive one tick cannot be the value that gets submitted.
- A written polling cadence does not re-arm the pending timer, so the change waits for the old one
  to fire: a lag at the default cadence, an hour from an old cadence of an hour, nothing on
  screen. The session-switch path has the same hole.
- A day row whose write is in flight keeps its input live, so pressing `Enter` twice posts two
  corrections for the same day.
- The panel’s document-level `Escape` handler also catches the day-row inputs, so discarding an
  edit closes the whole panel too. Nothing reconciles the two requirements.
- A manual refresh swallows its rejection, so pressing it during an outage looks like pressing a
  dead button.

## What Changes

- The Settings draft is seeded only for the fields the reader has not touched. A poll may
  refresh the untouched fields from the new payload; a field being edited keeps the reader's
  value. A successful save clears the touched set, so the draft is re-seeded from the payload
  the write produced.
- The store grows a `reschedule` that drops the armed timer and arms a fresh one on the current
  cadence. `saveSettings` calls it after the write and the re-read, and `setSessionId` calls it
  after the session read, so both a written cadence and a session switch take effect at once.
  A read already in flight is not cancelled: it settles into the schedule that follows it, and
  the `schedule` guard means there is still exactly one timer.
- The day row's input is disabled while its write is in flight, and `commit` refuses a row that
  is already being written. The guard is a ref, not the rendered `busy` state, so a second
  `Enter` on a handler captured before the re-render is refused too. The reset control's own
  path goes through the same begin/end pair.
- The panel's `Escape` handler skips an event whose target is a field the reader is typing in.
  The tag test is lifted out of `arrowDelta` into a shared `editingTarget`, which both handlers
  use.
- The footer's refresh reports a failed request with the reason, in a `dshb_flag` line beside
  the button, and clears it on the next attempt. One new key per locale,
  `common.refreshFailed`.
- Tests: five cases in `test/client.test.js` — a draft that survives two payload updates and
  re-seeds after a save, a store whose timer is re-armed on the written cadence and on the
  session switch, two `Enter` presses on one row producing one override post, an `Escape` in a
  day row leaving the panel open, and a refused refresh putting the reason on screen.
- Delta spec: `balance-panel` gets the two behaviours the spec did not state — that the footer
  reports a failed refresh, and that `Escape` in a day row leaves the panel open. The other
  three are conformance fixes against requirements that already read the way the fixed code
  behaves.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-panel`: "The panel and its tabs" gains the failed-refresh report; "The Days tab"
  gains the reconciliation between discarding an edit and closing the panel.

## Impact

- Modified: `client/client.js` — the store's `schedule`/`saveSettings`/`setSessionId`
  (`reschedule`), `Settings`' draft seeding, `DaysTable`'s busy guard, `Readout`'s `Escape`
  handler, `Popover`'s refresh, the new `editingTarget` helper, and `common.refreshFailed` in
  both locale tables.
- Modified: `test/client.test.js` — the five cases above, and `stubFetch` grows the two
  capabilities they need (a Host that remembers a settings write, and a path that refuses).
- No new dependency, no HTTP or payload change, no Host-side change, and no stored rate or
  override is migrated.
- Left alone on purpose: the draft is still seeded from the payload on mount, so a field the
  reader never touched follows the Host; and `read()` keeps swallowing its own failures, because
  the spec requires the last good payload to stay on screen and the poller's own error is not
  what the footer reports.
