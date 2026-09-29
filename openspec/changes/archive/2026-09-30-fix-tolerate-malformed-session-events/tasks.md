# Tasks

## 1. Give the fold one shape check

- [x] 1.1 In `src/session-cost.js`, add `dataOf(event)` (returns `event.data` when it is an
  object, `{}` otherwise) and `isIndex(value)` / `locationOf(data)` (a non-negative integer
  `turn` and `step`, else `null`), with a JSDoc saying why bad input must be separated from our
  own bug; verify that `withCompaction` can be rewritten to use `isIndex` instead of its inline
  `Number.isInteger(data.turn) && data.turn >= 0`
  — done: `dataOf` and `isIndex` sit with the other module-level helpers above the fold,
  `locationOf` composes them into the `(turn, step)` pair, and `withCompaction` reads
  `const named = isIndex(data.turn) ? data.turn : null`
- [x] 1.2 Route every arm of `reduce` through them: `request/header` and `request/context` read
  `dataOf(event).header?.config?.model` and `dataOf(event).model`; `step/start` and `step/end`
  return the state unchanged when `locationOf(event.data)` is `null`; `llm/retry-started` does the
  same; `assistant/message` / `assistant/attempt` do the same before touching the pending node
  (including the `interrupted` flag); `tool/call` goes through `withCall`
  — done: each arm reads `const data = dataOf(event)` once, the four location-bearing families
  bail on a `null` location, and the two model arms keep their existing non-empty-string test;
  `withSpawn` and `usageOf` read the same way
- [x] 1.3 Fix `withCall` and `withRetry` at the call sites named by the brief: `withCall` must not
  destructure `event.data` unguarded, and `withRetry` must receive the checked location
  — done: `withCall(state, event, at)` takes the location the caller checked, reads the call's
  own fields through `dataOf(event)`, and `reduce` skips the event when the location is `null`
  before calling it; `withRetry(state, turn, step)` already had that shape and now gets checked
  values

## 2. Prove the tolerance and keep the failure loud

- [x] 2.1 Add a case per event family in `test/session-cost.test.js` that folds an event with no
  `data` at all, next to a priced session, and asserts the rest of the series is still priced
  with the sum invariant intact
  — done: one case folds the data-less events of all ten families between two priced Steps and
  asserts `Σ nodes === view.cost`, both Steps' costs, the Step count, and that the result still
  passes `stateSchema`; it fails on `HEAD` with the reported
  `Cannot destructure property 'turn' of 'event.data'`
- [x] 2.2 Add the partially shaped cases the brief names: a `request/header` whose `header` holds
  no `config`, a `request/context` with no `model`, a `step/start` with a `turn` but no `step`, a
  `step/start` with a `null` turn, a string turn and a negative step, and an `assistant/message`
  whose location is fine but whose Turn was never opened — asserting each contributes nothing and
  the sum still holds exactly
  — done: the second case walks all of them plus a compaction naming an unusable Turn, and
  re-asserts the invariant, the node count and the schema
- [x] 2.3 Assert that a *located* `step/start` with no usage still opens a node, so the tolerance
  did not turn "no usage" into "no node" and silently redefine the series
  — done: the case in 2.2 asserts a `hasUsage: false` node survives between the two priced ones
  and that `view.steps` counts it
- [x] 2.4 Add the test that keeps a real fault loud: a state whose own internals are broken must
  still throw out of `apply` rather than fold into an empty series
  — done: one case folds into a state whose `byModel` is `null` and asserts `TypeError`, and one
  asserts a throwing config reader propagates; a future blanket `try`/`catch` fails both
- [x] 2.5 Prove the fix reaches the routes, not just the unit: a session read from a stored log
  holding one malformed event must answer the series route with a priced series rather than
  `unknown-session`, and must appear in the subtree as a priced child line rather than an
  `unavailable` diagnostic
  — done: `test/plugin-host.test.js` gains a case driving both routes; on `HEAD` the series route
  answers `{"ok":false,"error":"unknown-session","detail":"Cannot destructure property 'turn' of
  'event.data' as it is undefined."}`, which is the finding

## 3. Check the same defect class in the readers

- [x] 3.1 Confirm `src/indicators.js` cannot be reached by a malformed log event: read every
  `node.` access and confirm each field it reads is built by `describeNode` rather than passed
  through from a stored node; report rather than fix if the check fails
  — done: both `detectFindings` call sites in `src/index.js` pass `seriesPayload` output, and
  every field `detectFindings` reads (`cost`, `buckets`, `hasUsage`, `unpriced`, `retries`,
  `turn`, `step`, `kind`) is constructed in `describeNode`; the two optional reads already use
  `?.` and `?? 0`
- [x] 3.2 Confirm `src/index.js`'s `projectionStateOf` and `childrenPayloadOf` `catch` sites are
  the spec's "cannot be read" behaviour and must stay, and that the fix removes the reachable
  trigger rather than changing the reporting
  — done: no change made; both `catch` sites stay as the spec's scenario describes, and the case
  at 2.5 drives the routes that call them
- [x] 3.3 Confirm `src/export-text.js` already reads `event.data ?? {}` and needs no change
  — done: line 48 already defaults it, and every nested read is optional-chained

## 4. Gates

- [x] 4.1 `npm test` in the worktree: 284 pass, 0 fail, up from 279 with no case removed
- [x] 4.2 `npm run lint` (knip + jscpd) in the scratch copy under `tmp/lint-t5`: knip clean,
  jscpd 0 clones
- [x] 4.3 `nix flake check` in the worktree: all checks passed
- [x] 4.4 `openspec validate --all`: 7 passed, 0 failed
