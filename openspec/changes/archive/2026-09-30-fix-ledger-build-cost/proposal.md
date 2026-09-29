# Proposal

## Why

Building the day ledger constructs two `Intl.DateTimeFormat` objects per spend interval, so a
ledger over the default 120-day retention (about 35 000 samples) took 2.8 s with an IANA
`dayZone` and 15 s at the sample cap — a synchronous stall of the whole dsh process, repeated
by the 15 s browser poll and by every refresh, override and settings write. `dayZone` is a
runtime-writable panel setting, so one click in the panel turns a fast plugin into a wedged
shell, and the `local` zone only looks fast because it bypasses `Intl` entirely. The same module
buckets the hourly thinning by UTC hour, which destroys the day boundary in every zone with a
fractional UTC offset, and re-filters the whole series for each manual override, so a read with
30 overrides over 200 000 samples took 749 ms on `local` and more than two minutes with an IANA
zone.

## What Changes

- Cache one `Intl.DateTimeFormat` per zone name in `src/history.js` instead of constructing one
  per call, and read the calendar fields from its output. The `local` fast path is untouched.
- Derive the calendar day of every sample once per `buildLedger` and reuse it for the interval
  fold and the manual bases, so a rebuild performs one calendar lookup per sample rather than two
  per interval plus one per override row.
- Bucket the hourly thinning of old samples in the ledger's `dayZone` instead of in UTC, so the
  last sample of a day survives wherever the UTC offset is not a whole number of hours
  (`Asia/Kolkata` +05:30, `Asia/Kathmandu` +05:45, `Australia/Adelaide` +09:30).
- Pass the configured zone down to the compaction on load so the thinning bucket and the ledger
  share one zone.
- Index the samples and credits of each day once per `buildLedger` and read a manual base from
  that index, replacing the per-row filter over the whole series.
- Cover the three findings with tests: a ledger build over tens of thousands of samples in an
  IANA zone, a thinning bucket across local midnight in a fractional-offset zone, and the
  anchored-base behaviour that the index must preserve.

## Capabilities

### New Capabilities

<!-- Capabilities being introduced. -->

- none

### Modified Capabilities

- `balance-tracking`: the sample log's hourly thinning is now bucketed in the configured
  `dayZone` rather than in UTC hours, so the requirement names the zone its "clock hour" means.

## Impact

- `src/history.js` — the calendar-field helper, `buildLedger` and `compactSamples`.
- `src/store.js`, `src/index.js` — the zone travels into `readSamplesCompacting`, and the state
  document is read before the log is compacted so a stored panel preference is honoured.
- `test/history.test.js` — three new cases; the existing cases stay as they are.
- No new dependency, no change to the payload shape, and no change to the numbers a ledger
  reports (only the retention thinning buckets move, and only where they were wrong).
