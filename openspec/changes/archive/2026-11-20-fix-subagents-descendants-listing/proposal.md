# Proposal

## Why

The Host removed `subagents.listChildren` from its public service in 0.2.2-rc.3, so the first
"Include subagents" read fails with `the subtree could not be read: subagents.listChildren is not
a function`. The direct-children read must use the API the running Host actually exposes.

## What Changes

- Read the direct children and the full subtree through `subagents.listDescendants`, keeping the
  direct children as the rows at depth 1. No other behavior of the child route changes.
- Replace the test stubs that implemented the removed `listChildren` method with stubs of
  `listDescendants`, including one that exposes only the new API.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `session-cost-analysis`: the subagent-session requirement states that the first ask reads
  direct children; it now has to say that both read levels come from the descendant listing.

## Impact

- `src/index.js` — `childrenPayloadOf`.
- `test/plugin-host.test.js` — the child-route stubs and the "first ask" assertion.
- Host compatibility: works with a `subagents` service that exposes `listDescendants` only.
