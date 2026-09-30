# Design

See `proposal.md` — Why.

The facts that shape the approach:

- The three maps are declared at module scope inside the module factory
  (`client/client.js:2888`, `:3053`, `:3062`), so there is exactly one of each per loaded
  page, and they are the only module-level `Map`s in the file that are keyed by session id
  and outlive a component. The others found by a search for `new Map()`
  (`visibleAt`, `marks`, `at`, `byTurn`, `spawnTimes`, `byParent`, the one inside
  `subtreeOf`) are all built inside a render or a call and are collected with it.
- They are written from three different places, and what a lost entry costs differs in each:
  - `sessionPrompts` is written once per session by `promptForNode` (`client.js:2908`) and is
    read only there. It is a pure memo of `readText(sessionId)`: the route is still there, the
    request is the same one the first preview made, and the answer is the same words. Nothing
    is derived from the entry; the caller only ever learns whether it was a hit or a miss.
  - `lastStep` is written by `select` (`client.js:3169`) and deleted by `select` and
    `setWindow`. It is read in exactly one place, the `useState` initializer at
    `client.js:3074`. A mounted Cost view therefore does not consult the map again: the mark
    it shows is its own hook state, and the map is the hand-off across an unmount (the
    Trajectory round trip the comment above it describes). Losing the map entry cannot
    unmark a mounted view; it can only fail to re-mark the *next* mount of that session.
  - `subtreeReads` is a counter, not a cache (`client.js:3062`). `loadSubtree` takes the next
    number for the session before awaiting and compares it after, so that a slower older read
    does not land on top of a newer answer. The entry is worthless between reads: the next
    read for that session takes `(get ?? 0) + 1` and works with a counter that started at
    zero just as well.
- The reader-visible working set is one or two sessions: the conversation mounts only the
  selected view (`client.js:4667`), the Cost view of a subagent is reached by an explicit
  "follow into its own Cost view" and opens a *different* conversation, and the Cost tab is
  selected lazily. So a cache that is asked about a fourth and fifth session in the same tab
  is being asked about sessions the reader is no longer reading.

## Goals / Non-Goals

**Goals:**

- No entry survives for the life of the page without a reason.
- The Cost view, the subtree read and the prompt preview return exactly what they return
  today for any realistic number of sessions.
- No entry that a mounted component depends on can be dropped out from under it.
- The rule is written once, and each cache says in a comment what its number is for.

**Non-Goals:**

- A general LRU class. There are two size-bounded caches, one helper, and the third cache
  needs a different rule entirely; a class with configurable policy would be a shape the
  file does not have anywhere else.
- Persisting any of the three. The JSDoc above `lastStep` already says this is page memory
  and not a setting; making it survive the page would be a new behaviour, not a fix.
- Touching the other module-level maps. They are per-render, not per-page, and the review
  named three.

## Decisions

**Two caches are bounded by size, and the third by lifetime.** `sessionPrompts` and
`lastStep` answer "what did this session look like", and the answer is worth keeping for a
while: a size bound with LRU eviction. `subtreeReads` answers "is the read I am holding
still the newest one for this session", which is only true while a read is in flight, and a
size bound there is actively wrong — see the next decision.

**`subtreeReads` is released when its read lands, not evicted by size.** The counter exists
solely to be compared after an `await`. Once the newest read has settled, nothing will ever
compare against that number again, so the entry is dropped in a `finally` — guarded by the
same `subtreeReads.get(sessionId) === read` test, so a read that was superseded does not
delete the *newer* read's counter. That bounds the map by concurrency rather than by size:
at most one entry per session with a read in flight, and the shell mounts one Cost view, so
in practice the map holds zero or one entries. A size bound here would have to be either
large enough to be fiction or small enough to lose a read, and the task names losing a read
as the outcome to avoid: a counter evicted between `set` and the comparison would make the
comparison read `undefined !== read` and drop the answer the reader is waiting for, leaving
the panel on "loading" forever. Releasing on settle cannot do that, because the release
happens after the comparison that guards it.

