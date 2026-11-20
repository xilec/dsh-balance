# Design

## Context

The Cost view's child route reads the subagent tree only on an explicit user action. The Host
used to expose two service methods: `listChildren(parentId)` for the first level and
`listDescendants(rootId)` for the whole tree. In DSH 0.2.2-rc.3 the public `listChildren` method
was removed; only the descendant walk remains on the `subagents` service. The plugin still
called `listChildren` on the first ask, so the whole read failed instead of showing the direct
children.

## Goals / Non-Goals

**Goals:**
- One Host API for both read levels.
- Keep the direct ask limited to depth 1, so "load full history" remains a separate, explicit
  action.
- Keep the payload shape unchanged for the client: `parentId`, `depth`, `kind`, `label`,
  `mode`, `activity`, `createdAt`.

**Non-Goals:**
- No change to pricing, the client Cost tab, export, or the main session route.
- No fallback to the removed method; a Host without `listDescendants` is still reported as an
  error.

## Decisions

- **Use `listDescendants` for both levels.** The Host's descendant walk is stable and already
  returns `parentId`, `depth`, `kind`, `mode`, `activity` and `hasChildren`. Filtering its rows
  to `depth === 1` gives exactly the direct children. Alternative: keep calling `listChildren`
  when present — rejected, because it preserves a dependency on an API the running Host does
  not have and adds an untested compatibility branch.
- **Filter, do not adapt.** The deep rows carry no `createdAt` in the Host payload; the existing
  code already normalizes a missing creation time to `null`. Direct rows keep the Host's
  `createdAt` when present.

## Risks / Trade-offs

- The direct ask now walks descendant catalogs before filtering; on a large tree this reads
  more catalogs than the old direct method. Mitigation: the action is explicit and a subtree is
  normally small; the client shows progress and the request is cancellable.
- A corrupt branch deep in the tree could end a direct read that previously succeeded. The Host
  turns unreadable branches into diagnostics rather than throwing; the existing code already
  reports diagnostics and keeps the readable lines.

## Migration Plan

Release the fix as a new plugin version and update the `dsh-balance` flake input in
`~/nixos-config`, then rebuild and restart the Host. Until the Host is restarted it keeps the
old module in memory.

## Open Questions

None.
