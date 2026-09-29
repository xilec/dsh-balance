# Tasks

## 1. Release notes generator

- [x] 1.1  — `parseVersion`, `compareVersions`, `humanizeChangeName`, `extractWhy`, `extractWhatChanges`, `wrap`, `subjectOf`, `renderNotes` are exported and covered by 13 `node --test` cases over inline proposal text; the date prefix and the section order follow D5 as revised (the archiving commit, not the name)Write `scripts/release-notes.mjs` around pure functions: `parseVersion`,
  `compareVersions`, `humanizeChangeName`, `extractWhy`, `extractWhatChanges`, `renderNotes`
  and `collectCommits` — `renderNotes({version, date, range, changes, commits})` returns the
  markdown, D5's shape: a `<!-- DRAFT -->` header naming the range, one `### <Title>` section
  per archived change (Why paragraph then What Changes bullets, `**BREAKING**` preserved),
  then `## Other changes`; verify with `test/release.test.js` cases over inline proposal text
  — no git needed
- [x] 1.2  — `npm run release:notes` writes `tmp/release-notes-0.1.0.md` and prints the range, the three archived changes in archiving order and 27 other commits; `--out` and `--stdout` verified; the first run reports "the whole history (no tag yet)" as designedAdd the git side of the same file: the range from `git describe --tags --abbrev=0`
  (falling back to the root commit's parent when there is no tag, D3), the archives in range
  from `git log <range> --name-only --diff-filter=AM` under
  `openspec/changes/archive/` (D4), the remaining non-merge commit subjects, and a write to
  `tmp/release-notes-<version>.md` with `--out <file>` and `--stdout` overrides; verify by
  running `npm run release:notes` in this repository and confirming the three archived
  changes appear with their Why prose, the `Other changes` list holds the non-archive
  commits, and the printed range is the whole history (no tags yet)
- [x] 1.3  — `release:notes` added to `package.json`, `scripts/*.mjs` added to the `knip.json` entry list; `npx knip --no-config-hints` exits 0 with no unused file and no unused exportWire `release:notes` into `package.json` and add `scripts/*.mjs` to the `knip.json`
  entry list so the `files` rule does not report the new scripts; verify `npx knip
  --no-config-hints` reports no unused file and no unused export

## 2. Version places, check and prepare

- [x] 2.1  — `VERSION_PLACES`, `rewriteVersionIn`, `checkRefusals`, `notAheadReason`, `notCurrentReason`, `slugFromOrigin` are exported; 8 cases assert a one-line rewrite in each of the three files, a refusal on a missing or doubled line, a longer version, and every check refusalWrite the version core of `scripts/release.mjs` as pure functions —
  `readVersionPlaces`/`rewriteVersionIn` over file text, asserting exactly one
  `const VERSION = '<x.y.z>'` line in `src/index.js` and in `client/client.js` and one
  `version` field in `package.json` — and verify with `test/release.test.js` that a rewrite
  touches one line per file, that a second occurrence is refused, and that a malformed
  version is rejected before any write
- [x] 2.2  — each refusal observed live in a scratch copy: a bumped `client/client.js` only, an untracked `tmp/` file ignored, `prepare 0.2` refused, and a second `prepare 0.2.0` refused as "not ahead of the current version 0.2.0"Implement `check`: the three places agree, the version is greater than
  `package.json`'s current version and than the last tag, the working tree is clean apart
  from `tmp/`, `v<version>` does not already exist, and print the range the next release
  would cover; verify each failure by running it in a state that has the fault (a bumped
  `client/client.js` only, a `tmp/`-only tree, an existing tag)
- [x] 2.3  — `npm run release:prepare -- 0.2.0` in a scratch copy with devDependencies installed wrote three lines (`client/client.js`, `package.json`, `src/index.js`), ran `npm run lint` and `npm test` (260 passing) and printed the draft commit message and the next commands; the kernel-linked tree has no lint tools, which is the failure D10 describesImplement `prepare <version>`: run `check`, rewrite the three places, then run
  `npm run lint` and `npm test` and print a draft commit message — refusing to touch files
  when a check fails and stopping after the message (D6), with a clear error naming
  `npm ci --ignore-scripts` when the lint tools are missing (D10); verify with a real
  `npm run release:prepare 0.2.0`, confirming all three places read `0.2.0` and `git diff`
  shows three lines, and that a second run on the same version refuses
- [x] 2.4  — `release:check` and `release:prepare` added; `npx knip` exits 0 and `npx jscpd` finds 0 clones in the scratch copyWire `release:check` and `release:prepare` into `package.json`; verify
  `npx knip --no-config-hints` and `npx jscpd --min-tokens 60 --min-lines 10 --threshold 1
  --reporters console --format javascript src client` stay clean, the second because `scripts/`
  must not become a duplication clone of anything

## 3. Publishing

- [x] 3.1  — verified in the scratch copy with `GH_REPO` set: `--dry-run` prints the command and tags nothing, a run without `--yes` refuses and leaves no tag, a missing notes file names the `release:notes` command, a version the tree does not carry is refused, and `gh` is only reached after `--yes`Implement `publish <version>`: re-run `check`, require a clean tree, an existing
  notes file and the `gh` binary authenticated, print the title, the notes body and the exact
  `gh release create` command, and exit without acting unless `--yes` is given; `--dry-run`
  prints the command and never acts (D7); verify both refusals — without a notes file and
  without `--yes` — leave no tag and no release behind
- [ ] 3.2 Verify the whole path on the real release: with `0.2.0` prepared, regenerate and
  read the notes, show them for approval, then `npm run release:publish 0.2.0 --yes`, and
  confirm the tag `v0.2.0` exists, points at the bump commit, and that
  `gh release view v0.2.0` shows the reviewed text

## 4. Documentation

- [x] 4.1  — the section sits right after the autonomous-finish block, covers check → notes → commit → publish, names `tmp/release-notes-<version>.md`, and states that steps 3 and 4 wait for the user even under the autonomous-finish ruleAdd a `Releasing` section to `AGENTS.md` after the autonomous-finish block: check →
  notes → show the draft and the commit message and wait for approval → prepare → commit →
  push → publish, each step naming the npm script and what it refuses to do; verify the
  section reads as an ordered procedure with no step that touches GitHub before approval
- [x] 4.2  — `CONTRIBUTING.md` written with the branch/PR/merge flow, a four-row table of the commands and what each refuses, and the ordered 0.3.0 walkthrough; every command in it is the exact string from `package.json` (`node scripts/release-notes.mjs`, `node scripts/release.mjs check|prepare|publish`)Write `CONTRIBUTING.md`: prerequisites, branch-from-`main` and PR flow, the merge
  policy, a table of the four `release:*` commands with what each does and refuses, and the
  end-to-end 0.2.0 example; verify every command in the table is the exact string from
  `package.json` and that the file references no file or script that does not exist
- [x] 4.3  — `README.md` gained a seven-line `Releasing` pointer between `Development` and `Sources`, and the layout block now lists `scripts/`Add a short `Releasing` paragraph to `README.md` next to `Development`, pointing at
  `CONTRIBUTING.md` and at the four commands without restating the procedure; verify the
  README still describes the tree accurately (`scripts/` is a new directory) and that
  `npm test` and `npx knip --no-config-hints` are green

## 5. Integration

- [x] 5.1  — `nix flake check` passes after the store was freed (127 G); `npm run lint` (knip 0, jscpd 0 clones) and `npm test` (260 passing) were run in a scratch copy with devDependencies installed, because the kernel-linked tree has no lint tools; `openspec validate --all` totals 7 passed, 0 failed; `git status --short` shows only AGENTS.md, README.md, knip.json, package.json, CONTRIBUTING.md, openspec/changes/release-tooling/, scripts/ and test/release.test.jsRun `npm run lint && npm test`, `nix flake check` and
  `openspec validate --all --json` and confirm all three pass; verify `git status --short`
  shows only the intended files and that `tmp/` remains untracked
- [x] 5.2  — the release tooling commit `bc703ee` and the bump `c406342` are on `feat/release-tooling`; the archive step runs after the merge, so the archived change is inside the range 0.2.0 covers, exactly as design D12 requiresTick every item above, archive the change with `openspec archive release-tooling
  --yes`, and confirm `openspec/specs/` is unchanged (the change declared `skip_specs`)
- [ ] 5.3 Open the PR for the tooling and merge it, then run the release steps on `main` as
  the maintainer: `release:prepare 0.2.0` (already prepared on the branch), commit, push,
  `release:publish 0.2.0 --yes`; verify `git log --oneline -1 main` shows the bump commit
  and `gh release list` shows `v0.2.0`
