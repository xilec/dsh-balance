# Proposal

## Why

The plugin is 0.1.0 with three finished changes archived and no tag, no release notes and no
way to cut a release other than remembering every step by hand: bump the version in three
places (`package.json`, `src/index.js`, `client/client.js`), write prose that nobody has to
write again, commit, tag, and paste notes into GitHub. A contributor who wants to ship a fix
has to reconstruct that from scratch, and the repository's own history is the only record of
what a version contained. Now — with 0.2.0 as the first real release — the process should be
one command, and the notes should come out of the OpenSpec archive the project already
maintains instead of out of anyone's head.

## What Changes

- New release tooling under `scripts/`, driven by two npm scripts:
  - `npm run release:notes` writes a **draft** of the release notes to
    `tmp/release-notes-<version>.md`. The draft is assembled from the archived OpenSpec
    changes in the range since the last tag (their `Why` prose and their `What Changes`
    bullets, plus a human title) and from the commit subjects of everything else in that
    range. It is a draft, not a publication: the text is meant to be edited.
  - `npm run release:check` verifies that the three version places agree, that the version is
    ahead of the last tag, that the tree is clean, and prints the range the next release
    would cover.
  - `npm run release:prepare <version>` rewrites the three version places, runs
    `npm run lint` and `npm test`, and prints a draft commit message. It does not commit, tag
    or publish on its own — those are separate, explicit steps.
  - `npm run release:publish <version>` creates the tag `v<version>` and the GitHub Release
    from the reviewed notes file. It re-runs the checks, refuses a dirty tree, and only calls
    `gh` when it is given the reviewed file and an explicit `--yes`; `--dry-run` prints the
    exact command instead of running it.
- `AGENTS.md` gains a **Releasing** section: what an agent must do when asked to cut a
  release, in the order, including showing the notes draft for approval before anything
  reaches GitHub.
- `CONTRIBUTING.md` (new) documents the contributor's side of the same process: branch, PR,
  merge, and the four release commands with what each one does and what it refuses to do.
  `README.md` gains a short `Releasing` pointer next to `Development` rather than a second
  copy of the process.
- No delta specs: the plugin's observable behaviour does not change, and the tooling is
  repository infrastructure, so the change declares `skip_specs: true`.
- The plugin is then released as **0.2.0** — the version in all three places, tag `v0.2.0`
  and a GitHub Release whose notes come from the generated draft. No retroactive `v0.1.0` tag:
  0.1.0 is readable in the history, and the 0.2.0 notes cover the whole range.

## Capabilities

### New Capabilities

None — the change introduces no spec-level behaviour; see `skip_specs: true` in
`.openspec.yaml`.

### Modified Capabilities

None.

## Impact

- New: `scripts/release.mjs`, `scripts/release-notes.mjs`, `test/release.test.js`,
  `CONTRIBUTING.md`.
- Modified: `package.json` (four `release:*` scripts), `AGENTS.md` (Releasing section),
  `README.md` (Releasing pointer), `knip.json` (`scripts/*.mjs` as an entry so the new files
  are not reported as unused), and the version in `package.json`, `src/index.js:1142` and
  `client/client.js:24` for the 0.2.0 release itself.
- No runtime dependency, no change to the plugin's own dependencies, nothing under `src/` or
  `client/` except the version constant. The scripts use Node built-ins only (`node:fs`,
  `node:child_process`) and shell out to `git` and `gh`.
- Draft release notes land in `tmp/`, which is already gitignored.
