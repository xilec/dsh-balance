# Design

See `proposal.md` — Why. This document records the choices made while turning the plugin's
existing behavior into specs.

## Context

- The repository uses OpenSpec with a single existing capability, `session-cost-analysis`
  (19 requirements, archived 2026-09-29). It describes the per-session Cost view only.
- The rest of the plugin is exercised by `npm test` (168 cases) and documented in prose in
  `README.md` and `CONTEXT.md`, but has no requirements of its own.
- `CONTEXT.md` is the domain glossary and fixes the vocabulary the specs must use: *Spend*,
  *Credit event*, *Session cost estimate*, *Tariff rule*, *Tariff projection*, *Step*, *Turn*,
  *Unpriced model*, *Cost view*, *Calibration line*, *Subagent session*, *History export*.
  The avoid-lists there are binding for requirement wording.
- No implementation change is in scope, so every requirement has to be true of the code as it
  stands.

## Goals / Non-Goals

- Goal: a reader can learn what the plugin promises without reading `src/` or `client/`, and a
  later change can express itself as a delta against these capabilities.
- Goal: requirements are observable and checkable — by the existing suite, by an HTTP call, or
  by looking at the running plugin.
- Non-Goal: describing internal structure (module boundaries, function names, helper layout).
- Non-Goal: changing, refactoring or fixing the implementation. Anything that looks wrong is
  recorded in `tasks.md`, not fixed here.
- Non-Goal: re-specifying the Cost view; it keeps `session-cost-analysis` and is only referenced.

## Decisions

**Four capabilities instead of one.** The Host half, the tariff rule, the settings surface and
the browser half change for different reasons and are consumed by different readers (ledger,
pricing, configuration, UI). One `plugin` capability would make every future delta large and
would tie a pricing-table update to a UI refactor. Four keeps each delta local. The split also
matches the existing flat layout: `openspec/specs/<capability>/spec.md`, no domain level.

**The settings surface is its own capability, not part of either half.** `currency`, `dayZone`,
`holidays`, `fallbackRates` and the Cost view's own preferences are all written through one
route and one on-disk state, and its precedence rules (row value vs runtime write, restore
order) are a single contract that both halves depend on. Splitting it across the two halves
would duplicate those rules.

**HTTP routes live with the behavior they carry.** Rather than one transport capability, each
route is a requirement inside the capability whose data it exposes (balance and ledger routes in
`balance-tracking`, peak and tariff routes in `tariff-rule`, state read/write in
`plugin-settings`). A route is a contract, but its meaning is the data it returns; a separate
"API" capability would have to restate every payload anyway. The Cost view routes stay in
`session-cost-analysis`.

**The code is the contract, the README is evidence.** Where `README.md` or `CONTEXT.md` and the
implementation disagree, the requirement states what the code does and the divergence is
recorded as a task so the user can decide whether the code or the docs is wrong. Specs are not
allowed to describe an aspiration that the tests do not enforce.

**No new tests.** The backfill is verified by mapping every requirement to an existing test,
route, or observable behavior, and by leaving the suite untouched and green. New tests would
encode the spec twice and would make this change non-documentation.

**Delta form.** All four capabilities are new, so each delta is `## ADDED Requirements` with a
`## Purpose`. Requirements use SHALL/MUST and carry at least one WHEN/THEN scenario.

## Risks / Trade-offs

- [A requirement states a detail the code only happens to do today, freezing an accident] →
  Requirements are limited to behavior a consumer can observe and rely on; internal choices
  (naming, ordering of files) are left out. Reviewers can downgrade a requirement in a later
  delta cheaply.
- [Backfilled specs drift from the code the moment someone edits it] → Requirements are written
  to the level the test suite already pins; a change that alters behavior now has to touch the
  spec too, which is the point of the backfill.
- [Duplication with `session-cost-analysis`] → The Cost view is referenced, never restated; the
  shared settings write points at `plugin-settings` instead of redefining it.
- [The README stays the friendlier document] → The README is not rewritten here; only the few
  lines the verification found wrong are corrected, while the specs state the contract and the
  README keeps the narrative.

## Migration Plan

Documentation only: land the specs, archive the change so the four capabilities appear under
`openspec/specs/`, and take no runtime action. Rollback is a revert of the change commit, which
leaves the previously existing `session-cost-analysis` spec untouched.

## Open Questions

None. Requirement-level uncertainty found while reading the code is recorded as a task with the
file and line, so it can be answered without re-planning.
