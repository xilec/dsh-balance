# Design

## The shape of the defect

Every case in scope fails the same way: it asserts on a quantity the machine supplies.

| what the test measures | what it means |
| --- | --- |
| a count of `setImmediate` hops | how much other work the event loop had queued |
| a wall-clock sleep, then a read | how fast the filesystem was |
| elapsed milliseconds against a ceiling | how fast the CPU was |
| a date written into the source | which day it happened to be |

Only the last is a plain wrong answer; the other three are right on one machine and wrong
on another, which is worse, because the failure arrives as a colleague's red build with no
hint that the build is innocent.

The plugin is not involved. Its poll cadence is `runtime.refreshIntervalMs` and its loop's
first delay is a literal `500` (`src/index.js:554`); the re-arm takes `runtime.refreshIntervalMs`
or `30000` for a missing key (`src/index.js:551`). Nothing in `src/` derives a duration from
`Date.now()`. `Date.now()` appears in `src/` only to *stamp* things — a sample's instant, an
override's `at`, the payload's `now` — never to decide how long to wait. So no `src/` change
is warranted and none is made.

## Waiting on events

Two helpers, both in `test/plugin-host.test.js`:

- `eventually(reached, what, turns)` — pump the real event loop until `reached` holds.
  `reached` is awaited, so it may be async. `turns` (20 000) is a backstop against hanging;
  failing through `assert.fail` with `what` in the message is what a genuine hang should say.
- `ticking(t, reached, what, stepMs)` — the same, but advance a mocked clock one step at a
  time first, so a mocked `setTimeout` is given the chance to fire.

The rule these encode: **a test may wait for work, never for time.** The turn count is
invisible to every assertion; it only decides how long a *broken* build takes to be told so.

A third helper, `readStateWhen(home, reached)`, is the file-shaped version. The heartbeat
route persists without awaiting, so the state document is the only place its write is
visible, and a test that wants to see it has to go on looking. It reads once per event-loop
turn and never sleeps: the loop costs exactly as many turns as the write needs.

### Why the poll case cannot simply tick more

`a settings write during a poll in flight does not arm a second loop` counts polls over a
fixed span of mocked time. Under load it read `1 polls` where it expected four. A poll ends
in a real `appendFile` to the sample log (`src/index.js:418`), and the number of event-loop
turns that write occupies is the filesystem's, not the test's — so on a slow machine the
mocked clock ran through sixty seconds of cadence while one poll was still in flight.

The case now waits on the two events the loop actually produces: a poll, and the arming that
follows it. `live.size === 1` after each is the real assertion — a second loop would leave
two timers armed — and the poll count is checked for exactly one per interval rather than
for a range.

## The two budgets

Both are kept, because a budget that catches an algorithmic regression is worth having. What
changed is *what* is compared.

**Formulation: a ratio between two sizes of the same work, measured in one interleaved loop.**
Four times the Steps must not cost sixteen times the work. The threshold sits between the
two readings with room for each:

| case | sizes | linear, 12 concurrent copies | deliberate O(n²) | threshold |
| --- | --- | --- | --- | --- |
| `detectFindings` | 20 000 → 80 000 | 3.1 – 6.1 | 30.7 – 34.8 | 12 |
| `costHistory` | 10 000 → 40 000 | 3.1 – 6.7 | 16.0 – 16.9 | 12 |

Three details make the ratio hold up under load, and each was arrived at by measurement:

1. **Interleaved.** The two sizes are timed alternately in one loop, so the machine the small
   series was timed on is the machine the large one was. Measuring one size entirely and then
   the other lets a burst of load land on one end of the ratio and not the other.
2. **Minimum of several runs.** A minimum is the only summary of a noisy measurement that a
   slower neighbour cannot inflate.
3. **Both sizes long enough to time.** A series measured in a fraction of a millisecond is a
   measurement of the scheduler, not of the code. An earlier attempt used 2 000 Steps against
   20 000 and read ratios of 30 – 64 on a loaded machine purely from noise at the small end;
   20 000 Steps is a ~15 ms measurement and the ratio settled.

**Rejected alternatives.**

- *Raise the ceiling to whatever a loaded machine needs.* A test that passes because it waits
  longer is still a test that will bite, and the ceiling would have to be set by the slowest
  machine anyone runs CI on.
- *Mark the assertion non-gate and report only.* That gives up the regression detection
  entirely, which is the one thing the case is for.
- *Derive the budget from a machine-independent count.* There is no such count to derive it
  from here: `detectFindings` and `costHistory` are opaque pure functions of a series, so
  the only machine-independent statement available is about how cost grows with size. That is
  the ratio.

The absolute milliseconds are still reported through `t.diagnostic`, so a change that made
the code uniformly 100× slower would be visible in the test output even though it does not
fail the build. That is a deliberate trade: the regression class these cases exist to catch
is the *algorithmic* one, and the machine-dependent latency question is answered by reading
the diagnostic rather than by a gate that fires on a colleague's laptop.

One incidental finding: the export case measured with `Date.now()`. That is not a defect
here — the clock shim *shifts* the clock by a constant rather than freezing it, so
`Date.now()` differences remain real elapsed time under it — but `process.hrtime.bigint()` is
monotonic and immune to any future shim that does freeze, so both cases use it now.

## The hard-coded date

`two corrections written at the same time both land on disk` wrote one correction to
`ledger.todayKey` and the other to the literal `'2026-09-01'`. On a day that literal names,
the two writes address the same day, the second overwrites the first, and the assertion
`state.overrides[today].amount === 1.5` reads `2.5`. Reproduced by pinning the clock to
`2026-09-01T10:00:00Z` and `2026-09-01T22:00:00Z`; both fail, `2026-09-02` passes.

It is the same defect `fix/t7` (PR #19) fixes in its own new test, one screen away in the
same file. The fix is the one the sibling case `a state write that cannot land is reported
and does not wedge the next one` already uses: both day keys come from the ledger rows the
Host serves. `rows.at(-1)` and `rows.at(-3)` are inside the rolling window whatever day it
is, and they are two different days — the case additionally asserts they differ, because
"both land" needs two addresses.

## What was left alone

- `test/clock-shift.test.js` and `test/fixtures/clock-shift.mjs` are untouched. The guard is
  correct; what it was catching is what changed.
- The other two mock-timer loops in `plugin-host.test.js` that were already waiting on a
  condition with a turn-count backstop were converted to the shared helpers for consistency,
  but they were not failing.
- `test/client.test.js` has ~45 short `setTimeout(resolve, 10)` naps. They were not in scope,
  none of them failed under twelve concurrent copies, and they drive a browser-side store
  whose settle points are not observable from the test. Left as they are.
