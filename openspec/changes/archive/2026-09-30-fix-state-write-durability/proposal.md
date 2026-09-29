# Proposal

## Why

Two on-disk write paths can lose the user's data, and both are invisible today.

`state.json` is replaced through a temp sibling and a rename, but the temp name was
`<path>.<pid>.tmp` — one name per process — while the Host writes that file concurrently *by
design*: the client heartbeat route persists on every browser poll and the settings and overrides
routes await their own write. Two overlapping writes share one temp path, the first `rename`
moves it away and the second fails `ENOENT`, which `persist()` downgraded to a warning. The
overrides route then answered `200 {ok: true}` for a correction that was not on disk, and a
reviewer reproduced 60 lost writes out of 60 concurrent pairs.

The sample log was thinned only inside `load()`, so a Host that runs for months never thins
again: the log is append-only and unbounded (~11 MB/year at the default cadence), and at the
schema's maximum `keepDays: 3650` a start reads ~100 MB and materialises about a million objects
*before* `MAX_SAMPLES` trims anything — the cap meant to bound memory fires after the blow-up it
was written to prevent.

## What Changes

- `writeAtomic` uses a temp name unique per write (`<path>.<pid>.<n>.tmp`) instead of one per
  process, so two concurrent writes can never share or clobber a temp file.
- `persist()` is serialised: a single chained promise, at most one write in flight, and the
  chain is never wedged — a failed write resolves `false` and the next write still runs.
- `persist()` returns whether the write actually landed, and the overrides and settings routes
  answer `500 {ok: false}` when it did not, instead of `ok: true` for a lost correction.
- Mutations of the sample log (append and compaction rewrite) go through one chain, so a
  periodic compaction cannot swallow a sample appended while it ran.
- Compaction is re-run while the Host runs, not only at startup: after every 100 appended
  samples the log is thinned again and the in-memory list is replaced with what the rewrite
  kept.
- `parseSamples` takes a limit and reads the tail of the log: lines are walked one at a time and
  only the newest `limit` samples are ever materialised, so a huge file cannot blow up a start.
- No delta specs: the plugin's specified behaviour does not change. `openspec/specs/
  plugin-settings` already requires that a write never blanks a stored choice and that the file
  is replaced through a temp sibling and a rename; `openspec/specs/balance-tracking` already
  says the log is thinned by age. This change makes the code meet those requirements — hence
  `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None. `plugin-settings` ("The on-disk state document", "The client heartbeat") and
`balance-tracking` ("The sample log on disk is append-only and thinned by age") already require
this behaviour; the defect is that the implementation did not meet them.

## Impact

- Modified: `src/store.js` (unique temp names, a serialised sample-log chain, the parse limit
  plumbed through `readSamplesCompacting`), `src/history.js` (`parseSamples(text, { limit })`),
  `src/index.js` (the `persist()` chain and its return value, the periodic compaction trigger).
- New: `test/store.test.js` (concurrent writes, a failing write, the parse cap, compaction while
  the Host runs).
- No new dependency: the chain is a promise, not a mutex library. No change to the payload the
  browser half sees, to the configuration schema, or to any file format on disk.
- `persist()`'s return value is new internal API; the one caller that ignores it (the heartbeat
  route, which is fire-and-forget by specification) keeps doing so.
