# Tasks

## 1. Amend the requirement's rationale

- [x] 1.1 Restate "A manual override is an anchored base" under `## MODIFIED Requirements`,
      carrying the normative anchor-span sentence over unchanged and replacing the "carries the
      previous day's spend" clause with the invariant a base is only ever added to by a drop
      between two instants of the same ledger day. Verify the normative MUST sentence is
      byte-identical to the one in `openspec/specs/balance-tracking/spec.md`.
- [x] 1.2 State inside the same requirement that an anchor before the day's first sample adds
      nothing even when it lies on that same day, that the day's own sampled spend is still
      reported as the row's sampled value, and that re-entering the correction once the anchor
      falls inside the day restores the sampled part. Verify the requirement reads as one
      argument and no clause contradicts the anchor-span sentence above it.
- [x] 1.3 Re-word the "A base anchored before the day began" scenario so its WHEN describes the
      position without asserting the false premise as the only reason, and add the scenario
      "A base anchored before the day's first sample, on that same day" for the reachable case.
      Verify every other scenario of the requirement is carried over unchanged and no scenario
      is duplicated or orphaned.

## 2. Pin the same-day case with a test

- [x] 2.1 Add a test to `test/history.test.js` beside the existing anchor cases: samples
      `2026-09-23T23:50 @ 10`, `2026-09-24T00:07 @ 8`, `2026-09-24T00:20 @ 5` with an override
      of `1` anchored at `2026-09-24T00:05 @ 10`, asserting `measuredAfter 0`, `spend 1` and
      `computed 5`. Name it as a specification test in a comment that points at the requirement
      it backs, so it is not later read as a regression test. Verify `npm test` is green.
- [x] 2.2 Check `README.md`, `CONTRIBUTING.md` and `CONTEXT.md` for a statement of the rule and
      bring any into agreement. Verify by grep that no document outside `openspec/` and the test
      still justifies the rule by the previous day's spend.

## 3. Gates

- [x] 3.1 Run `npx -y @fission-ai/openspec@latest validate --all` and confirm 0 failures.
- [x] 3.2 Run `npx -y @fission-ai/openspec@latest archive amend-anchor-span-rationale --yes`,
      then re-read `openspec/specs/balance-tracking/spec.md` around the requirement to confirm
      the archive produced a coherent whole: one requirement block, no duplicated or orphaned
      scenario, the new scenario in place among its neighbours. Verify `validate --all` is
      still 0 failures after the archive.
- [x] 3.3 Run `npm test` and `nix flake check` in the worktree, and knip + jscpd in a scratch
      copy under `tmp/` with its own `node_modules`. Verify all are clean.
