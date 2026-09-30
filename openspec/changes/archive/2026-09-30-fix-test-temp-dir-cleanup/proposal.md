# Proposal

## Why

`test/plugin-host.test.js:1420` — `the client heartbeat that lands during the load does not
blank the stored state` — fails intermittently with

```
[Error: ENOTEMPTY: directory not empty, rmdir '/tmp/dsh-balance-test-qzYNWH']
```

Reproduced here at **25 hits in 144 concurrent copies** of `test/plugin-host.test.js` on a
24-core box (1 in 72 on the first attempt). It is the third class of machine-dependent test the suite has taken on, and it is
the last one left of the set fixed in `fix/t2b`: the plugin behaves identically, and the suite
goes red on whichever colleague's machine happens to be busy.

The mechanism is a race between two correct things. `withPlugin` and the hand-rolled
fixtures end in `await rm(home, { recursive: true, force: true })`, and Node's `rm` defaults
to `maxRetries: 0` — one attempt, then throw. Meanwhile the plugin under test is still alive:
the browser heartbeat persists **without awaiting** (`void persist()` at `src/index.js:1273`)
and the sampling loop arms its first tick 500 ms after `apply` (`src/index.js:643`). Both end
in `writeAtomic`, which is `mkdir -p` + `writeFile` + `rename` (`src/store.js:165`). So
`rm` can read the directory, unlink what it saw, and then `rmdir` a path the heartbeat has
just re-created — `ENOTEMPTY`.

Two of the fixtures make it worse by ordering the two halves backwards: they call
`rm(home)` at the end of the `try`, so the directory is deleted **before** `ctx.dispose()` runs
in the `finally`. Nothing has stopped the sampling loop at the moment the directory goes.

## What Changes

- Every temporary home removal in the suite goes through one helper that asks `rm` to retry,
  because a write already in flight is the normal case at that point rather than an exotic one.
- The two fixtures that removed the directory *before* disposing the plugin are reordered:
  `ctx.dispose()` first, then the removal. Disposal is what clears the loop's timer and sets
  the flag that stops a tick re-arming, so after it there is exactly one write left to wait
  out — and it is a write disposal cannot reach. The reorder is the fix; the retry policy is
  the belt to that pair of braces, and the code says so.
- No assertion changes, no plugin change, no new dependency.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None. No specified behaviour of the plugin changes: this is a change to the tests that check
it.

## Impact

- Modified: `test/plugin-host.test.js` (one removal helper, thirteen call sites), and
  `test/store.test.js` (`withDir`'s single removal).
- Not modified: `src/`, `client/`, any spec under `openspec/specs/`, any file format, any
  route, the configuration schema.
- No new dependency: `fs.rm`'s own `maxRetries` and `retryDelay` options are the machinery.
