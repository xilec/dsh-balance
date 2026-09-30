# Proposal

## Why

The clock guard from `fix/t2b` made the suite pass at four pinned instants on an idle
machine. On a loaded one it does not: two CI runs on unrelated branches went red with
`four intervals of a fifteen-second cadence: 1 polls` and `the walk runs under a signal of its
own`, and a review that ran six concurrent copies of the suite found five cases of one class.
Every one of them is a test measuring the machine instead of the code.

The class has three shapes, and it is worth naming which is which because only one of them is
a defect in the plugin:

- **A wait for a number of event-loop turns.** `the subtree walk stops when the reader goes
  away` polls `for (let index = 0; index < 20 && signals.length === 0; ...)` on
  `setImmediate`. Twenty turns is generous on a fast box and not enough on a slow one, because
  the route ahead of it does real work. The wait is a duration wearing a loop's clothes.
- **A wait for a wall-clock window.** `the client heartbeat that lands during the load does not
  blank the stored state` polls a 3 MB document every 20 ms for two seconds, and
  `the log is thinned in the zone the reader stored, not in UTC` sleeps 60 ms and then reads a
  file the load may not have rewritten yet. Both are the same defect as a too-short timeout:
  they pass because the machine was fast.
- **A wall-clock budget as a gate.** `detection over ten thousand Steps stays inside the Host
  budget` fails at 150 ms and `the stream stays linear` at 2000 ms. Under six concurrent copies
  the first one measures 288 ms on a change that is not a regression at all.

`two corrections written at the same time both land on disk` is a fourth shape and not a
timing problem at all: it writes one correction to `ledger.todayKey` and the other to the
literal `'2026-09-01'`. When the ambient or pinned day *is* 2026-09-01 the two writes name the
same day, the second overwrites the first, and the assertion on the first amount reads the
second. It is the hard-coded date `fix/t7` is fixing in its own new test, in the same file,
one screen away.

The plugin is not at fault in any of the five. Its poll cadence is a configured
`refreshIntervalMs` and its loop delay is a constant; nothing in `src/` is derived from the
ambient clock in a way that changes behaviour. This change therefore touches tests only.

## What Changes

- Tests that wait for a turn count wait for the **event** instead: the subtree walk waits on a
  promise the stub resolves, the poll-drain waits on the poll counter reaching the number the
  cadence implies, and the `drain()` helper lets the fake clock advance while it pumps the real
  event loop until the work has actually landed.
- Tests that wait for a wall-clock window wait for the **file to say so**: the heartbeat and the
  thinning case poll the document on disk for the change they are waiting for, with a generous
  iteration count, rather than sleeping once and reading.
- The two budget cases keep their budgets and lose their wall-clock gate. Each now asserts
  **linearity** — the same work at a tenth of the size and at full size, compared by ratio —
  and *reports* its absolute milliseconds as a diagnostic. A ratio of 4 for a 10× size is
  linear; a ratio of 100 is the O(n²) that the budget existed to catch, and the assertion
  threshold sits between them. The absolute number still goes to the test output, so a
  regression that made the code 100× slower is visible without being able to turn a colleague's
  machine red.
- `two corrections written at the same time both land on disk` takes **both** of its day keys
  from the ledger the Host serves, the way the sibling case `a state write that cannot land is
  reported` already does, so no date is written into the test.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None. No specified behaviour of the plugin changes: this is a change to the tests that check
it.

## Impact

- Modified: `test/plugin-host.test.js` (five cases), `test/indicators.test.js` (the detection
  budget), `test/export.test.js` (the stream budget).
- Not modified: `src/`, `client/`, any spec under `openspec/specs/`, any file format, any route,
  the configuration schema.
- No new dependency: `process.hrtime.bigint()` and a promise are all the new machinery.
- The guard in `test/clock-shift.test.js` is untouched and keeps re-running the whole suite at
  its four instants. What changes is that it now also survives a loaded machine, which is what
  a guard is for.
