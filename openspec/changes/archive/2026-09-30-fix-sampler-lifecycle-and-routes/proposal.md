# Proposal

## Why

Six defects in `src/index.js`, all found on review, all in the paths that run unattended:
the sampler's own re-arming after a failed poll, and the four routes the browser half and a
health probe call. The most expensive one is the sampler: a poll that rejected took the whole
loop down with it, so a Host that hit one unreadable service stopped sampling for the rest of
its life and said so only through an unhandled rejection. The rest are smaller and equally
invisible — a `HEAD` probe pays for a full ledger build and throws it away, the subtree walk
cancels itself a millisecond in because it listens to the wrong `close`, a `HEAD`-less
connection is not a disconnect at all, a settings write that races disposal arms a timer
nothing clears, the 1 MB body limit is 1 MB of characters (so roughly 4 MB of CJK or emoji
gets through), and a refresh answered while the stored state is still being read reports an
empty history and an all-zero ledger over months of samples on disk.

## What Changes

- The sampling loop reschedules its next tick whatever a poll did, and a poll that rejects
  (a credentials service that cannot be read, say) is reported as a failed poll rather than
  escaping the loop; the key resolution moved inside `refresh()`'s `try` so it is one of those
  failures instead of a rejection with no handler.
- `HEAD /dsh-balance` answers its status without building the payload — no ledger, no tariff
  windows, no rate table, no session read.
- The subtree walk watches the response's own `close` and treats it as a disconnect only
  while nothing has been written, so a reader who closes the Cost view stops the walk and a
  request whose body has been consumed does not stop itself.
- `resetLoop()` refuses to arm anything once the plugin is disposed, so a settings write
  racing the disposal cannot leave a timer behind.
- The request body limit is measured in bytes, so multi-byte text no longer slips past it.
- `POST /dsh-balance/refresh` waits for the stored state to be read before it builds its
  answer, the same way the read route does, so a refresh during start-up reports the history
  on disk instead of zeros.
- One test per finding in `test/plugin-host.test.js`, each of which fails against the code as
  it stands today.

## Capabilities

### New Capabilities

<!-- Capabilities being introduced. -->

- none

### Modified Capabilities

- `balance-tracking`: the sampler keeps running after a poll that rejected; a `HEAD` read
  costs no payload build; a refresh during the start-up load reports the loaded history.
- `session-cost-analysis`: the subtree walk is cancelled by the reader's connection closing,
  and by nothing else.

## Impact

- `src/index.js` — the loop, the three route handlers, and the body reader.
- `test/plugin-host.test.js` — the response stub grows the `close` event and `writableEnded`
  a real `ServerResponse` has, plus six cases; no existing case changes.
- No new dependency, no change to any payload shape, and no change to any figure a ledger
  reports — the payload the browser already got is the payload it gets now, just not built
  when nothing is going to read it.
