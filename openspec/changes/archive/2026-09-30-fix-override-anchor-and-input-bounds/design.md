# Design

## Context

See `proposal.md` — Why. Three of the four findings are in the two files the Host half is made
of: `src/index.js` (the routes, the settings surface, the sampler and its cache) and
`src/history.js` (the pure module that turns samples into the ledger). The fourth is a shape
question inside the same pure module.

The constraint that runs through all of it: **no figure the ledger produces today may change**.
The ledger is the only thing standing between a reader and a wrong number, and every day row,
window total and credit is a difference of balances. Hardening the inputs is therefore done by
*rejecting* or *not anchoring*, never by re-deriving a number differently. The one place where
an existing figure does change is called out in D3 and is the correction the spec has always
asked for.

Two things the pure module may not do stay true: it takes "now" and the samples from the caller
and reads no clock, and it keeps no state between calls.

## Goals / Non-Goals

**Goals:**

- A correction can only name a day the ledger could still show, and the corrections in the state
  document are bounded.
- A stored zone is always a zone the ledger can use, in every path that can set one.
- The anchor of a base is the balance of the instant it names, and nothing is added to a base
  whose anchor the ledger cannot measure from.
- The calendar helpers hand each caller the one field it reads.

**Non-Goals:**

- Pruning the state document on load. A load must not rewrite the reader's stored figures, and
  a document edited by hand is theirs; the bound is on what a write adds.
- Changing the `{ amount, at, balance }` shape of a stored override. The anchor's *instant* is
  what was missing, and it is `at`; a second field would mean a second thing to migrate and a
  second source of truth for the window the arithmetic measures over.
- Bounding the day by one of the two numbers rather than the wider of them, and
  throwing away a stored correction when the reader lowers the row count. The window is a
  storage bound, so it has to cover every day the reader could be shown *and* every day the
  samples could still answer for.
- Rejecting a write outright when the corrections are full. The reader correcting *today* is the
  one write that must always land, so the oldest go, not the new one.

## Decisions

- **D1 — The day window is the wider of the ledger rows and the retention, plus one day
  of forward slack, compared as strings.** A day the panel offers has to be correctable, and a
  day the log still covers has to stay correctable for when the reader widens the ledger: the
  bound is `max(historyDays, keepDays)` days back, which is neither of the two alone (retention
  alone would refuse a row at `historyDays: 400, keepDays: 120`; the row count alone would throw
  a correction away the moment the reader lowers the count). The far end is the ledger's
  *tomorrow*, not the host's: the day boundary is the configured zone, which can be a full day
  ahead of the host's clock (a reader at +14 asking a Host at −12), and the panel sends the
  ledger's own day keys. Both bounds are produced by `dayKeyOf`, the same function the ledger
  uses, and compared with `<=`/`>=` because `YYYY-MM-DD` is fixed-width and zero-padded, so the
  string order *is* the day order — no date arithmetic and no set of up to 3650 strings per
  write.

  A removal skips the window check: it can only shrink the document, and the reader clearing a
  correction they once made for an old day is a legitimate request whatever the retention is
  now.

- **D2 — The corrections are capped at 400, and the cap is enforced on the write.** 400 is
  `historyDays`' own schema maximum: the ledger never shows more rows than that, so a correction
  older than the newest 400 days is a figure no row can carry, and dropping it loses nothing the
  reader could have seen. Sorting the keys and keeping the newest 400 is a few lines and needs
  no eviction policy. The load does not prune, deliberately: the state document is the reader's
  record, and a start that silently dropped 60 000 entries would be a different behaviour from a
  start that keeps them.

- **D3 — The anchor's instant is the instant its balance was read, and no instant is recorded
  for a balance that was never read.** The entry already carries `at`; what was wrong is that it
  named the write while `balance` named the last poll. Setting `at` to `cache.fetchedAt` makes
  the pair mean one thing — the balance *of that instant* — which is also the instant the
  balance the reader was looking at was read, so the figure they typed and the figure the
  arithmetic starts from are the same one. This is the one behaviour change: with `at` on the
  write side, `at` is later than the newest sample in every normal case, `addedSince` refused to
  add, and every correction made through the route was frozen — the "corrected day keeps
  filling" scenario could not happen at all.

  A failed poll keeps the last good balance and leaves `fetchedAt` where the last success was,
  and the entry then names *that* instant rather than the moment of the write. The base is
  therefore "the reader's figure as of the reading they were looking at", and the added part is
  the account's own drop from that reading to the newest sample — measured, not guessed, however
  old the reading is. A wall-clock staleness gate was written first and dropped: a reading an
  hour old is not a wrong anchor, the panel showed the reader that same stale reading, and
  refusing to anchor would freeze precisely the correction a reader is most likely to make
  (right after the plugin has been down) in exchange for nothing. What an old anchor *can*
  break is the day attribution, and that is D4's job, not a wall clock's.

  An override written before any successful poll has no balance, and now no instant either: the
  entry is the amount alone, which the ledger has always read as frozen.

