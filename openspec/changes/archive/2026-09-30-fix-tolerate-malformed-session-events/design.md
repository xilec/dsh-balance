# Design

## Context

See `proposal.md` — Why.

The facts that shape the approach:

- The series is defined by the spec as **one node per `(Turn, Step)` location**. Every
  location-addressed fold arm — `step/start`, `step/end`, `llm/retry-started`, `tool/call`,
  `assistant/message`, `assistant/attempt` — therefore needs a valid location to have anywhere to
  put its result, and `nodeSchema` declares `turn` and `step` as
  `z.number().int().nonnegative().nullable()`. A location is therefore exactly "a non-negative
  integer pair", and that is the same predicate `withCompaction` already applies to the Turn a
  compaction names (`Number.isInteger(data.turn) && data.turn >= 0`).
- `turn: null` is *not* a valid location for a Step, and the spec says why: `null` on a node
  belongs to a Compaction step, which "belongs to no Step, and to no Turn when none precedes it".
  A Step node with no Turn is a thing the spec does not describe, so an event without a usable
  location has no node to become.
- The series is not "one node per priced Step". `openNode` is called by `step/start` before any
  usage exists, and the spec's in-progress and `hasUsage` scenarios depend on a node being there
  with `hasUsage: false`. So a located `step/start` with no usage must keep opening its node;
  only a *missing location* may be skipped.
- `withCompaction` is already tolerant: it reads `event.data ?? {}`, requires a non-empty string
  `compactionId` and returns the state unchanged otherwise, and it takes the model from
  `state.model ?? 'unknown'` when the event names none. It is the pattern the rest of the fold
  is missing, not the other way round.
- `describeNode` and every reader in `src/indicators.js` consume the output of `seriesPayload`,
  and `describeNode` builds each field it exposes (`kind`, `cost`, `buckets`, `hasUsage`,
  `retries`, `turn`, `step`, …) rather than passing a node's own fields through. A missing field
  therefore cannot reach the Indicators from a malformed log event.
- `projectionStateOf` folds with `events.reduce(...)`, so a single throw loses the whole session;
  the spec's own scenario for an unreadable *child* expects the remaining lines to survive, which
  it does at the `childrenPayloadOf` level — the loss this change removes happens one level
  below that, inside the fold.

## Goals / Non-Goals

**Goals:**

- One rule, applied at one place, that every location-addressed fold arm shares: read `event.data`
  defensively, and require a valid `(turn, step)` before touching the series.
- Malformed input degrades; a bug does not. The distinction is made by an explicit shape check on
  the event's data, so a fault inside the fold still propagates to `projectionStateOf`'s `catch`
  and is reported as a session that cannot be read — which is what that `catch` is for.
- A located event keeps doing exactly what it does today, including opening a node with no usage.

**Non-Goals:**

- Changing what a compaction is, or folding `compaction/start` / `end` / `prune` into money. They
  carry none, and that is the spec's rule, not a tolerance gap.
- Retrying, quarantining or reporting skipped events to the reader. The spec's payload for a node
  is fixed, and a "skipped N events" field would be a new wire field nothing asked for. The
  invariant that matters — the session total is the sum of its nodes — holds without it.
- Migrating or repairing already-folded state. A state that a previous version wrote with an
  undefined `turn` fails `stateSchema` and the harness discards it by its own rules; this change
  stops such a state from being created, it does not resurrect one.
- Touching `src/index.js`, `src/indicators.js` or `src/export-text.js`. Their readers either
  already guard or only ever see `describeNode`'s output (see Context).

## Decisions

**One `dataOf` helper and one `locationOf` helper, and the fold arms use them instead of
dereferencing `event.data`.**

`dataOf(event)` returns `event.data` when it is a plain object and `{}` otherwise, which turns
every "no data at all" throw into the same empty-data case the partially-shaped events already
produce. `locationOf(data)` returns `{ turn, step }` only for a non-negative integer pair and
`null` for anything else — missing, `null`, a string, a float, a negative number, one half
present. `reduce` then reads each family through them: a family that needs a location returns the
state unchanged when `locationOf` gives `null`.

