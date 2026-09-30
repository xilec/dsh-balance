# Design

## Context

See `proposal.md` — Why.

The facts that shape the approach:

- The store (`createStore`, `client/client.js:1016`) keeps one `pollMs` and one `timer`. The
  interval is written in two places — `read()` from the payload's `sampling.clientPollIntervalMs`
  and `saveSettings` from the write's answer — and `schedule()` reads whichever value is current
  at the moment it arms.
- `schedule()` opens with `if (timer !== null) return`. That guard is what keeps the poller at
  one timer, and it is also why a cadence that changed after the timer was armed is ignored
  until that timer fires: the next `schedule()` in the chain is a no-op, so the new interval is
  never used.
- The two paths that change the cadence, `saveSettings` and `setSessionId`, both end in
  `read().then(schedule, schedule)`. Neither of those arms a fresh timer, because one is
  already armed from before.
- `state.payload` is a fresh object on every successful read — `snapshot` is replaced in `read()`,
  and `useSyncExternalStore` compares by identity. So the `useEffect` in `Settings` keyed on
  `[state.payload]` runs on every poll, not only when a setting actually changed.
- `DaysTable` has one `busy` string, and the input's `disabled` prop is not set at all — only
  the reset button reads `busy`. `commit` sets `busy` and awaits, so between the first `Enter`
  and the re-render the second `Enter` runs against the same closure, where `busy` is still the
  old value.
- `arrowDelta` already answers "is this event from a field the reader is typing in?" by testing
  the target's tag name, and returns 0 for those events. The `Escape` handler in `Readout` is the
  only other document-level key handler that should respect that, and it does not.
- The export line (`CostExport`, `client/client.js:3670`) already has the pattern the refresh
  needs: a status it renders as a `dshb_flag` when a write fails, with the error interpolated
  into a copy key.

## Goals / Non-Goals

**Goals:**

- A typed value survives any number of polls until it is submitted or the tab is reopened.
- A written cadence, and a session switch, take effect at the moment they are known — not when
  the previous timer happens to fire.
- Still exactly one timer, before and after the change.
- A day row's write is posted once per press of `Enter`, whatever the reader does in the
  milliseconds before the re-render.
- `Escape` reaches exactly one of the two things that claim it: the field, or the panel.

**Non-Goals:**

- Changing what the poller does with its own failed reads. The spec requires the last good
  payload to stay on screen and no zero to appear; `read()` still swallows its failure into
  `snapshot.error`. The footer's refresh is a different thing — it is a request the reader asked
  for and got nothing back from.
- Re-arming the timer from inside `read()`. The payload's cadence arriving with a poll is already
  applied at the next arm; the bug is only that a change made outside a poll never reaches the
  next arm.
- Per-field validation, dirty indicators, or a cancel button. The spec puts the check at save
  and the reader has Apply.
- Remembering the draft across tab switches. The tab is remounted when it is chosen again, and
  re-seeding on open is the documented behaviour.
- Touching the `RateEntry` editor or the Cost view's own copy of the same settings.

## Decisions

**The draft is seeded per field, keyed on what the reader touched.** `Settings` keeps a `touched`
set; the effect on `[state.payload]` walks `settingsOf()` and copies a field into the draft only
when that field is untouched. A successful `apply` clears the set, so the payload the write
produced re-seeds every field — including one the Host rounded or rejected differently, which is
what "the Host is the authority" means.

The alternative was to reseed the draft only when the tab is opened and after a save. That is
simpler, but it makes an untouched field that the Host changed underneath the reader stale for
the whole time the tab stays open — a day zone set from another window would keep showing the
old one. Per-field seeding keeps "prefilled from the payload" true for every field the reader is
not editing, which is what the requirement actually asks for, and it needs one extra piece of
state rather than a change of when the effect runs.

**The re-arm is a `reschedule`, not a change to `schedule`.** `reschedule` clears the armed timer
if there is one and then calls `schedule()`. `schedule` keeps its guard, so a `reschedule` while
a read is in flight — the timer already fired, `timer` is null — cannot arm a second one: the
in-flight read's own `.then(schedule, schedule)` arms the one timer afterwards, and the
`reschedule`'s arm happened first and is the one that stands.

Concretely, an in-flight read when the cadence changes is **not** cancelled and **not** awaited:
`saveSettings` writes, updates `pollMs`, re-reads (which joins an in-flight read through the
`inflight` guard rather than starting a second), and then reschedules. The read that was already
running finishes and reports as usual; the next poll is armed on the new interval from the
moment the write is known. A reader who lowered the cadence to the 2-second floor gets a poll
every 2 seconds from then on, not after the old hour runs out.

**The session switch reschedules through the same call.** `setSessionId` reads and then
reschedules rather than scheduling. The two are the same shape — a read whose answer may carry a
different cadence, followed by a timer that must reflect it — so one helper covers both, and a
second helper with subtly different semantics is one more thing to keep in step.

**The day-row guard is a ref, not the rendered state.** `busy` drives what is on screen;
`inFlight` is a ref holding the row key whose write has not settled, and `commit` returns
immediately when the row is already in it. The ref is what makes the second `Enter` a no-op: a
handler captured in the render *before* `setBusy` closed over `busy === ''`, so a state check
would let it through. The input also gets `disabled`, so the browser refuses the keystroke as
well — the ref is the invariant, `disabled` is the affordance, and either alone is incomplete.

The reset control's own path goes through the same `begin`/`end` pair. It already disabled itself
from `busy`, but that had the same closure problem: two clicks on a stale handler, or a click on
the reset while a commit on the same row is in flight, posted two requests.

**`editingTarget` is lifted out of `arrowDelta`.** The arrow guard already has the exact test the
`Escape` handler needs; hoisting it into one function means the two cannot drift, and the
Cost view's arrow behaviour keeps exactly the semantics it had.

**The refresh reports into a `dshb_flag` line beside the button.** Same shape as the export's
failure line and same place in the DOM, so the reader learns where to look for it. One new copy
key per locale, `common.refreshFailed`, worded like `cost.export.failed`. The status is cleared
at the start of each attempt and set only on rejection, so a later success does not leave a stale
error on screen.

## Risks / Trade-offs

- [A touched field never learns what the Host stored until Apply] → That is the point: the
  reader's value is what gets submitted, and Apply clears the set so the Host's answer becomes
  the seed. The one case where a reader sees a stale value for longer is a *failed* write, where
  the message says what was rejected and the field still holds what they typed.
- [Clearing `touched` on success races the re-read that follows the write] → `apply` awaits
  `store.saveSettings`, which itself awaits the re-read, so the payload in the effect is the
  one the write produced. If the re-read fails, `read()` keeps the previous payload, the effect
  seeds from that, and the previous value comes back — the same value the failed write left, so
  nothing is lost that the reader had.
- [`reschedule` arms a timer the old chain then also tries to arm] → One timer, because
  `schedule` still guards on `timer !== null`. The test asserts the arm count as well as the
  interval, so a double-arm fails rather than passes quietly.
- [Disabling the input mid-write could look like a hang] → The reset button already behaved this
  way, and the write is a single POST. The row's input greys exactly as long as the request is
  outstanding.
- [jscpd flags the begin/end pair] → Two three-line functions, not a duplicated block; re-run
  before the PR.

## Migration Plan

None. Nothing is stored or persisted by these paths: the draft and the busy flags are component
state, the timer is in-page. Reverting the commits restores the old behaviour with no residue.

## Open Questions

None.
