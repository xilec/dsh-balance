# Proposal

## Why

A hand-entered day is the only figure in the plugin the reader is asked to trust, and
everything around it accepts input it cannot possibly honour.

- The override route takes any `date` matching `/^\d{4}-\d{2}-\d{2}$/`. `9999-99-99`,
  `0001-01-01` and a date a century from now are all accepted, each one a permanent key in
  `overrides` in memory and in `state.json`, each one re-read on every start. The spec only
  requires a malformed date to be rejected, so this is hardening — but the document it grows
  has no bound at all.
- `dayZone` is checked for being a non-empty string and nothing else. `history.js` falls back
  to the host's own zone for a name `Intl` does not know, and the payload still reports the
  name that failed, so the panel shows a zone the ledger is not using.
- The override's anchor balance is read out of the in-memory cache with no instant, while the
  entry stores the instant of the *write*. Those are up to one `refreshIntervalMs` apart, and
  the balance can be far older still: a failed poll keeps the last good reading and
  `cache.fetchedAt` stays where the last success was. The spec says the base remembers "the
  account balance of that instant"; the implementation remembers the balance of a nearby one,
  and in the normal case that means the base is anchored to a reading the ledger considers
  *newer* than the newest sample, so `addedSince` refuses to add and every correction is
  frozen — the "a corrected day keeps filling" scenario cannot happen through the route at all.
- `zoneFields` builds a `{ dateKey, hour }` pair for every calendar lookup; the ledger reads
  one field and the thinning pass reads both, and the day-only callers pay for the hour
  lookup (the `formatToParts` slow path walks the parts array for an hour nobody asked for).

## What Changes

- The override route accepts only a day the retained history can still hold: not older than
  `keepDays` days back and not later than the ledger's tomorrow, both measured in the ledger's
  own zone. A removal is still accepted for any well-formed date, because it can only shrink
  the document.
- A write that would push the corrections past the longest ledger the plugin can show
  (`historyDays`, 400 at the schema maximum) drops the oldest day keys. A load never prunes,
  so a hand-edited document is not rewritten behind the reader's back.
- `dayZone` is accepted only when the runtime can use it: `local`, or a name `Intl` accepts —
  the same check `requestZone` already makes for the read route's `zone` query, extracted into
  one predicate and reused by the settings check, the stored-preference check and the runtime
  config. The payload therefore always names the zone the ledger is actually reading in.
- An override's anchor records the balance *and the instant it was read* (`cache.fetchedAt`),
  which is the same instant as the balance reading the reader was looking at, and an override
  written before the Host has read any balance records no instant at all. A poll that failed
  leaves both the balance and its instant where the last success was, and the entry then names
  that instant: the day's added part is the drop the ledger can actually measure from there.
- `buildLedger` adds to a base only when the anchor lies inside that day's own span of
  samples — at or after the day's first sample and at or before its last. Before the first
  sample the window starts on the previous day and carries its spend; after the last sample
  there is nothing left to measure. The three cases (anchor inside the day, anchor newer, anchor
  exactly equal to the newest sample) plus the cross-midnight one are pinned by tests.
- `history.js` splits the calendar lookup into `dayKeyOf` and the thinning pass's own hour
  bucket, so no returned shape carries a field its caller does not read. No exported API and
  no figure changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-tracking`: "A manual override is an anchored base" (the anchor carries the instant of
  its balance; the added part is measured only inside the day's own span) and "The ledger write
  routes" (a day the retained history cannot hold is rejected with `400`).
- `plugin-settings`: "Runtime-writable settings" (a `dayZone` the runtime cannot use is
  rejected with `400`) and "The on-disk state document" (the corrections are bounded, and the
  bound applies to writes rather than to a load).

## Impact

- Modified: `src/index.js` (the zone predicate and its four call sites, the override route's
  day window and corrections cap, the anchor's instant and freshness), `src/history.js`
  (`zoneFields` split, `addedSince`'s span guard).
- Modified: `test/plugin-host.test.js` (the day window, the corrections cap, the rejected zone,
  the anchor's instant), `test/history.test.js` (the three anchor positions, the calendar
  helpers).
- No new dependency, no change to the configuration schema, to the state file's shape
  (`{ amount, at, balance }` is unchanged) or to any figure the ledger produces for a base
  anchored inside its day's span.
- One behaviour changes for the better and is called out in the design: an override written
  through the route now keeps filling, which is what the spec has always required and what the
  frozen-by-construction behaviour prevented.
