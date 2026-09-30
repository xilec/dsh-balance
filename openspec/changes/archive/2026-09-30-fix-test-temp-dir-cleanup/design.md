# Design

## Context

See `proposal.md` — Why for the flake and its message. What constrains the approach:

- **`rm` is a single attempt by default.** `fs.rm` takes `maxRetries` (default `0`) and
  `retryDelay`; with `0` an `ENOTEMPTY` from `rmdir` is thrown straight out of the `finally`
  that was only trying to tidy up.
- **Three of the plugin's own paths write under the home while a test is tearing it down.**
  `writeAtomic` (`src/store.js:165`) is `mkdir -p` → `writeFile` → `rename`;
  `appendSample` (`src/store.js:120`) is `mkdir -p` → `appendFile`. The heartbeat route
  persists without awaiting (`void persist()`, `src/index.js:1273`) and the sampling loop arms
  its first tick 500 ms after `apply` (`src/index.js:643`), so both can be part-way through a
  write when a test reaches its cleanup.
- **The plugin hands the test nothing to await.** The write chain is a closure local
  (`persistChain`, `src/index.js:314`), and the sample queue is a module local
  (`samplesQueue`, `src/store.js:52`). Neither is exported, and exporting one would be a
  plugin change made to serve a test defect.
- **The suite's own doctrine, from `fix/t2b`:** *a test may wait for work, never for time.*
  A bounded count of `setImmediate` hops is a timeout wearing a loop's clothes, and this suite
  removed a dozen of them for exactly that reason.

## Goals / Non-Goals

**Goals:**

- No `ENOTEMPTY` (or any other removal error) can turn a green test red.
- Where the ordering can be made correct, make it correct — the retry is the belt, not the
  fix.
- One call site per removal, so the policy cannot drift between thirteen fixtures.

**Non-Goals:**

- Changing the plugin's write path, its sampling cadence, or its disposal semantics.
- Changing any assertion, any fixture's data, or any timeout.
- Cleaning up after a run that was `SIGKILL`ed. A directory leaked by a killed process is not
  what makes a test pass or fail.

## Decisions

### 1. One helper, `removeHome(home)`, for every temporary home in `plugin-host.test.js`

The suite has thirteen `await rm(home, …)` call sites for a per-test home, in two shapes:
`withPlugin`'s `finally`, and the hand-rolled fixtures that manage `$DSH_HOME`, `fetch` and
mock timers themselves. Repeating `{ recursive: true, force: true, maxRetries: 5, retryDelay: 50 }`
fourteen times is fourteen chances to leave one behind, and jscpd would have an opinion about
the repetition anyway. One helper, called from all of them, makes the policy a single fact.

*Alternative:* a `t.after()` hook per test. `node:test`'s `t.after` runs after the test body
but the home is created *inside* the body, so it cannot be registered before the value exists,
and registering it in the body would still run before a `finally` that already removes the
home. Rejected as no better than the current shape.

### 2. `maxRetries: 5, retryDelay: 50`, not a bounded wait for the in-flight write

`maxRetries: 5` with a 50 ms delay gives roughly 250 ms of retry budget on top of the first
attempt, and `fs.rm` retries the whole removal — which is what has to happen, since the stale
`readdir` is the problem, not one failed `unlink`. 250 ms is generous because it is not
load-bearing: after disposal there is at most *one* write left (see decision 3), and a single
`appendFile` does not take 250 ms on any machine that can run this suite.

*Alternative:* pump the event loop N times before `rm`, waiting for the plugin's write to
finish. Rejected twice over. First, N is a guess about how many turns one `mkdir` +
`appendFile` occupies — the precise quantity `fix/t2b` established is the machine's, not the
test's — and a test that waits a fixed number of turns is the defect this suite just finished
removing from twelve cases. Second, there is nothing to wait *for*: the write chain is not
observable from outside the module, so "wait until it settles" can only be spelled as a
duration.

### 3. Dispose the plugin before removing its home, at the two fixtures that got it backwards

