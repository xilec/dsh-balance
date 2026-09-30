# Design

## Context

See `proposal.md` — Why. The facts that shape the approach:

- `buildLedger` (`src/history.js:265`) is a pure function: samples, overrides, a zone, `nowMs`
  and `days` in, a ledger out. It builds one row per day key for the last `days` keys
  (`recentDayKeys(todayKey, days)`), then reads the three window totals off the tail of that
  row array: `d1` is the last row, `w1` the last at most 7, `m1` **all of them**.
- `historyDays` is a documented panel setting (`src/index.js:70`, `Schema.number().min(3)
  .max(400).default(30)`) and is writable through the settings route, so the "length" of the
  month window is a number the reader chose. It is also the ledger's own retention: the rows
  simply do not exist beyond it.
- The row array is contiguous and ends at `todayKey`, so "the last `n` rows" and "the rows
  whose day key is inside the last `n` days" are the same set while `n <= days`. The two
  formulations part company only above `days`, which is exactly where the month figure goes
  wrong.
- `covered` came from `windowCovered(dayCount)`, which compared the first sample's day with
  `recentDayKeys(todayKey, dayCount)[0]`. For `m1` the count it was given was `days`, so the
  flag described the ledger rather than the window. It never asked whether the rows needed to
  express the window exist at all.
- The samples' first day is already a value the ledger has: `firstSampleMs`, and with it the
  index of that day in the row array. The measured span of a window is therefore arithmetic on
  the rows, not a second scan of the series.
- The panel reads `totals.*.amount` and `totals.*.covered` in three places (the readout line,
  the Summary cards, the Summary detail rows) and has no idea how long a window is: the copy
  says "7 days" and "30 days" in both locales. The readout's legend uses the same
  `tip.spend1w` / `tip.spend1m` keys.

## Goals / Non-Goals

**Goals:**

- One definition of a window's range, used by both `amount` and `covered`, derived from the day
  keys rather than from the row count.
- A `covered` that can only be true when the figure really is the whole window.
- A number in the payload that tells the browser half what the window measured, so the panel
  can label a short window without guessing.
- Byte-identical figures for every ledger that has 30 or more rows, in every zone.

**Non-Goals:**

- Not reporting `null` or a scaled estimate for a short window. There is no honest month total
  over three days of samples, and a figure the reader can compare with yesterday's is worth
  more than a gap in the panel.
- Changing what `historyDays` does. It still decides how many day rows are kept, which is what
  the Days tab and the settings field read. It simply stops deciding what "1m" means.
- Changing the row array, the `covered`-mutes-the-readout rule, the flags line, or the
  `d1`/`w1` windows, which were already right.
- Retro-fitting the `days` count into the stored state or into a migration.

## Decisions

**A window is a set of day keys, and `amount` sums the rows inside it.** `windowTotal(length)`
asks `recentDayKeys(todayKey, length)` for the window's first day and sums the rows from the
tail of the array, taking `min(length, rows.length)` of them. The alternative — filtering the
rows by membership in the key list — is the same set and costs a comparison per row, so it was
not worth the clarity; what makes the windows honest is that `length` is a constant of the
window and not a value read out of the array.

**`amount` of a short window is the sum of the rows that exist.** The three candidates were
`null` (a gap in the panel where the month usually is), scaling the partial sum (a guess), and
summing what there is. The last is the only one that claims nothing: the number is what the
ledger measured, and `covered` — which the readout already renders muted and the panel already
flags — is what says the month is not all of it. A reader who has three days of history sees
three days of spend, which is true, instead of an empty card.

**`covered` is `days === length`, and `days` counts what the samples measured.** The count is
`min(length, rows.length, measured)`, where `measured` is the number of days from the first
sample's day to today. This makes the two failure modes one number: a ledger truncated by
`historyDays` and a history that started late both shorten the count, neither can reach the
window length without covering all of it, and the flag can no longer disagree with the figure
it sits next to. Deriving `covered` from the count rather than computing it twice is the point:
the old bug was two questions asked separately (rows for the amount, samples for the flag).

**The measured span is derived from the row index, not from a date difference.** The first
sample's day key is looked up in the row array; its index from the end is the number of days
the samples span, and an index of `-1` (the first sample predates the oldest row) means the
samples span at least the whole ledger. No second pass over the series, and no timezone
arithmetic on day keys, so it cannot disagree with the rows the amount was summed from.

**The payload gains `days` per window rather than a `windows` map.** Three window objects with
one extra integer each is the smallest shape that answers the question; a map of lengths would
have been a second place to keep the same three constants in sync, and the client already reads
every window through `totals.<key>`. The browser half falls back to the window length when the
field is absent, so an older Host's payload still renders.

**The panel's labels read that count, and the copy loses its own numbers.** `card.week`,
`card.month`, `tip.spend1w` and `tip.spend1m` become `{days} days` (`{days} дней` in Russian,
matching the counted-noun style the existing copy already uses in `cost.finding.retry.step`),
and `tip.partial` becomes "partial: {days} of 30 days" so the flag names the shortfall. The
window length itself is no longer written into any label, so the copy cannot claim a span the
payload does not have.

**The window lengths are constants of the panel, and only the flag mentions 30.** The
`{days} of 30 days` phrase is the one place a number remains, and it is the *spec's* number
rather than the ledger's: the flag is about the month window, and the month is 30 days by
definition. Everything else is derived.

## Risks / Trade-offs

- [A `historyDays` above 30 now reports a smaller month figure than before] → That figure was
  a `historyDays`-day sum labelled "1m". The change is the point of this task, and it only
  differs where the old number was not a month. `historyDays` keeps its meaning as retention,
  so a reader who wants 400 days of rows still gets them, in the Days tab.
- [The Russian labels are `3 дней` where `3 дня` would be correct] → The copy already uses one
  genitive form for counted nouns (`{count} повторов`, `{count} ступеней`), so this follows the
  file's own convention rather than introducing a plural helper for four strings. Worth doing
  properly if more counted nouns arrive.
- [An old browser half reading a new payload shows the right numbers under a `historyDays`-flavoured
  label] → It shows the corrected figures; only the label is the old hard-coded one, and it was
  already hard-coded. The reverse — a new browser half on an old Host — is handled by the
  fallback to the window length.
- [The differential check could pass vacuously] → It runs the same samples through several
  `historyDays` values in three zones and asserts equality with the pre-change output for
  every `historyDays <= 30`, plus the documented difference above it, so a change in the
  arithmetic of a right figure fails the test rather than passing it.
- [jscpd may flag the two `min` computations in `windowTotal`] → They are one expression over
  three numbers, and the gate is re-run before the PR.

## Migration Plan

None. The change is arithmetic inside a pure function plus one integer per window in the read
payload. Nothing is stored, and `historyDays` keeps its meaning.

## Open Questions

None.
