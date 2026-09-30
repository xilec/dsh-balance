# Design

No new decision. Each fix makes the code match a claim the repository already
makes elsewhere, so there is nothing to choose between.

**The notes order.** Three comments in `scripts/release-notes.mjs` say the sections
are "oldest first"; `git log` is newest-first, so `archiveOrder` indexes the newest
change at 0 and `buildDraft` sorts ascending. The comments and the design note D5
("the order is the commit that added the archive directory, read from the whole
history") agree on *which* commit orders a change and disagree on nothing else, so
the direction is the only open question — and "oldest first" is the one three
places already state and the one a first release reads correctly. One sort
comparator changes.

Reading it the other way would mean rewriting three comments to say "newest first",
which is defensible for an incremental release (the reader wants the recent work
first) and wrong for this one: the draft covers the whole history, and the change
that opens it is a one-paragraph amendment to a spec sentence.

**The state document.** `plugin-settings` has required the four fields since the
composition row became the source of truth, and `writeStateOnce` writes exactly
them. The `store.js` header predates that and mentions a field no code has read
since the first commit. Comment only.

**The anchor invariant.** `amend-anchor-span-rationale` amended the requirement to
say a base is only ever added to by a drop between two instants of the same ledger
day, because that is what the code enforces. The comment in `history.js` still
carries the pre-amendment justification, which is false for an anchor on the same
day minutes before the day's first sample — the exact case that change wrote a
scenario for. Comment only; the arithmetic is untouched and its tests are green.

**Tomorrow in the peak panel.** `dayLabel` already builds a `Date` from a day key's
own parts rather than parsing it, and that is the shape `peakLines` needs here too.
The alternative — asking the Host for tomorrow's key — would put a request in a
render path for a word. The fix is the same local-midnight construction the rest of
the file uses, applied to `now` instead of to a key.

## Risks

None of the four changes behaviour the suite pins: the notes order has no test (the
order test feeds `renderNotes` its own array), the other three are comments except
`peakLines`, which the suite exercises through `textOf` on a payload with a change
outside both day words.
