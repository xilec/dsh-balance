# Design

## Context

See `proposal.md` — Why. The facts that shape the approach:

- `src/store.js` is the only writer of `$DSH_HOME/dsh-balance/`. `writeAtomic` is the one place
  a document is replaced; `readSamplesCompacting` is the only place the sample log is rewritten.
- `src/index.js` calls `persist()` from four places with two different contracts: the client
  heartbeat route fires it and answers immediately (`void persist()`, by specification), while
  the settings and overrides routes await it and answer `ok: true` to the browser.
- `persist()` builds its document from live module state (`overrides`, `clientHello`, `uiPrefs`)
  at the moment it runs, so a write that starts later writes *newer* state.
- `MAX_SAMPLES = 200_000` (`src/index.js:39`) is the declared bound on the in-memory sample list,
  applied at `src/index.js:375` on append — i.e. after the load has already materialised
  everything the file held.
- `openspec/specs/plugin-settings` requires that the state file be replaced through a temporary
  sibling and a rename and that a failed write only warn; `openspec/specs/balance-tracking`
  requires the log to be thinned by age and rewritten atomically, and says nothing about *when*
  thinning happens.
- The plugin is single-writer: one Host process, one sampler loop, and the browser half only
  talks to it over HTTP routes. No second process writes these files.
- Node >= 22, ESM, no new dependency without a recorded reason. `jscpd` (min 10 lines, 60 tokens)
  guards against copy-paste, so the two write paths must not become near-clones of each other.

## Goals / Non-Goals

**Goals:**

- No two writes of the same file can interfere, and no write can report success it did not
  achieve.
- A failed write degrades exactly one request: it warns, answers `ok: false`, and leaves the
  chain usable.
- A start's memory cost is bounded by `MAX_SAMPLES`, whatever the size of the log.
- The log on disk stays within a bounded distance of what compaction would produce, while the
  Host runs — not only at the next start.

**Non-Goals:**

- No cross-process locking (`flock`, a lock file). A second writer does not exist, and the plugin
  must not start failing because of a stale lock.
- No retry inside `persist()`. A failed write is reported to the caller that caused it; retrying
  hides a full disk or a read-only directory behind latency.
- No change to the file formats, the payload, the configuration schema or the specs.
- Not touching the day-bucketing zone. That is another change's line (`fix/t1`, PR #10) and this
  one needs none of it: thinning buckets by epoch hour and the pre-parse cap are both decided by
  sample order and instant, not by a calendar zone.

## Decisions

**D1 — A unique temp name per write, from a module counter.**
`writeAtomic` builds `${path}.${process.pid}.${tempCounter++}.tmp`. The pid already separates
processes; the counter separates the writes inside one process, which is the only case that
occurs here. Alternative considered: `randomUUID()`; rejected — a counter makes the leftover
file from a crash identifiable (`state.json.12345.7.tmp` says which write died), needs no import,
and cannot collide. Accepted cost: a write that fails after `writeFile` leaves its temp behind
until the process restarts. That was already true before (one temp name, always overwritten) and
a leftover sibling is invisible to `readTextIfPresent`, which only ever opens the two real files.

**D2 — Serialise `persist()` in `index.js`, not in `store.js`.**
`persist()` chains onto a module-level promise: `persistChain = persistChain.then(write, write)`
where `write` is the snapshot-and-`writeState` step that catches its own errors and resolves
`true`/`false`. The chain is in `index.js` rather than around `writeAtomic` because the ordering
that matters is the ordering of the *documents*: with the chain in `store.js` each caller would
serialise its snapshot at call time and two writes could still land out of order, so a stale
snapshot could overwrite a newer one. With the chain in `index.js` the document is built when the
write runs, so a queued write can only ever write state that is at least as new as the one
before it. Both handlers (`then(write, write)`) are attached so that even an unexpected rejection
cannot leave a poisoned chain — every later write would then have nothing to chain onto.
Alternative considered: a mutex library; rejected as a dependency for a one-line chain.

**D3 — `persist()` returns whether the write landed, and the two `await`ing routes act on it.**
The overrides and settings routes answer `500 { ok: false, error: 'the state could not be written' }`
when `persist()` resolves `false`, and `200` otherwise. `plugin-settings` says a failed write
must warn and must not break the running plugin — it does not: the change is still in memory, the
next successful write persists it, and the browser half already treats `!response.ok` or
`ok === false` as an error (`client/client.js:1105`), so the reader sees "not saved" instead of a
correction that silently vanished. The heartbeat route keeps its fire-and-forget contract (the
spec requires it and its answer carries nothing the browser acts on); it does not read the value.
Alternative considered: answering `200 { ok: true, written: false }`; rejected — `ok: true` is the
client's "saved" signal, and this defect is precisely that signal lying.

