# Proposal

## Why

The session-cost fold reads every event of a session's log by dereferencing `event.data` with no
guard. Five families do it unguarded — `step/start`, `step/end`, `llm/retry-started`, `tool/call`,
`assistant/message` / `assistant/attempt` — and two more read a nested field of it,
`request/header` and `request/context`. A single stored event with no `data` throws a `TypeError`
out of the fold (`Cannot destructure property 'turn' of 'event.data' as it is undefined`).

What that costs is far more than the one event. `projectionStateOf` (`src/index.js:637`) folds a
session's stored log through this same unit and its `catch` turns *any* throw into
`{ error: 'unknown-session' }`, so **one** odd event makes the whole Cost view report the session
as unknown — series, totals, Findings and export all gone, for a session with hours of priced
work. In `childrenPayloadOf` (`src/index.js:813`) the same throw turns a child line into an
`unavailable` diagnostic, so a subagent with one bad event reads as a branch that could not be read.

`openspec/specs/session-cost-analysis/spec.md` asks for the opposite in both places: the
**Per-Step cost series** requirement makes the series "one node per `(Turn, Step)` location", and
the **Subagent sessions** requirement says "WHEN a child session cannot be read THEN the remaining
lines are still reported". A log entry that is not shaped like the rest of the log is not an
unreadable session; it is one entry the series has no place for. There is a quieter defect in the
same lines too: `step/start` with `data: {}` does not throw but opens a node whose `turn` and
`step` are `undefined`, and that state fails its own `stateSchema` at the next checkpoint — a
fold that produced a state it cannot serialize was already wrong before the throw.

## What Changes

- The fold reads every event family's data through one shape check and skips what does not match.
  The rule is the spec's own: the series holds one node per `(Turn, Step)` location, so an event
  that names no valid location is not a Step and has nowhere to go — it contributes nothing and is
  skipped, and the rest of the session is priced and reported as usual. A `step/start` that *does*
  name a location still opens a node with no usage, because the spec's series has a node per
  location and not only per priced one.
- A compaction keeps its own rule, which the spec states separately: a compaction node may be
  turn-less, so it is placed by its own `compactionId` and not by a location, and a compaction
  naming no id is still skipped because it can be neither deduplicated nor exported.
- The guard is an explicit shape check on the event's data, never a `try`/`catch` around the fold.
  A bug inside the fold — a state whose own fields are broken — still throws, which is what keeps
  this a conformance fix rather than a trade of a loud failure for a silent one.
- `src/index.js` needs no change: its `catch` behaviour is what the spec's **Subagent sessions**
  requirement asks for when a branch genuinely cannot be read, and the fix removes the reachable
  trigger for it.
- Tests in `test/session-cost.test.js`: for every family named above, an event with no `data` and
  events with partially shaped `data` (a missing `model`, a missing `turn`, a `null` field) are
  folded next to a priced session, and the sum invariant — the session estimate is the exact sum
  of its node costs — is asserted to still hold. One test asserts that a state whose own internals
  are broken still throws.
- No delta specs: the requirements are unchanged, the code did not implement them. See
  `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None — `session-cost-analysis`'s **Per-Step cost series** requirement already defines the series
as one node per `(Turn, Step)` location, and its **Subagent sessions** requirement already says a
child that cannot be read leaves the remaining lines reported. This change makes the fold match
what those two requirements say.

## Impact

- Modified: `src/session-cost.js` — one `dataOf` and one `locationOf` shape check, used by
  `reduce` and by `withCall`; `withCompaction` reuses the same index predicate for the Turn it
  names. The fold stays pure, keeps its imports, and gets no dependency.
- Modified: `test/session-cost.test.js` — the new cases above. No existing case changes; the sum
  invariant test is untouched.
- Not modified: `src/indicators.js`. It consumes the output of `seriesPayload`, and `describeNode`
  builds every field of every node it reads (`cost`, `buckets`, `hasUsage`, `kind`, …), so the
  defect class is not reachable there — verified by reading every `node.` access in the file.
- Not modified: `src/index.js`. Its two `catch` sites are the spec's "cannot be read" behaviour
  and stay as they are.
- Not modified: `src/export-text.js`. It already reads `event.data ?? {}`.
- Behaviour change, stated plainly: a usage report whose event names no valid `(Turn, Step)` is
  dropped rather than billed. That is the honest direction — the alternative is inventing a Step
  the conversation never had, which would break the sum invariant and inflate the Step count the
  wire view reports.
