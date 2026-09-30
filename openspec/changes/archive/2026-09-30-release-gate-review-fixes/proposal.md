# Release gate review: four sentences the epic left contradicting the tree

## Why

A final review of the whole repository before the 0.2.0 release found four places
where a comment, a JSDoc or a helper no longer says what the code does. Each is one
line, each is proved by reading the tree rather than by a failing test, and each
would mislead the next reader — which is the failure mode this project's own
history keeps paying for.

1. **`scripts/release-notes.mjs` documents its sections as "oldest first" and emits
   them newest first.** `git log` walks history backwards, so `archiveOrder` gives
   index 0 to the most recently archived change and `buildDraft` sorts ascending on
   it. A draft for the first release therefore opens with the newest one-line spec
   amendment and closes with the feature the release is actually about. Three places
   say "oldest first" — the `renderNotes` shape comment, the `archivesInRange`
   comment and the `archiveOrder` comment — and all three are false.

2. **`src/store.js` says `state.json` holds "the account currency the ledger is read
   in".** Nothing reads a currency from that document. It carries the day
   overrides, the client heartbeat, the stored preferences and the update time,
   which is what `plugin-settings` has required since the composition row became
   the source of truth. The sentence has been wrong since the first commit.

3. **`src/history.js`'s `addedSince` comment says the window is `[anchor, newest
   sample of the day]` and that an anchor after the day's last sample "has nothing
   left to measure".** Both are right, but the comment above it says "the previous
   day's spend, which the reader's own figure for this day cannot absorb", which is
   the justification the `amend-anchor-span-rationale` change amended away: the
   reason the anchor is bounded is that a base is a measurement taken from the day's
   first sample onward, and it holds for an anchor minutes before that first sample
   on the same day too.

4. **`client/client.js` derives "tomorrow" as `now + 24h`.** Across a
   daylight-saving transition that is not tomorrow: in `Europe/Berlin` at
   2026-03-29 00:30Z the reader is told tomorrow is the 30th when it is the 29th,
   and at 2026-10-25 the same line names today. The peak panel then says "today"
   where it means "tomorrow" for one hour twice a year.

## What Changes

- `scripts/release-notes.mjs`: order the sections oldest first, which is what three
  comments already claim and what a first release wants to read as. One line in
  `buildDraft`, and the three comments keep their claim.
- `src/store.js`: the layout comment names what `state.json` actually carries.
- `src/history.js`: `addedSince`'s comment states the invariant the code enforces
  (a drop between two instants of the same ledger day), matching the requirement
  `amend-anchor-span-rationale` amended.
- `client/client.js`: `peakLines` takes tomorrow's day from the calendar rather than
  from a 24-hour offset, so the peak panel's day word is right across a
  daylight-saving transition.

Nothing else. No spec requirement changes: `plugin-settings` already describes the
state document correctly, `balance-tracking` already states the anchor invariant in
its amended form, and no requirement mentions the notes order or the peak panel's
day word.