**`MAX_PROMPT_SESSIONS` is 4, because this cache holds text.** It is the only one of the
three that retains message content, and the reason to keep a session's words is that the
reader is in that session asking what a Step answered. A reader switching between a couple of
sessions at a time — the session they are reading, and a subagent they just followed into —
never reaches four. When they do, the cost is one refetch of the same route for a session
they are only now returning to; the preview was always an explicit action with a visible
loading state, so a refetch is a longer wait on a button the reader pressed again, not a
flash: no previously rendered text is replaced or cleared, because the text lives in the
inspector's own state and is only written when a load resolves.

**`MAX_STEP_SESSIONS` is 16, because this cache is nearly free and losing it is annoying.**
Each entry is `{ turn, step }`. Memory is not the constraint, so the number is set by how
long a mark should survive: a reader who has marked a Step in sixteen sessions since is
working in a way this plugin does not model, and coming back to the first unmarked is the
same as having never marked it. The mark of the session currently on screen cannot be
evicted out from under the reader, because the mounted view holds it in hook state and the
map is read once, at mount — the only thing an eviction costs is the mark on a *later* remount
of an old session.

**Recency is refreshed by the write, not by the read.** `rememberRecent` deletes the key
before setting it, so re-inserting an existing key moves it to the newest position. That is
what makes the bound mean "recently touched" rather than "recently created": a reader who
keeps selecting Steps in one session keeps that session's entry fresh however many other
sessions pass. The reads do not touch recency — a read that a component performs on mount is
the same event as the write that will follow it, and refreshing on read would make a
component that renders in a loop push other sessions out.

**One helper, used twice, with the limit as an argument.** The eviction is three statements
(delete the key so the set order is right, set it, drop the oldest while over the limit). Two
copies of that is where a later fix would land in one copy and not the other, and the file is
large enough that the reviewer will not read the third `Map` twice. The limit is a parameter
rather than a constant read from inside the helper so that the number and the reason for it
stay at the cache, next to the JSDoc that says what the cache is.

**The helper is exported for the tests, alongside the maps it fills.** The eviction rule *is*
the size of the map, so a test that cannot see the map can only see a refetch — which
proves the miss, not the bound. The test needs the map to state that at most N entries are
held and that the oldest of N+1 is the one that went.

## Risks / Trade-offs

- [A reader with more than 4 sessions in a tab loses a prompt cache hit] → The miss is one
  `GET /dsh-balance/session-cost/text` for the session being previewed, which is the same
  request the first preview made. The prompt is only ever shown after an explicit click that
  already enters a loading state, so the worst case is a slower answer to a button the reader
  pressed, and the text is identical.
- [A reader with more than 16 marked sessions loses a mark] → The session comes back with
  nothing selected, which is a state the view already has for a session the reader never
  marked in. No error, no flash; the Steps are all still there and the mark is one click away.
- [A subtree read could be lost if the release ran before the comparison] → It cannot: the
  release is in a `finally` that runs after the `try`/`catch` bodies, and it repeats the
  comparison before deleting, so a superseded read leaves the newer counter alone. This is
  the one place where a wrong order would strand the panel on "loading", so the test for it
  drives two overlapping reads and asserts the newer answer is the one on screen.
- [jscpd flags the repeated `subtreeReads.get(sessionId) !== read` guard] → That expression is
  already in the file twice, in the `try` and the `catch`, and the release adds a third
  occurrence of a different shape (`=== read`). If the gate objects, the honest fix is a
  local `const current = () => subtreeReads.get(sessionId) === read` predicate rather than
  duplicating the read; the gate is re-run before the PR.
- [A bound is a guess about readers] → It is a guess, and the cost of being wrong is measured
  above: a refetch, or an unmarked Step. Both are states the view already reaches. A wrong
  guess in the other direction — an unbounded map — is the reported finding.

## Migration Plan

None. The three maps are page memory that was never persisted and is not read by the Host.
Nothing stored changes, nothing is republished, and reverting the commits restores the old
behaviour exactly.

## Open Questions

None.
