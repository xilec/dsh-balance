# Tasks

## 1. Keep the sampler alive

- [x] 1.1 Move `resolveKey()` inside `refresh()`'s `try` and give the catch the api-key-missing
  branch's neighbour: a service that cannot be read becomes a failed poll, reported like any
  other, and never a rejection with no handler
- [x] 1.2 Make the tick `async` and reschedule after the `await` rather than in a `.then()`,
  with the failure reported from a `catch` of its own; verify a poll that rejects (a
  credentials service that throws when read) is followed by another poll on the configured
  cadence, and that a disposed plugin is still not polled
- [x] 1.3 Guard `resetLoop()` with `loopStopped` so a settings write that lands after the
  disposal cannot arm a timer; verify the setting itself is still stored and answered
- [x] 1.4 Number each arming of the loop and let a tick re-arm only while its own number is
  current, so a cadence change landing while a poll is in flight does not leave a second loop
  nothing owns; verify exactly one timer is armed after such a write, counting the live
  `setTimeout` handles rather than the polls, since two loops at one cadence poll the same
  number of times

## 2. Stop paying for what nobody reads

- [x] 2.1 Answer `HEAD /dsh-balance` with its status before `buildPayload()` runs, keeping the
  `no-store` header; verify a `HEAD` with a session id and an unreadable session store builds
  nothing, while the same `GET` does
- [x] 2.2 Add `if (!loaded) await ready` to the refresh route before it builds its answer;
  verify a refresh answered during the start-up load reports the samples and the ledger the log
  on disk holds, and makes no request when there is no key

## 3. Read the real disconnect signal

- [x] 3.1 Listen for `close` on the response instead of the request, and abort only while
  `writableEnded` is false; give the test response stub the `close` event and the
  `writableEnded` flag a real `ServerResponse` has
- [x] 3.2 Cover both directions: a connection that closes mid-walk cancels it, while a request
  whose body is merely consumed, and a request that was answered, do not; verify the case
  fails against the request-side listener

## 4. Measure the body in bytes

- [x] 4.1 Compare `Buffer.byteLength(body)` with the limit instead of `body.length`, keeping
  the per-chunk check; cover it with a body of multi-byte characters that is under the limit in
  characters and over it in bytes, plus a body inside the limit that is still accepted

## 5. Whole-change acceptance

- [x] 5.1 Run `npm test`, `npm run lint` (knip + jscpd, from a scratch copy with its own
  `node_modules` because the worktree links the dsh kernel) and `nix flake check` in the
  worktree; verify all are green, that no test was removed or weakened, and that each of the
  seven new cases fails against the code as it stood
- [x] 5.2 Run `openspec validate --all`, tick every item above, then archive the change with
  `openspec archive fix-sampler-lifecycle-and-routes --yes`; verify the archived folder and the
  updated specs are part of the branch