- **D4 — An anchor is measured only from inside the day's own span.** The added part is the
  drop from the anchor balance to the newest sample of the same day, so the window is
  `[anchor, newest]` and it only measures one day when both of its ends are inside that day:

  | anchor position | added | why |
  |---|---|---|
  | at or after the day's first sample, before its last | the drop plus the credits after it | the window is a slice of one day — what the formula is for |
  | exactly the day's last sample | 0 | the drop is zero and no credit can be later: the base is final |
  | after the day's last sample | 0 | nothing later to measure (already the rule) |
  | before the day's first sample | 0 | the window reaches back over midnight, so it carries the previous day's spend |

  The last row is the new one, and it is what makes a stale anchor safe rather than merely
  recorded: an anchor from yesterday evening, corrected into today, sits before today's first
  sample and is refused, where the old code would have added yesterday evening's drop to today's
  row. The cost is that a correction made in the first minutes of a day, in a zone ahead of the
  sample log's day, is no longer additive — which is the honest answer, because the balance at
  that instant says nothing about a day whose first sample is later.

  The comparison is against the day's *own* samples, not against the series as a whole: the
  question is whether the window crosses a day boundary, and a sample from another day is not
  part of the question. A day's samples are already indexed, so both ends cost nothing. The
  invariant this leaves is worth stating on its own: **a base is only ever added to by a drop
  between two instants of the same ledger day.** The anchor is either a sample instant or — when
  a poll read an unchanged balance and recorded no sample — an instant whose balance equals the
  last sample's, so the drop is exact either way.

- **D5 — One zone predicate, used by all four paths that can set or report a zone.** `Intl`
  throwing on an unknown name is the only test available, and `requestZone` already performed it
  for the read route's `zone` query. It becomes a predicate, `isUsableZone`, and the settings
  check, the stored-preference restore and the composition row all go through it — the settings
  route and the load already share `MUTABLE_SETTINGS.dayZone`, so only the row needs a new call
  (it normalises an unusable row value to `local` and the payload then names the zone the ledger
  reads in, which is what makes the payload honest rather than merely non-crashing). The
  alternative, accepting the write and reporting the zone in use, was rejected: the settings
  requirement already says an invalid value rejects the whole request, and a silently coerced
  setting is the failure the finding is about.

- **D6 — The calendar lookup is split per caller, not per field.** `zoneFields` built a
  `{ dateKey, hour }` pair; the ledger wanted one field, the thinning pass wanted both, and the
  `formatToParts` slow path walked the parts array for an hour nobody had asked for. `zoneFields`
  becomes module-private and the two callers each take the field they use: `dayKeyOf` (already
  exported) for the day, and the thinning bucket assembled inside `compactSamples`. No exported
  name disappears, `dayKeyOf` still returns a bare `YYYY-MM-DD` string, and no caller can now
  read a field the module does not produce. `minute` was never in the shape.

## Data / control flow

The override write, after this change:

```
POST {date, amount}
  date not YYYY-MM-DD                       → 400 "date must be YYYY-MM-DD"
  amount null/empty/absent                  → delete the key, persist, 200   (any well-formed date)
  amount negative or not a number           → 400 "amount must be a non-negative number or null"
  date outside [keepDays back, tomorrow]    → 400 "date must be a day the history can hold"
  otherwise:
    anchor = cache.balances[…]              (null when the Host has never read one)
    store  { amount, at: cache.fetchedAt, balance }  when there is an anchor
           { amount }                        otherwise — frozen at the reader's figure
    keep the newest 400 keys, the one just written among them, persist,
    200 with the bounded document
```

## Risks / Trade-offs

- **A stored correction older than `keepDays` is now unreachable.** It was already invisible
  (no row covers it) and still is; what changes is that the reader can no longer *write* one
  after raising `keepDays` only... no: raising `keepDays` widens the window, so the direction is
  right. Lowering `keepDays` below a stored correction's day makes that correction
  unreachable, which is the truth about the samples behind it.
- **The panel's `overrideAt` for a correction written after a failed poll is the old reading's
  instant, not the moment of the edit.** That is the honest value — it is the instant the figure
  belongs to — and the payload already marks the balance as stale next to it. A second field for
  the wall-clock moment of the edit was rejected as a migration for a value nothing reads.
- **A correction made in the first minutes of a day, in a zone ahead of the sample log's day, is
  frozen rather than additive** (D4). The alternative — adding a window that starts on the
  previous day — invents or loses a day's spend, which is what the rule exists to prevent.
- **Two `Intl` constructions at start-up** (one for the row's zone, one later for a stored one)
  replace an unbounded set of them: an unusable stored name is now ignored at the point it is
  read, instead of being accepted, persisted and re-tested on every start.
