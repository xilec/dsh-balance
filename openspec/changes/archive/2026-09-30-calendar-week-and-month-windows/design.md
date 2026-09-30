# Design

## Context

See `proposal.md` — Why. The facts that shape the approach:

- `buildLedger` (`src/history.js`) is pure: samples, overrides, a zone, `nowMs` and `days`
  in, a ledger out. It builds one row per day key for the last `days` keys
  (`recentDayKeys(todayKey, days)`), so the rows are contiguous and end at `todayKey`.
- The three windows were a constant, `WINDOW_DAYS = { d1: 1, w1: 7, m1: 30 }`, and
  `windowTotal(length)` summed `min(length, rows.length)` rows off the tail of the array.
  Because the rows are contiguous and end at today, "the last `n` rows" and "the rows whose
  key is inside the last `n` days" are the same set — which is why a length was enough until
  now.
- A day key is a fixed-width `YYYY-MM-DD` string produced by `dayKeyOf(ts, zone)`, and the
  ledger's zone has already decided which calendar day every sample belongs to. Every
  consumer (the panel, the peak chip, the export) builds in that same zone, so a window's
  first day is a question about a *day key*, not about an instant: no timezone conversion,
  and therefore no DST edge and no half-hour offset to reason about in the arithmetic.
- `sampledDays` was already the number of days from the first sample's day to today, derived
  from that day's index in the row array. `covered` was `days === length` and `days` was
  `min(length, rows.length, sampledDays)`.
- The panel kept its own `WINDOW_DAYS = { w1: 7, m1: 30 }` and a `windowDays(totals, length)`
  helper whose fallback length existed for a Host older than the `days` field. A calendar
  window has no length the client could know, so that fallback has no honest value any more.

## Goals / Non-Goals

**Goals:**

- One definition of a window's range, used by `amount`, `days` and `covered` alike, derived
  from day keys and expressed as a key range.
- A `covered` that can only be true when the data really reaches the window's first day, on
  any day of the week and any day of the month.
- A payload that lets the browser half name the window and its span without knowing anything
  about the calendar.
- Figures that do not move for the days the old and the new range share.

**Non-Goals:**

- Not offering a configurable first day of the week. Monday is the decision; a Sunday-start
  week is the alternative a reader may have to import, and the spec and the copy now say
  Monday so nobody has to guess.
- Not changing the day rows, the interval arithmetic, the override anchor, the `d1` window or
  the `covered`-mutes-the-readout rule.
- Not reporting `null` or a scaled figure for a window the ledger cannot fill.
- Not retrofitting the new `measured` field into the stored state; it is derived.
- Not touching the Settings and Days tabs of the panel, which another branch edits.

## Decisions

**A window is the pair (first day key, today), and the length follows from it.**
`weekStartKey(dayKey)` walks back at most six days until the weekday is Monday;
`monthStartKey(dayKey)` is the same string with the day replaced by `01`; `daySpan(from, to)`
counts the days between two keys. All three are pure: they read a `YYYY-MM-DD` key as UTC
midnight — never the host clock, never `new Date()` on a bare string — and format with
`toISOString().slice(0, 10)`, which is the construction `recentDayKeys` already uses. The
Monday rule is stated in the JSDoc of `weekStartKey` and in the spec, because a Sunday-start
week is the first alternative a reader will propose.

**The window table holds derivations, not lengths.** `WINDOW_STARTS = { d1, w1, m1 }` maps
each window to a function of `todayKey`, and the length is `daySpan(startKey, todayKey)` — the
calendar days from the first day through today, both included. A table of lengths cannot
express "the week so far", and making the length derived means the code, the panel, the tests
and the spec can never disagree about how long a window is: there is one number in the module
and it is computed.

**`amount` still sums rows, and the row range is index arithmetic.** The rows are contiguous
and end at `todayKey`, so the first row inside a window is `max(0, rows.length - length)`: no
key comparison per row, and the same three lines as before. A window longer than the ledger (a
February month on a 3-row ledger) starts before the oldest row, so every row is inside it and
the flag below says so.

**`days` is the window's length; `measured` is what the samples fill.** `days` answers "how
long is this window", which is what a reader looking at "so far this week" on a Wednesday wants
to know, and it is the number the browser half renders. `measured` is the old `days` —
`min(length, rows.length, sampledDays)` — and it answers "how much of it do the samples really
cover", which is what the partial flag has to name. `covered` stays `measured === days`, so the
flag still cannot describe a different range than the figure beside it, and the invariant that
made the previous bug impossible is unchanged.

**The panel names the window, and the count is an optional suffix.** `tip.spend1w` /
`tip.spend1m` become "So far this week" / "So far this month" with no number in the string, and
one new `window.days` string ("{days} days") is appended with a `·` when the payload reports a
span. The old `WINDOW_DAYS` fallback is deleted: an old Host sends no `days`, and the honest
rendering of a window whose length the browser half cannot know is the window's name and no
count. The Summary cards label the anchors outright ("week from Monday", "month from the 1st")
and carry the count as the card hint, which is what the hint line is for.

**The partial flag moves from the month to both windows, and names both numbers.** It reads
"{window}: {measured} of {days} days measured" with the window's own label, so `historyDays: 3`
on a Thursday produces "So far this week: 3 of 4 days measured" rather than a claim about a
fixed 30. Two windows can be short at once, and the flags line already joins several with `·`.

**`d1` is untouched, and the rows are untouched, so the money cannot move for the shared days.**
A window is still `sum(rows)` over the same row values; only the selection of rows changes.
`test/history.test.js` pins the row values a pre-change build produced for a 45-day fixture in
three zones, so a change in the arithmetic of a row fails the test, and asserts each window's
amount as the sum of the rows inside the window range, computed in the test from the row values
and their keys rather than from the length.

## Risks / Trade-offs

- [`w1` is a one-day window on a Monday] → Correct for "so far this week", and visible: a Monday
  morning shows the week's figure equal to today's. The old rolling figure (7 days) is gone by
  design; the copy and the PR say so.
- [`days` changes meaning in the payload, so a stale browser half mislabels] → The figures it
  shows are the new, correct ones and it mutes the same windows; only the count beside them is
  read with the old meaning. A refresh of either half fixes it, and the panel and the host ship
  together.
- [A reader who reads "this week" as Sunday-start] → Documented as Monday in the spec, in the
  panel's card labels ("week from Monday") and in the JSDoc. A locale where Monday is not the
  first day is a settings question, not a correctness one.
- [`measured` duplicates arithmetic the client could do] → The client cannot: it does not know
  the window's first day, and giving it that would put calendar arithmetic in the browser half.
  One integer per window is cheaper than a second implementation of the same rule.
- [The Russian `tip.partial` reads "измерено 3 из 4 дн."] → Same counted-noun form the file
  already uses; no plural helper is introduced for four strings.
- [A day key from a zone whose calendar skips a day (a zone that moved its date line) would leave
  the row array non-contiguous] → Not reachable in the IANA database for any zone the panel
  accepts, and it was equally unreachable before: the rows already come from `recentDayKeys`,
  which is the definition the module has always used.

## Migration Plan

None. The change is calendar arithmetic inside a pure function plus one integer per window in
the read payload. Nothing is stored; `historyDays` keeps its meaning as retention.

## Open Questions

None.
