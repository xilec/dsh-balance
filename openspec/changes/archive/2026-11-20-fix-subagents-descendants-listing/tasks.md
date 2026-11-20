# Tasks

## 1. Descendant listing

- [x] 1.1 Replace the `subagents.listChildren` call in `childrenPayloadOf` with
  `subagents.listDescendants`, filtering direct rows to `depth === 1`; verify that
  `test/plugin-host.test.js` no longer mentions `listChildren` and that a stub exposing only
  `listDescendants` answers the direct-children route.
- [x] 1.2 Update the host-route tests for the new API and keep the direct/full distinction;
  verify with `node --test test/plugin-host.test.js` (55 tests, 0 failures).

## 2. Integration

- [x] 2.1 Run the whole test suite and confirm the change is compatible with DSH 0.2.2-rc.3;
  verify with `npm test` and record the result in the change report.
