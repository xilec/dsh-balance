# Tasks

## 1. The override's day is bounded

- [x] 1.1 Reject a well-formed `date` the retained history cannot hold: compare it against
  `dayKeyOf(now − (keepDays − 1) days, dayZone)` and `dayKeyOf(now + 1 day, dayZone)` in the
  ledger's zone, answer `400` naming `date`, and store nothing. A removal keeps working for any
  well-formed date. Verify in `test/plugin-host.test.js` that `9999-99-99`, a year 0001 and a
  day a fortnight ahead are all `400` with `ok: false` and no key in `overrides`, that the
  oldest ledger day and today are accepted, and that a removal of an out-of-window day is
  `200` — the new test fails on the current code, which accepts `9999-99-99`
- [x] 1.2 Bound the stored corrections: keep at most 400 (the schema's maximum `historyDays`),
  dropping the oldest day keys, always keeping the one just written, and apply it on the write
  path only. Verify in `test/plugin-host.test.js` that 401 accepted corrections leave 400 on
  disk with the newest day among them, that a correction written for the oldest day still
  survives a full document, and that the load still restores a hand-written document holding
  more than the bound untouched

## 2. The day zone the ledger can use

- [x] 2.1 Turn `requestZone`'s check into an `isUsableZone` predicate, use it for
  `MUTABLE_SETTINGS.dayZone` (which the settings route and the stored-preference restore share),
  and normalise an unusable `dayZone` from the composition row to `local` at start-up. Verify in
  `test/plugin-host.test.js` that posting `dayZone: 'Mars/Olympus'` is `400` naming `dayZone`
  and leaves the reported zone alone, that a valid IANA name is applied, and that a row naming
  an unusable zone yields a payload whose `zone` is the one the ledger reads in
  — all three assertions fail on the current code, which accepts the name and reports it back

## 3. The anchor remembers its instant

- [x] 3.1 Store the anchor with the instant it was read: `at: cache.fetchedAt` next to
  `balance`, and no instant at all when the Host has read no balance — a moment with no
  measurement behind it is not an anchor. Verify in `test/plugin-host.test.js` that a
  correction written right after a refresh stores the fetch instant the read route reported
  rather than the moment of the write, and that the day then keeps filling as the balance
  moves with no second write involved; that a correction written after the poll has been
  failing is anchored to the last good reading and the instant it was read; and that a
  correction written before any balance was read is the amount alone
  — the first and the last fail on the current code, which stamps `Date.now()` onto the entry
  whatever balance it has
- [x] 3.2 Add the span guard in `buildLedger`'s `addedSince`: nothing is added when the anchor
  is earlier than the day's first sample, because the drop it would be measured over starts on
  the previous day. Verify in `test/history.test.js` with the positions the rule is about — an
  anchor between two samples of the day (which must keep filling), one exactly at the day's last
  sample (nothing added: the base is final), one after it (nothing added, already the rule) and
  one before the day's first sample (nothing added, which is the new case) — and assert the
  figure the new case refuses is the one the old code produced

## 4. The calendar helpers hand back one field

- [x] 4.1 Split `zoneFields` into a module-private pair with `dayKeyOf` and the thinning bucket
  as the two callers, so the `formatToParts` slow path no longer looks up an hour for a caller
  that wants a day. Verify in `test/history.test.js` that `dayKeyOf` still returns a bare
  `YYYY-MM-DD` in a named zone, in `local` and for an unknown zone, and that thinning still
  buckets on the ledger zone's own clock hours in a fractional-offset zone — the behaviour the
  split must not break

## 5. Integration

- [x] 5.1 Run `npm test`, `nix flake check`, `npm run lint` (knip + jscpd, in a scratch copy
  with the dev dependencies installed, since the kernel-linked tree has no lint tools) and
  `openspec validate --all`; confirm the test count did not drop and `git status --short` shows
  only the intended files
- [x] 5.2 Tick every item above and archive the change with
  `openspec archive fix-override-anchor-and-input-bounds --yes`, confirming `openspec/specs/`
  carries the four modified requirements
