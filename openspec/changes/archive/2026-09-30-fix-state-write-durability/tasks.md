# Tasks

## 1. Concurrent state writes

- [x] 1.1 Give `writeAtomic` a unique temp name per write (`${path}.${pid}.${n}.tmp`, module
  counter) in `src/store.js`; verify by writing the same file twice from two overlapping
  `writeState` calls in `test/store.test.js` and asserting both documents land and no `.tmp`
  sibling is left behind — the old single name loses every second write
  — done: `tempCounter` is in place; 30 concurrent pairs resolve (the old code rejected one of
  each pair with ENOENT, verified by running the new test against the old `src/`) and the
  directory is left holding only `state.json`
- [x] 1.2 Serialise `persist()` in `src/index.js` on one chained promise, with the document built
  when the write runs and a `true`/`false` result; verify with a real `Promise.all` of two
  concurrent persists that both land, that the second document carries the newest state, and that
  a write that fails (an unwritable directory) resolves `false` without rejecting or blocking the
  write queued behind it — all in `test/store.test.js`, no mocked timers
  — done: `persistChain` runs one `writeStateOnce` at a time and never carries a rejection;
  `test/plugin-host.test.js` drives two concurrent corrections through the route and reads both
  off disk with no `cannot write state` warning, and the `state.json`-is-a-directory case shows a
  write resolving `false` while the correction behind it still lands
- [x] 1.3 Answer `500 { ok: false }` from the overrides and settings routes when `persist()`
  reports a lost write, leaving the heartbeat route fire-and-forget; verify in
  `test/plugin-host.test.js` that a failing write turns an otherwise valid override into `500`
  with `ok: false` and that the change is still served from memory afterwards, and that the
  existing `200 { ok: true }` tests stay green
  — done: both routes answer `500 { ok: false, error }` on a lost write and `200` otherwise, and
  `persist()` answers `true` when there is no harness home, so the documented "keeps its history
  in memory and never fails a request" behaviour is unchanged

## 2. The sample log while the Host runs

- [x] 2.1 Cap the parse before it materialises: `parseSamples(text, { limit })` walks the log
  line by line, counts lines with an `indexOf` scan and parses only the newest `limit` of them;
  `readSamplesCompacting` takes `options.maxSamples` and passes it down; `index.js` passes
  `MAX_SAMPLES`. Verify in `test/store.test.js` that a log of far more lines than the limit
  returns exactly the newest `limit` samples ascending, and that the load-time bound equals the
  append-time one
  — done: `MAX_SAMPLES` moved to `store.js` and is exported, so the read cap and the append-time
  trim are literally the same number and `index.js` imports it; `parseSamples` keeps the newest
  `limit` lines and no longer splits the whole text
- [x] 2.2 Put appends and the compaction rewrite on one chain in `src/store.js`, so a rewrite
  cannot swallow a sample appended while it ran; verify in `test/store.test.js` that an append
  issued while a compaction is in flight is still in the log afterwards
  — done: `enqueueSampleJob` orders both; the failing-append test shows a rejected link does not
  wedge the queue, and the compaction test shows the appended sample is the newest line of the
  rewritten log
- [x] 2.3 Re-run the compaction while the Host runs: count appended samples in `recordSample` and
  at 100 call the same `readSamplesCompacting` the load calls, replacing the in-memory list with
  what the rewrite kept. Verify in `test/plugin-host.test.js` that appending past the threshold
  through the refresh route rewrites the log (thinned lines disappear) with no restart, and that
  the ledger still reports every sample the rewrite kept
  — done: `COMPACT_EVERY_SAMPLES` and `thinSamples()` are in `recordSample`; 100 refreshes against
  a log holding three samples of an hour older than `keepDays` leave one of them on disk, with
  every sample appended since kept

## 3. Integration

- [x] 3.1 Run `npm test`, `nix flake check`, `npm run lint` (knip + jscpd, in a scratch copy with
  the dev dependencies installed, since the kernel-linked tree has no lint tools) and
  `openspec validate --all`; confirm the test count did not drop and `git status --short` shows
  only the intended files
  — done: `npm test` 272 passing (262 before, ten new), `nix flake check` all checks passed,
  knip and jscpd clean in the scratch copy, `openspec validate --all` 7 passed / 0 failed
- [x] 3.2 Tick every item above, archive the change with
  `openspec archive fix-state-write-durability --yes`, and confirm `openspec/specs/` is unchanged
  (the change declares `skip_specs`)
  — done: the change is archived as `2026-09-30-fix-state-write-durability` and `openspec/specs/`
  is byte-identical, because `plugin-settings` and `balance-tracking` already required this
  behaviour
