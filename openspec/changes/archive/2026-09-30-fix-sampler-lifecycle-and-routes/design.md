# Design

## Context

See `proposal.md` — Why. Everything here is in `src/index.js`, in the parts that run with no
browser attached: the `resetLoop`/`refresh` pair that samples the balance, the three route
handlers, and the `readJsonBody` helper every writer goes through. The constraint on the change
is that it stays surgical: the plugin's structure, its payload shape and its figures are not in
question, and no existing test may change meaning.

Two of the six findings are one finding seen from two sides, and it is worth being precise
about which signal means what on a `node:http` exchange:

| event | on the request (`IncomingMessage`) | on the response (`ServerResponse`) |
|---|---|---|
| `close` after a GET with no body | fires once the request is consumed — microseconds into the handler | fires when the response is finished, **or** when the socket is gone |

The subtree walk listened on the request, where `close` means "the request stream is done being
read". A reviewer measured it about a millisecond into a 300 ms handler: the walk cancelled
itself. On a GET with no body there is nothing to consume, so it fired early; had it not, the
cancel would have been dead code. `ServerResponse`'s `close` is the one that distinguishes a
lost connection from a finished answer, and `writableEnded` is what tells the two apart on that
event — which is why the handler has to look at both.

## Goals / Non-Goals

**Goals:**

- A tick that fails for any reason is followed by another tick.
- No work a route throws away, and no route answering from a half-read state.
- One guard per finding, each of them readable in the place the finding lives.

**Non-Goals:**

- Backoff, jitter or a failure counter. The cadence is a configured one and a second failure
  mode of its own; this change only makes the loop survive what it already had.
- Cancelling the *other* routes' work. Only the subtree walk is walk-shaped, and only it was
  written to be cancellable.
- A test HTTP server. The route handlers take a request and a response, and driving them
  directly is what the suite already does; the one thing a stub could not express was the
  response's `close`, so the stub grew it.

## Decisions

- **D1 — The loop reschedules after the `await`, and `refresh()` no longer rejects.** The tick
  became `async` and the rescheduling moved out of `.then()`: a rejected promise never runs a
  `.then()` continuation, so anything that must happen after *every* poll cannot live in one.
  The failure itself is reported from the tick's own `catch`, and `resolveKey()` moved inside
  `refresh()`'s `try` so a service that cannot be read is one of the failures the loop already
  knew how to survive rather than the only way to leave it.

  The alternative — a `.catch()` before `.then()` — reaches the same place and leaves the
  rescheduling in a continuation, where the next failure mode (something throwing between the
  two) has to be thought about again. Rejected alternatives: re-arming on a bare timer without
  awaiting the poll (the loop would then overlap its own polls on a slow network, which
  `inflight` was added to prevent), and a `setInterval` (the `api-key-missing` retry delay is
  shorter than the cadence, so the period is not constant).

- **D2 — `HEAD` answers before anything is built.** The `HEAD` branch moved above
  `buildPayload()`. It still answers `200`, which is the status the spec promises, and it still
  marks the answer `no-store`; it simply stops doing a full ledger build, the two `Intl`-backed
  tariff payloads and a session read for a request whose body is thrown away by the protocol
  anyway. It also no longer waits for the load: there is no state in the answer to be stale.

- **D3 — The subtree walk cancels on the response's `close`, and only before the answer.**
  `res.on('close', …)` replaces `req.on('close', …)`, and the handler checks
  `res.writableEnded` before aborting, so a response that finished normally and then closed is
  not mistaken for a reader who left. The listener is removed in the `finally` as before, which
  also keeps the closure from outliving the walk. A stub that cannot emit `close` cannot test
  any of this, so the response stub in the suite is now an `EventEmitter` with a
  `writableEnded` that `end()` sets — the two members the route actually reads.

- **D4 — The body limit counts bytes.** `body.length` counts UTF-16 code units, so a
  1 MB limit was about 260 000 CJK characters or a million emoji. `Buffer.byteLength(body)` is
  the number that is compared against a limit in the spec's spirit (bytes off the wire) and is
  the same measure `sendJson` already uses for `Content-Length`, so the two ends of a route now
  agree. Accumulating `body` as a string and measuring per chunk is kept rather than switching
  to byte counting across chunks: it is one extra pass over at most a megabyte, on a path that
  is already dominated by the JSON parse.

- **D5 — `resetLoop()` asks whether the loop is still wanted.** `loopStopped` is the flag the
  effect's disposer sets, and the check is the first thing `resetLoop()` does. The race is a
  settings write in flight when the plugin is disposed: the route still runs (it is already
  inside the handler), it still stores the setting, and re-arming there would leave a timer that
  the disposer has already run past. Storing the setting is right — the user asked for it and
  it is on disk for the next start — so the guard is only on the timer.

- **D5b — Each arming of the loop takes a number, and a stale tick does not re-arm.** The
  `loopStopped` guard above is about a loop that is finished for good; this is about one that
  is still wanted but has just been restarted. `resetLoop()` can cancel a *pending* tick, not
  one already `await`ing its poll, and a settings write that changes the cadence in that
  window is ordinary rather than exotic. The tick that was awaiting the poll then came back,
  cleared nothing — its own timer had already fired — and armed a second timer on top of the
  one the restart had just armed. `loopTimer` holds one handle, so from that point on the
  second loop was unreachable: the plugin polled twice per interval and wrote twice per tick,
  and the disposer could only ever clear one of the two. A counter fixes it in the place the
  arming happens rather than by trying to cancel a poll already in flight: `resetLoop()`
  increments it, the tick captures its own value, and the reschedule is conditional on the two
  still agreeing. Cancelling the in-flight poll instead was rejected — it would abandon a poll
  that is about to record a real sample, and `refresh()` shares one promise between the loop
  and the refresh route, so the reader waiting on that route would be left with nothing.

- **D6 — The refresh route waits for the load, like every other route that reads state.** With
  no API key `refresh()` returns before its own `if (!loaded) await ready`, so the route used
  to build its payload while the read of the log was still in flight: `host.loaded: false`,
  `samples: 0`, an all-zero ledger, next to months of history on disk. The read route, the
  session routes, the heartbeat, the override route and the settings route all had this guard;
  the refresh route was the one that did not, and it is the one the panel's own refresh button
  calls.

## Risks

- The tick's `catch` is now a second place a poll failure is reported from, next to
  `refresh()`'s own. With `resolveKey()` inside the `try`, `refresh()` handles everything it
  can see, so the outer one should stay quiet; if it ever does fire, the message says which
  poll it was, and the loop keeps running either way.
- The new tests drive the loop with mocked `setTimeout`, and the loop is the one thing in the
  plugin that can outlive a test. Each of them disposes the context in a `finally` before it
  resets the timers, which is what the existing disposal-race case already does.
