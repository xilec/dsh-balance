# Proposal

## Why

The requirement "A manual override is an anchored base" justifies its anchor span with
"a window that starts before the day began carries the previous day's spend". That reason
holds when the anchor is on the *previous* day and is wrong when the anchor is a few
minutes before the day's first sample *on that same day* — the window is then entirely
inside the day and the drop is the day's own spend. The rule as implemented is broader
than its stated justification, so a reader following the spec would expect a figure the
ledger does not produce.

## What Changes

- Amend the requirement's rationale so it states the invariant the code actually holds:
  a base is only ever added to by a drop between two instants of the same ledger day.
- Name the same-day case in the spec, so it is a documented consequence rather than
  something a reader has to rediscover: an anchor before the day's first sample
  contributes 0 even when it lies on that same day, because the base is a measurement of
  the day from its first sample onward.
- Say what the reader still gets: the day's own sampled spend is reported separately in
  the row's `computed` field (the panel's "From samples" column), and re-entering the
  correction once the anchor lands inside the day restores the sampled part.
- Add a scenario for the same-day-before-first-sample case, and pin it with a test in
  `test/history.test.js` so the spec's words and the arithmetic cannot drift apart.

**No behavior change.** The rule stays exactly as implemented; the spec stops claiming a
justification the code never had.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-tracking`: the requirement "A manual override is an anchored base" — its
  rationale and the "A base anchored before the day began" scenario are reworded, and a
  scenario for an anchor on the same day but before its first sample is added. The
  normative rule ("measured only when the anchor lies inside that day's own span of
  samples") is unchanged.

## Impact

- `openspec/specs/balance-tracking/spec.md`: one requirement's prose and scenarios.
- `test/history.test.js`: one specification test.
- No change to `src/` or `client/`, no API, no dependency, no state format.
