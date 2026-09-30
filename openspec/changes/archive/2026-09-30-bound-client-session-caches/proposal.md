# Proposal

## Why

Three module-level `Map`s in the browser half are keyed by session id and never forget:
`sessionPrompts` holds every `user_message` text of every session whose prompt the reader
ever previewed, `lastStep` the Step the reader last opened, and `subtreeReads` the newest
subtree read counter. All three live for the life of the page, so a tab left open across a
long working day accumulates one entry per session touched, and `sessionPrompts` in particular
retains message text that nothing will read again. A reviewer flagged this; the fix is a bound
and an eviction rule per cache, not a new feature.

## What Changes

- `sessionPrompts` becomes a least-recently-used cache of at most
  `MAX_PROMPT_SESSIONS` (4) sessions. It holds message text — the heaviest of the three — and
  the reader works in one session at a time, previewing a prompt in the session they are
  reading and occasionally in a subagent they just followed into; four is several times that
  working set. An evicted session is refetched from `/dsh-balance/session-cost/text` the next
  time a prompt is asked for, which is the same request the first preview made, so the reader
  sees the same explicit "read the words" action and the same text — one extra round trip in a
  tab that has been open across 4 other sessions.
- `lastStep` becomes a least-recently-used cache of at most `MAX_STEP_SESSIONS` (16) sessions.
  The entry is a `{ turn, step }` pair, a few bytes, so the bound is set by what losing it
  costs rather than by memory: a reader who has opened 16 sessions since marking a Step will
  come back to it unmarked, which is exactly the state of a session they never marked. The
  marked Step of a session whose Cost view is *mounted* is unaffected — it lives in that
  component's own state, and the map is only consulted on mount.
- `subtreeReads` is not bounded by size. Its entries are counters that exist only to order
  two overlapping reads, and dropping one mid-flight would lose a read the reader is waiting
  for. Instead the counter is released as soon as the read it names has landed, so the map
  holds at most one entry per session with a read in flight — which is one, because the shell
  mounts the Cost view of one session at a time.
- One helper does the eviction for the two size-bounded caches, so the rule is written once
  and the two differ only in their limit.
- Test cases in `test/client.test.js`: one per cache, each inserting more than the bound and
  asserting that the oldest entry is gone, the newest is still there, and that the
  reader-visible path (prompt text, marked Step, subtree answer) still returns what it
  returned before the eviction.
- No delta specs: a bounded cache changes no requirement — nothing a reader can reach
  changes. See `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None. `openspec/specs/session-cost-analysis/spec.md` describes what the Cost view shows; how
many sessions the client remembers on the way to showing it is an implementation detail, and
the reachable behaviour is identical.

## Impact

- Modified: `client/client.js` — the three `Map` declarations and their JSDoc, one new
  `rememberRecent` helper, and the two extra `finally` lines that release a subtree-read
  counter. Nothing else in the file is touched, and no neighbour is reformatted.
- Modified: `test/client.test.js` — three new cases beside the existing prompt, Trajectory
  round-trip and subtree cases; every existing case is unchanged.
- No new dependency, no HTTP or payload change, no new copy, nothing persisted. The evicted
  state is page memory that was already documented as page memory.
