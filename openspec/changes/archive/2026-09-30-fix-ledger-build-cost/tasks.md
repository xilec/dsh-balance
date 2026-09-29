# Tasks

## 1. Cache the zone formatters

- [x] 1.1 Replace the per-call `new Intl.DateTimeFormat(...)` in `zoneFields` with a capped
  module-level cache of one formatter per zone (an unknown zone cached as `null`), read the
  fields from `format()` after a one-time shape probe, and keep the `local` fast path and the
  fallback to it; verify the existing `dayKeyOf` and zone cases in `test/history.test.js` stay
  green and the day key is unchanged for `Asia/Shanghai`, `UTC` and `local`
- [x] 1.2 Add a `test/history.test.js` case that builds a ledger over tens of thousands of
  samples in an IANA zone and asserts it stays inside a budget measured at roughly 8x the
  measured cost, with a comment naming what the number protects against; verify the case fails
  against the pre-change code (2.8 s over 35 000 samples) and passes after it

## 2. Read the calendar day of each sample once

- [x] 2.1 Derive the day key of every sample once per `buildLedger` and fold the intervals, the
  coarse marks and the manual bases from that list, keeping the interval/samples coupling
  commented; verify every existing `buildLedger` case in `test/history.test.js` passes unchanged,
  including the day attribution, the coarse day and the anchored-base totals
- [x] 2.2 Replace `addedSince`'s per-row filter over the series and the credit list with a
  per-day index built on first use, leaving the arithmetic and its order untouched; verify the
  anchored-base, the top-up-after-correction, the correction-after-close and the frozen-override
  cases still report the same figures, and that a 200 000-sample ledger with 30 overrides drops
  from 749 ms (`local`) to a few milliseconds

## 3. Thin in the ledger's zone

- [x] 3.1 Give `compactSamples` the ledger's zone and bucket the thinned samples by that zone's
  day key plus local hour instead of by `Math.floor(t / HOUR_MS)`, and pass the zone through
  `readSamplesCompacting` and `load()` (reading the state document first, so a stored
  `dayZone` is the one the log is cut on); verify the existing compaction case still keeps one
  sample per hour and every recent sample
- [x] 3.2 Add a `test/history.test.js` case that thins samples straddling local midnight in
  `Asia/Kolkata` (+05:30) and asserts each day keeps a sample from its own last hour; verify it
  fails against the UTC bucket (23:55 then 00:25 across the boundary) and passes after it

## 4. Whole-change acceptance

- [x] 4.1 Run `npm test`, `npm run lint` (knip + jscpd, from a scratch copy with its own
  `node_modules` because the worktree links the dsh kernel) and `nix flake check` in the
  worktree; verify all are green and that no test was removed or weakened
- [x] 4.2 Run `openspec validate --all` and tick every item above, then archive the change with
  `openspec archive fix-ledger-build-cost --yes`; verify `openspec/specs/balance-tracking/spec.md`
  carries the zoned thinning requirement and the archive folder is part of the branch