The alternative — a `try`/`catch` around `reduce` in `apply`, or around each arm — was rejected
because it cannot tell the two cases apart: a `TypeError` from `event.data.header` and a
`TypeError` from a corrupted state are the same exception at the same `catch`. One would silence
both, and the session would report an empty series instead of failing. The explicit check names
the input it rejects, so everything else still throws, and there is a test that says so.

**A missing location skips the event; a located event with no usage still opens its node.**

These are two different rules and conflating them would either lose visible Steps or invent
Steps. The spec's series is per `(Turn, Step)` location, so `step/start` with a good location
opens a node even when nothing was ever priced for it (`hasUsage: false`), and the in-progress
and top-K scenarios depend on that. But a node with `turn: undefined` is a state the schema
refuses, and no scenario describes a Step belonging to no Turn — `null` belongs to a compaction.
So the test is "is this a location at all", not "does this event carry usage".

**A usage report on an event with no location is dropped, not re-homed.**

The tempting alternative is to fold it into whatever node is pending. That would keep the money
and lose the truth: the report would be attributed to a Step that never made it, the sum
invariant would still hold arithmetically but the Step's own buckets, model and interval would be
wrong, and the reader would be looking at a fabricated chart. A session log missing a `(turn, step)`
on one settlement is a log the harness itself cannot place; the honest reading is that this
settlement is not attributable, and the spec's "no rounding error is introduced between the parts
and the whole" is better served by an exact, smaller sum than by an exact, wrong one.

**The same index predicate is shared with the compaction arm rather than written twice.**

`withCompaction` already had `Number.isInteger(data.turn) && data.turn >= 0` inline. Widening it
to a named `isIndex` and using it for `turn` and `step` keeps one definition of "an index this
series accepts" in the file, which is the point of a check that exists to be re-applied.

**`dataOf` accepts any object, including an array, and rejects everything else.**

The stored log is JSON read back from disk, so `data` is a plain object in every real case. The
check exists to turn a *missing* or non-object `data` into the empty case; deciding more — for
instance rejecting an array — would guard against an input the harness never writes and would make
the helper's contract harder to state.

**`withCall` and `withRetry` take the location instead of reading it themselves.**

`withCall` destructured `event.data` and `withRetry` read `event.data.turn` / `.step` at the call
site. Both already have a location argument in spirit — `withRetry(state, turn, step)` is called
that way already — so the fix is to pass the checked location in rather than to re-derive it
inside. `withCall` keeps reading `event.data` for the call's own fields (`name`, `callId`,
`arguments`), which `dataOf` has already made safe and which the spec's payload requires; a call
whose `name` is missing still becomes a call with an empty name, because the *call* is what the
event says happened and only the location is what the series cannot place it without.

## Risks / Trade-offs

- [An event family is added later and re-introduces the dereference] → The helper is the only way
  `reduce` is meant to reach into `event.data`, and the new tests are per family rather than one
  blanket case, so the next family added without it fails its own arm of the test.
- [A legitimate log carries a string or float `turn` somewhere] → `withCompaction` has always
  rejected those and the harness has always written integers; the wire view's `Turn` is an
  ordinal. If that ever changes it is a spec change, and the check is one predicate wide.
- [Dropping an unlocatable usage report loses real money] → It is money the log cannot attribute,
  and the alternative attributes it wrongly. Reported here rather than hidden; the alternative of
  a "skipped events" counter is left out of scope deliberately.
- [An explicit check is more code than a `try`/`catch`] → The check is two small helpers and one
  extra condition per arm. The `try`/`catch` is one line and wrong.
- [The state written by the previous version may already be unschema-valid] → It was going to be
  discarded by the harness on the next checkpoint regardless; the change stops the production of
  new ones and does not attempt a repair path for old ones.
- [jscpd flags the repeated `locationOf(...) === null` early return] → It is a different literal
  and a different arm each time; `npm run lint` in the scratch copy decides.
- [A blanket-catch regression slips in later] → The "a broken state still throws" test fails the
  moment anything wraps the fold, which is the point of having it.

## Migration Plan

None. The change is guards inside one pure function and tests. No stored state is rewritten, no
route or payload changes, and reverting the commit restores the old behaviour exactly.

## Open Questions

None.
