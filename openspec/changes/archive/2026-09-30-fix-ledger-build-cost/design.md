# Design

## Context

See `proposal.md` — Why. The code that shapes this change is three functions in one pure
module, `src/history.js`: a calendar-field helper (`zoneFields`), the ledger fold
(`buildLedger`) and the retention thinning (`compactSamples`). The module has no imports, no
clock and no IO, and must stay that way — the cache introduced below is a `Map` of derived
values, not IO and not a clock.

The numbers that shaped the decisions below were measured on this tree with a 5-minute sample
cadence (`tmp/` scratch scripts, not committed):

| samples | `dayZone: 'local'` | `dayZone: 'Europe/Berlin'` |
|---|---|---|
| 5 000 | 11 ms | 421 ms |
| 35 000 (the default `keepDays` of 120) | 32 ms | 2 811 ms |
| 200 000 (`MAX_SAMPLES`) | 140 ms | 14 892 ms |

and, with 30 anchored overrides over 200 000 samples: 749 ms on `local`, over two minutes on
`Europe/Berlin` (killed by a 120 s timeout).

## Goals / Non-Goals

**Goals:**

- One calendar lookup per sample per ledger build, and no `Intl` construction inside a build.
- Thinning buckets that are the ledger's own clock hours.
- Numbers that do not move: the same ledger, byte for byte, except where the thinning bucket was
  demonstrably wrong.

**Non-Goals:**

- Caching the built ledger between calls. The poll is 15 s and the build is linear after this
  change; a memo with its own invalidation would be a stateful module for no gain.
- Rewriting the retention model (per-day rather than per-hour buckets, a cap on the log size).
- Changing what the panel sends or what the payload carries.

## Decisions

- **D1 — One cached formatter per zone, read with `format()` instead of `formatToParts()`.**
  A module-level `Map` holds one `Intl.DateTimeFormat` per zone name; an unknown zone is
  cached as `null` so the fallback to `local` is not re-attempted per sample. The map is capped
  (16 entries) and dropped wholesale when the cap is reached: `dayZone` is one panel setting
  with a handful of realistic values, so the cap is never reached in practice, and clearing is
  cheaper to reason about than an eviction policy — a caller that passes many zone names pays one
  rebuild per zone after each clear, and cannot grow the map.

  With the formatter cached, `formatToParts` costs 366 ms per 200 000 samples (it allocates an
  array and five part objects per call) while `format` costs 157 ms, so the fields are sliced out
  of the formatted string. Slicing depends on the pattern, so each formatter is *probed* once
  with two known instants: the probe confirms the shape (`YYYY-MM-DD` at the front, two digits
  at the end, and a date that is one of the three plausible local dates of the probe instant)
  and yields the index the hour starts at. A runtime that formats the probe differently falls
  back to `formatToParts` for that zone, so the fast path is an optimisation rather than a
  contract. `hourCycle: 'h23'` is passed explicitly because `hour12: false` alone yields `24`
  for midnight on some ICU versions.

  Alternatives rejected: memoizing the day key across samples (a day boundary inside a UTC hour
  is only detectable by formatting, and getting it wrong silently merges two days); a `Map` from
  zone to the *last* result with an instant window (the window has to be derived from the zone's
  offset, which is exactly the DST case that breaks it); and a small hand-written offset table
  (a second source of truth for zone rules, and `Intl` is already the authority).

- **D2 — The calendar day of every sample is derived once and reused.** `buildLedger` computes
  `dayKeys[i] = zoneFields(series[i].t, zone).dateKey` in one pass and then folds the intervals
  by index, instead of asking for the day of both ends of every interval. The credit list and the
  manual bases read the same keys. This is what turns the measured 2 lookups per interval into 1
  per sample, and it is also the reason the by-day index below costs nothing extra.

  The fold indexes `intervals[i - 1]` for the pair `(series[i - 1], series[i])`, which holds
  because `movements` emits exactly one interval per consecutive pair, in order; the coupling is
  commented at the loop.

- **D3 — The manual bases read a per-day index, built on first use.** `addedSince` filtered
  the whole series (and the whole credit list) once per override row, which is O(days × N). A
  lazily built `Map` from day key to that day's samples and credits replaces it, so a read is
  O(N + days) whatever the number of overrides. It is built lazily because a ledger without
  anchored overrides never asks, and the index would otherwise be paid on every poll. The result
  is unchanged: samples and credits stay ascending, the newest sample of a day is still its last
  element, and the credit sum still adds the same terms in the same order.

- **D4 — The thinning bucket is the ledger's zone.** `compactSamples` takes the zone and buckets
  by `YYYY-MM-DD` plus the local hour, which is what "the last sample of each clock hour" has to
  mean for the day rows to keep a sample from every hour of the day. It has to be the ledger's
  zone and not the host's or UTC's: a UTC hour straddles local midnight wherever the offset is
  not a whole number of hours, and the last sample kept before the boundary then falls outside
  the day it belongs to.

  `readSamplesCompacting` therefore takes the zone, and `load()` reads the state document before
  it compacts the log, so a `dayZone` the reader stored in the panel is the one the buckets are
  cut on. Compaction is irreversible, and the panel preference is the zone the reader actually
  sees the ledger in — falling back to the configured zone would silently re-thin a log the
  reader had already thinned by hand.

## Risks / Trade-offs

- **The `format()` fast path depends on an ICU pattern** → each formatter is probed once per
  zone and the zone falls back to `formatToParts` when the probe fails, so a pattern change
  costs speed and not correctness.
- **A wrong hour in the bucket key** → `hourCycle: 'h23'` pins midnight to `00`; even a `24`
  would only merge two hour buckets, never a day boundary.
- **The formatter cache keeps entries for zones that are no longer configured** → the cap
  (D1) bounds it, and an entry is a single formatter object.
- **Thinning moves** → existing logs in a fractional-offset zone will be re-thinned on the next
  load, which keeps *more* samples than before at the boundary, never fewer.
- **A pure module now holds mutable state** → it is derived state, keyed by an input, with no
  IO, no clock and no effect on the values returned; a module reload starts empty, which is the
  cold-start path.

## Migration Plan

One commit on the branch; the numbers a ledger reports do not change, so nothing has to be
migrated. Rollback is reverting the commit — the sample log re-thins to UTC hours on the next
load, which is the previous behaviour.

## Open Questions

None. A per-day retention bucket (instead of per-hour) would shrink the log by another 24× and
is worth a change of its own, but it trades away the ability to attribute an interval to the
hour it happened in, so it is out of scope here.