`a write that arrives while the state is still loading survives the load`
(`test/plugin-host.test.js:1372`) and `the client heartbeat that lands during the load does not
blank the stored state` (`:1420`) both end their `try` with `await rm(home, …)`, so the
directory is deleted **before** the `finally` runs `ctx.dispose()`. At the moment the
directory goes, the sampling loop is still armed. Moving the removal into the `finally` after
`ctx.dispose()` is the correct order and is what makes the retry unnecessary in the common
case: disposal sets `loopStopped` and clears the timer, so a tick that had not yet fired never
fires, and a tick that had fired does not re-arm.

The eleven other fixtures already dispose first. Two call sites change shape rather than
options.

**What disposal cannot reach, and why the retry stays anyway.** `clearTimeout` does not
recall a callback that is already running, and `resetLoop`'s tick only checks `loopStopped`
*after* its `await refresh()` (`src/index.js:639`). A tick that fired 400 ms before disposal is
inside `appendSample` — `mkdir(dir, { recursive: true })` and `appendFile` — and disposal has
no handle on it. That is the write the observed `ENOTEMPTY` came from: instrumenting the
failing run showed the directory repopulated with exactly `dsh-balance/samples.ndjson`, which
is the sample log the tick appends to, not the `state.json` the heartbeat writes. The state
write had in fact already landed — the test had read it back — which is why removing the
directory *after* reading the document still races.

So the pair is deliberate: **dispose removes every future write; the retry absorbs the one
write already in flight.** Both halves are kept because each closes a window the other leaves
open, and because neither was individually *shown* to be sufficient here — at 144 concurrent
copies each, ablation B (dispose-first, no retries) and ablation C (retries, no reorder) both
came back with zero hits, against 25 of 144 for the unmodified baseline. The rate this flake
fires at is low enough that one half masks the other under this much load; shipping only the
one that happened to measure clean would be betting on a sample size, not on a mechanism.

*Alternative:* make disposal await the in-flight tick, e.g. by giving the plugin a
`whenIdle()`. Rejected: a plugin API added for a test defect, for a plugin whose own disposal
semantics are already covered by
`the sampling loop stops for good when the plugin is disposed with a fetch in flight`.

### 4. `test/store.test.js`'s `withDir` gets the retry, and no reorder

`withDir` is the only cleanup there, and every store call its tests make is awaited
(`Promise.allSettled` at `:33`, `await appendSample`, `await readSamplesCompacting`), so no
write can be in flight when its `rm` runs. There is no plugin and no loop to dispose. What
gets added is only the retry — the same belt, on the reasoning that `withDir` removes a
directory the store writes into, so the next test to await its write loosely is exactly the
regression that would resurrect this flake.

The `rm(blocked, …)` inside `a failed append does not wedge the sample queue` (`:63`) is left
alone: it removes a directory the store has already failed to append to, and the very next
line asserts on the file that replaces it.

### 5. `~/.dsh` stays out of it

`SUITE_HOME` (`test/plugin-host.test.js:25`) is created at module load and defaults any
missing or blank `$DSH_HOME` to it. Nothing in this change deletes it, and `removeHome` is
only ever handed a `mkdtemp` directory. `test/plugin-host.test.js:276` asserts the suite home
is not inside the real `~/.dsh`, and that assertion is untouched.

## Risks / Trade-offs

- **[The retry masks a genuine leak]** → it does not: the removal still has to succeed, and a
  directory that keeps being repopulated for 250 ms fails. What it absorbs is the single write
  disposal provably cannot reach.
- **[A test that hangs on a leaked directory]** → unchanged. `mkdtemp` directories are removed
  today and still are; this only changes whether the removal is retried.
- **[jscpd flags the new helper as a duplicate of something in `src/`]** → checked; it will be
  run.
- **[The next person adds a fixture and forgets the helper]** → the helper is the only `rm` in
  the file that takes a `mkdtemp` home, so a new fixture that skips it is the only thing to
  watch for, and knip/jscpd do not catch that. Recorded here rather than defended against with
  machinery that would be larger than the defect.

## Migration Plan

None. Test-only change; nothing ships.

## Open Questions

None.
