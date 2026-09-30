# Tasks

## 1. Correct the packaging comment

- [x] 1.1 In `cordis.patch.yml`, name the real entry point in the header comment —
  `$out/src/index.js`, which is what `flake.nix` copies and what the README's Home Manager
  snippet writes; verify that no other path in the file disagrees with the flake
  — done: the comment now says `src/index.js` and points at `flake.nix`; the file's other
  half (the browser half through `exports["./client"]`) was already right, and `flake.nix`'s
  own comment already said `src/index.js`, so the patch file was the only file out of step
- [x] 1.2 Check the seven config keys the file carries against `Config` in `src/index.js`, so
  the file's other claims are known to be in sync and the PR can say so
  — done: `refreshIntervalMs` 300000, `clientPollIntervalMs` 15000, `currency` USD,
  `warningThreshold` 10, `dangerThreshold` 5, `dayZone` local and `historyDays` 30 are all
  the defaults in `Config`, so the comment was the file's only drift

## 2. Correct the README

- [x] 2.1 Fix the layout line for `client/client.js`: it holds the whole browser half — the
  readout, the peak chip, the panel, the Cost view with its Indicators, and the history export
  builder — not three surfaces; verify against the components in the file and re-align the
  block without reformatting the rest
  — done: the line wraps onto a second row in the same column, and the components it names
  are `Readout` (1171), `createPeakChip` (1250), the panel (1348-1703), `CostView` (3067),
  `Findings` (3592) and the export builder (`EXPORT_TEXT_LIMIT`, 2523)
- [x] 2.2 Fix the CI sentence: `.github/workflows/ci.yml` triggers on pushes to `main` and on
  pull requests, so a push to a feature branch runs nothing; say that, and point at the local
  commands the Development section already lists
  — done: the sentence names the two triggers, says a feature-branch push runs nothing, and
  points at the command block above and the `npx` pair below
- [x] 2.3 State the Node requirement in the Development command block (`engines.node` is
  `>=22`); the README gave none
  — done: one line above the block, naming `engines.node` as where the number comes from
- [x] 2.4 Update the Releasing section's "three places" wording to four, now that the
  lockfile carries the version too
  — done: in `README.md`, in `CONTRIBUTING.md` (three places of it) and in the `release.mjs`
  header; `AGENTS.md` is left to the orchestrator — see the PR body

## 3. Bring the lockfile's version with the release

- [x] 3.1 Add `package-lock.json` to `VERSION_PLACES` with a pattern anchored on the root
  entry (`"packages": { "" { name, version } }`) so `rewriteVersionIn` cannot land on a
  dependency's `version`; verify the pattern matches exactly once in the real lockfile
  — done: the lockfile carries the root version twice, so the place has two patterns — the
  one next to `lockfileVersion` and the one in `packages[""]`, the latter anchored on the
  root entry's own `name` — and `placeVersions` on the real file returns
  `['0.2.0', '0.2.0']` and nothing from a dependency
- [x] 3.2 Update the wording that counted three places: the `release.mjs` header, the
  `checkRefusals` refusal text, and the doc comments on `inspect` and `VERSION_PLACES`
  — done: "the version files do not all carry the same x.y.z version" in both places that
  refuse, "four files" in the header, and `VERSION_PLACES` now carries a `patterns` array
  with the reason a file may have more than one
- [x] 3.3 Bring the tree's own `package-lock.json` root version to `0.2.0`, so the fix lands
  with the correction rather than after the next release
  — done: both root fields rewritten through `rewriteVersionIn` itself, and the result is
  byte-identical to what `npm install --package-lock-only` produced in a scratch copy
- [x] 3.4 Test the pure part in `test/release.test.js`: a lockfile whose root version is behind
  is rewritten to the new version, the two dependency `version` fields are untouched, and a
  lockfile with no root version line is refused rather than guessed at
  — done: three cases beside the existing rewrite ones — both root fields move, `zod`'s
  `4.4.3` and the rest of the file do not, and both a lockfile with no `packages[""]` and one
  with no top-level version are refused with the count in the message
- [x] 3.5 Verify `release:check` and the new entry agree: `npm run release:check` in the
  worktree reports the version without a mismatch, and a scratch copy with a stale lockfile
  refuses with the mismatch message
  — done: `release:check` in the worktree reports `version: 0.2.0` and no mismatch (its only
  refusal is the expected dirty tree); a scratch copy with the top-level lockfile version put
  back to `0.1.0` reports
  `mismatched ({"package.json":"0.2.0","package-lock.json":null,…})` and refuses

## 4. Record what the review asked to be verified

- [x] 4.1 Confirm the six checked claims and record the evidence in `design.md`: the flake
  output against every bare import in `src/` and `client/`, `files` against `exports`,
  `node-version-file: package.json` against `engines.node` plus every `@deepseek-ai/*` dev
  pin on the registry, the README's Node requirement, and the sample output lines, peak
  windows, preset factors and config defaults against `src/pricing.js`, `src/indicators.js`
  and `Config`
  — done: all six are in `design.md` with the file and line each was checked against; all
  four dev pins resolved on the public registry at their exact versions, and setup-node's
  `src/util.ts` was read rather than assumed
- [x] 4.2 Measure whether the lockfile drift breaks `npm ci --ignore-scripts` in a scratch
  copy, and put the result in `design.md` and in the PR body, so the severity is stated
  rather than assumed
  — done: `npm ci --ignore-scripts` in a scratch copy of the drifted tree installed 142
  packages with 0 vulnerabilities and exited 0, so the severity is housekeeping, not a broken
  release; the fix is in the tooling because nothing else would have caught it

## 5. Gates

- [x] 5.1 `npm test` in the worktree: all green, no test count reduction
  — done: 282 pass, 0 fail (279 before, three new release cases)
- [x] 5.2 `npm run lint` (knip + jscpd) in a scratch copy under `tmp/`, never in the worktree
  — done: knip clean, jscpd 0 clones in 1961 lines
- [x] 5.3 `nix flake check` in the worktree
  — done: all checks passed
- [x] 5.4 `openspec validate --all`: failed 0
  — done: 0 failed
