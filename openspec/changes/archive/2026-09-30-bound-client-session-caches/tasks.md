# Tasks

## 1. Bound the two size-keyed caches

- [x] 1.1 Add one `rememberRecent(cache, key, value, limit)` helper in `client/client.js` that
  re-inserts the key (so the set order is recency) and drops the oldest entries while the map
  is over the limit; document why the reads do not refresh recency
  — done: the helper deletes the key before setting it again, so a session the reader keeps
  returning to moves to the newest position, and drops the oldest while the map is over the
  limit; the JSDoc says recency is the order of writing, not of reading, and that the reads
  that exist happen on mount right before the write that follows them
- [x] 1.2 Turn `sessionPrompts` into `rememberRecent` with `MAX_PROMPT_SESSIONS = 4`, and say
  in the JSDoc that the number is for the sessions whose words were read — the heaviest of
  the three — and what a refetch costs
  — done: `MAX_PROMPT_SESSIONS = 4` sits above the cache with a JSDoc naming the working set
  (the session being read, plus a subagent just followed into) and saying that past four the
  preview is the same `GET /dsh-balance/session-cost/text` the first one made; `promptForNode`
  writes through the helper and nothing else changed
- [x] 1.3 Turn `lastStep` into `rememberRecent` with `MAX_STEP_SESSIONS = 16`, and say in the
  JSDoc that the bound is set by what losing a mark costs, not by memory, and that a mounted
  view holds its own mark so only a later remount can lose it
  — done: `MAX_STEP_SESSIONS = 16` with a JSDoc saying an entry is a `{ turn, step }` pair so
  memory is not the constraint, and that an evicted session comes back unmarked — the state it
  is already in for a session never marked in; the JSDoc above the map also records that it is
  read once by the `useState` initializer, so a mounted view cannot lose its mark to an
  eviction
- [x] 1.4 Route the one `lastStep.set` in `select` through the helper, leaving the two
  `lastStep.delete` calls as they are — a deleted key needs no eviction
  — done: `select` calls `rememberRecent(lastStep, sessionId, named, MAX_STEP_SESSIONS)`; the
  `delete` in `select` and the one in `setWindow` are untouched, and `rg 'lastStep\.'` finds
  those two deletes, and no other writer of the map exists

## 2. Release the subtree-read counter on settle

- [x] 2.1 Delete the session's counter in a `finally` in `loadSubtree`, guarded by the same
  `subtreeReads.get(sessionId) === read` test, so a superseded read cannot delete the newer
  read's counter
  — done: the `finally` repeats the comparison and only then deletes, so a read that was
  superseded leaves the newer counter alone; it runs after the `try`/`catch` bodies, which is
  the order that matters, since an earlier release would let a comparison read as superseded
- [x] 2.2 Record in the JSDoc above `subtreeReads` why this map is bounded by concurrency and
  not by size, and what a size-based eviction would do to a read in flight
  — done: the JSDoc says a counter is only ever compared against the read in flight, that
  `loadSubtree` releases it once that read lands, and that a size bound would be wrong in both
  directions — an eviction between a read starting and its answer arriving would read as
  "superseded" and strand the panel on "loading"

## 3. Cover the three rules in the tests

- [x] 3.1 `test/client.test.js`: insert more than `MAX_PROMPT_SESSIONS` sessions through
  `promptForNode` and assert the oldest is refetched, the newest is not, and both still answer
  with their own text — the reader-visible path after an eviction
  — done: the case reads four sessions, then a fifth, and asserts the map holds four, that the
  oldest is gone and only the oldest, that the newest is held, that a held session asked twice
  is read once, and that the evicted session answers with its own words on a refetch; the stub
  gives each session its own text so a wrong session answering is caught
- [x] 3.2 `test/client.test.js`: mark a Step in more than `MAX_STEP_SESSIONS` sessions and
  assert the map holds at most 16 with the oldest gone, and that the newest session's Step is
  still marked after an unmount/remount round trip
  — done: the case marks a Step in sixteen sessions through the Cost view, round-trips one
  through `react.unmount()` and back to see the mark survive, marks a seventeenth, and asserts
  the size holds at sixteen with the oldest gone while the newest still comes back marked and
  the evicted one comes back unmarked
- [x] 3.3 `test/client.test.js`: two overlapping subtree reads still resolve to the newer
  answer, and the counter is gone from the map once the read has landed
  — done: the case clicks "Include subagents" twice from one tree so both reads are in flight
  with the slow one first, asserts the newer answer is on screen and the stale one did not land
  on top, that the counter is released once the read landed, and that a later read takes a
  counter again and releases it — the last part is the one that would catch a release placed
  before the comparison
- [x] 3.4 Run `npm test` in the worktree and confirm the count did not drop
  — done: 298 tests, 296 passing in the worktree, three more than the 295 on the branch base;
  the two failures (`the account currency replaces a preference the account does not have` and
  `a weekend session is priced off-peak even inside peak hours`) are the same two that fail on
  the base commit, which was confirmed by stashing the branch changes and re-running
- [x] 3.5 Run `npm run lint` (knip + jscpd) in a scratch copy under `./tmp/lint-t9` with its
  own `node_modules`; the worktree's `node_modules` is a kernel symlink and must not be
  replaced
  — done: knip reports nothing and jscpd finds 0 clones across the 5 files it analyses; the
  scratch copy has its own `node_modules` from `npm ci --ignore-scripts` and the worktree
  symlink was never touched
