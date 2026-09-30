# Tasks

## Root cause

- [x] Reproduce every named case, or establish why it cannot be reproduced here
- [x] Classify each as a test defect, a shim defect or a plugin defect
- [x] Confirm nothing in `src/` derives a duration or an interval from the ambient clock

## Event-based waits

- [x] `eventually(reached, what, turns)` — pump the real event loop until a condition holds
- [x] `ticking(t, reached, what, stepMs)` — the same over a mocked clock, for the loop cases
- [x] `readStateWhen(home, reached)` — read `state.json` until it says what is being waited for
- [x] `the subtree walk stops when the reader goes away` — wait on the walk announcing itself
- [x] `a settings write during a poll in flight` — wait on a poll and on the re-arm, assert one poll per interval
- [x] `the sampling loop stops for good when the plugin is disposed` — wait on the fetch and on the sample landing
- [x] `the sampling loop asks again after a poll that rejected` — use the shared helpers
- [x] `the client heartbeat that lands during the load` — `readStateWhen`, no sleep loop
- [x] `the client hello route records the browser half on disk` — `readStateWhen`, no sleep
- [x] `the log is thinned in the zone the reader stored` — a route call is the load's completion event
- [x] `an override from the previous release gets its balance anchor back` — same
- [x] `a write that arrives while the state is still loading` — the awaited persist is the event; drop the sleep

## The hard-coded date

- [x] Reproduce `two corrections written at the same time` failing under a pinned 2026-09-01
- [x] Take both day keys from the ledger rows, and assert they differ

## The two budgets

- [x] Measure the linear and O(n²) ratios under load, to place the thresholds on evidence
- [x] `detection …` — ratio of 20 000 to 80 000 Steps, interleaved, min of runs, threshold 12
- [x] `the stream stays linear …` — ratio of 10 000 to 40 000 Steps, same shape
- [x] Report the absolute milliseconds as diagnostics
- [x] Prove both go red on a deliberate O(n²) change in a scratch copy

## Gates

- [x] `npm test` in the worktree
- [x] (a) the ambient clock
- [x] (b) the guard's four pinned instants
- [x] (c) `TZ` across seven zones
- [x] (d) twelve concurrent copies of the whole suite, and six concurrent guard runs
- [x] knip + jscpd in a scratch copy with its own `node_modules`
- [x] `nix flake check` in the worktree
- [x] `openspec validate --all`