**D4 — Thin the log every 100 appended samples, not on an hourly timer.**
The counter lives next to the append: `recordSample` increments it after a successful
`appendSample`, and at 100 it runs the same `readSamplesCompacting` call the load runs and
replaces the in-memory list with what the rewrite kept. An hourly timer was the other candidate;
it is worse here, because the quantity that has to stay bounded is *lines appended since the last
thinning pass*, and that quantity is proportional to the append rate, not to wall-clock time. A
wall-clock timer adds a read of the whole file (megabytes) per tick and bounds nothing that the
counter does not already bound better: at the default 5 minute cadence 100 samples is about 8
hours, at the 15 second minimum about 25 minutes, and at a sparse cadence where the timer would
fire hourly the counter fires never — but a sparse cadence is also one where the file barely
grows, and `load()` has already thinned whatever accumulated while the Host was down. The
counter also needs no timer to clear on dispose, and it is deterministic: a test can drive it by
appending real samples through the refresh route rather than by waiting on a clock. Alternative
considered: both (hourly *and* every N) — redundant, since either alone bounds the file.

**D5 — Cap the parse, not the parsed list: `parseSamples(text, { limit })`.**
The limit is the number of *lines* the reader materialises, and it takes the **tail** of the log.
`parseSamples` counts the lines with a `indexOf` scan (no allocation) and then walks only the
lines after the ones it skips, slicing and parsing them one at a time. So a 1 M line file costs
one `readFile` string plus `limit` objects, instead of `split('\n')` materialising a million line
strings and then a million sample objects before `MAX_SAMPLES` throws almost all of them away.
Taking the tail is sound because the log is append-only and `parseSamples` already returns samples
sorted ascending: the newest samples are the last lines. `readSamplesCompacting` takes
`options.maxSamples` and passes it down; `index.js` passes the `MAX_SAMPLES` it already applies
to the in-memory list, so the load's bound and the append-time bound are the same number and the
two can no longer disagree. Alternatives considered: reading the last N bytes with a file handle
(`open` + `read` at a computed offset) — it saves the 100 MB string too, but it makes "newest"
depend on a byte-length guess and adds a second code path; keeping `split` and slicing the array
afterwards — that is exactly the defect.

**D6 — One chain for the sample log, in `store.js`.**
`appendSample` and the compaction rewrite inside `readSamplesCompacting` are queued on one
promise chain. This is a prerequisite for D4 rather than a separate fix: a compaction that reads
the file and then rewrites it can swallow a sample appended in between, so introducing periodic
compaction without the chain would trade an unbounded log for a lost sample. Both jobs catch
their own errors (the compaction write already had to: "a failed compaction write MUST NOT
prevent the history from being read"), so a rejected link cannot wedge the queue.
Alternative considered: leave appends alone and accept the small loss window; rejected — the
window is exactly the length of a full-file rewrite, and the cost of closing it is one promise.

## Risks / Trade-offs

- **The pre-parse cap makes thinning irreversible at a boundary it did not have before** — a log
  longer than `MAX_SAMPLES` is rewritten down to the newest `MAX_SAMPLES` (plus the hourly
  survivors), because the compaction write serialises what the reader returned. → Accepted and
  deliberate: a restart already truncates the in-memory list to exactly these samples, so the
  rewrite only puts on disk what the Host would have kept anyway, and it is the only thing that
  makes a pathological file shrink. `MAX_SAMPLES` is ~23 years of hourly-thinned samples, so the
  cap can only bite on a full-resolution log older than the retention window.
- **The heartbeat route persists on every browser poll** (~15 s per tab), so the chain can queue
  several writes behind a slow disk, and a queued heartbeat write re-serialises state that a
  later request has already changed. → Harmless, and slightly better than before: each queued
  write carries the newest state, so the last one in the chain is the current state. Coalescing
  (drop a queued write if one is already pending) is a further optimisation and is not taken,
  because it would change what "the write landed" means for the caller that awaits it.
- **A write failure now answers `500`** where it used to answer `200`. → Intended (D3), and the
  browser half surfaces the message; the plugin itself keeps running with the change in memory.
- **Compaction while running replaces the in-memory sample list**, so the Host temporarily holds
  the thinned series rather than the full-resolution one for old samples. → Identical to what a
  restart produces (`load()` does the same call), and it keeps memory and disk in agreement — the
  ledger is computed from the same list the log holds.
- **The chains are module-level, so two plugin instances in one process serialise with each
  other.** → Correct, not merely harmless: the tests instantiate the plugin twice against one
  `DSH_HOME` to prove a restart restores state.

## Migration Plan

No data migration and no format change. Existing `state.json` and `samples.ndjson` files are read
by the same code paths; the first write after the upgrade rewrites the log only if thinning
actually dropped samples. Reverting is a plain revert: the temp-file naming, the chains and the
cap are internal, and the only observable difference a revert brings back is the one being fixed.

## Open Questions

None that would change the approach.
