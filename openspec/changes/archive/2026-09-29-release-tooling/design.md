# Design

## Context

See `proposal.md` — Why.

The facts that shape the approach:

- The version is written in three files: `package.json` `version`, `src/index.js` (`const
  VERSION = '0.1.0'`) and `client/client.js` (`const VERSION = '0.1.0'`). The last two are
  reported in the panel footer (`footer.host` / `footer.client`), so a release that bumps
  only `package.json` produces a panel that claims the wrong version.
- There is no tag in the repository, so "the last release" has to have a defined answer for
  the first run: with no tag, the range is the whole history.
- Every shipped change is already archived under
  `openspec/changes/archive/<YYYY-MM-DD>-<name>/` with a `proposal.md` that has a `## Why`
  paragraph and a `## What Changes` bullet list. That is the best available source of release
  prose, and it is written for a reader who has not seen the change.
- Delivery is a Nix flake and GitHub; `package.json` is `"private": true` and stays that way.
  A release is therefore a tag plus a GitHub Release.
- `knip.json` fails on an unused *file*, so a new file under a directory it does not watch
  has to be declared as an entry or it is reported as dead.
- `npm run lint` needs `knip` and `jscpd` installed, which a kernel-linked development tree
  does not have (see the `Development` section of `README.md`). A release script that runs
  lint must fail with a clear message rather than a bare `ENOENT`.

## Goals / Non-Goals

**Goals:**

- One command per step, each step doing exactly one thing: check, draft notes, prepare,
  publish. No step is implied by another.
- Every step refusing to do damage: no editing when the three versions disagree, no tagging a
  dirty tree, no publishing to GitHub without a reviewed notes file and an explicit `--yes`.
- Notes that a maintainer can read and edit in a minute, with the OpenSpec archive as their
  backbone and the commit log as the remainder.
- Testable core logic: version arithmetic, the three-place rewrite, change-title
  humanization and notes rendering are pure functions over strings and data, exercised by
  `node --test` with no git repository involved.

**Non-Goals:**

- No `CHANGELOG.md`. The user chose GitHub Releases as the single place release notes live, so
  the tooling writes a draft file into `tmp/` and never maintains a changelog in the tree.
- No npm publish and no flake-registry publication; `private: true` stays.
- No conventional-commit convention imposed on contributors, and no automatic commit-message
  parsing. Commits reach the notes as subjects, grouped, not classified.
- No retroactive `v0.1.0` tag.
- No CI workflow change: the release is a maintainer action with `git` and `gh` credentials,
  which the read-only CI job does not have.

## Decisions

**D1 — Two scripts, not one, split by what they read.** `scripts/release-notes.mjs` reads
`git` and the archive and writes a file; `scripts/release.mjs` reads the version places and
runs `git`/`gh`. Splitting them means the notes can be regenerated at any time — including
*after* `prepare` has committed the bump and *after* a new commit landed — without touching
the working tree. Alternative considered: one `release.mjs` with subcommands (fewer files, one
place to read); rejected because regenerating notes then implies running a script whose other
subcommands mutate files and publish, and the "safe" invocation would need its own flag.

**D2 — Notes are a draft, and the flag is the contract.** `release:notes` writes
`tmp/release-notes-<version>.md` (gitignored) with a leading `<!-- DRAFT -->` marker and
prints the path; `--out <file>` and `--stdout` override the destination. Nothing in the
tooling publishes notes text that was not written to a file and read back by a human.
Alternative considered: `gh release create --generate-notes` (git's own auto-notes);
rejected because it produces a list of commit subjects with no notion of which archive
change is the story.

**D3 — The range is `lastTag..HEAD`, and "no tag" means the whole history.**
`lastTag` is `git describe --tags --abbrev=0`; with no tag the range is
`$(git rev-list --max-parents=0 HEAD)..HEAD`, so the first release covers 0.1.0 as well. The
script prints the range it used, because a notes file that silently covers the wrong commits
is the worst failure mode here.

**D4 — Archived changes are found by git, not by comparing dates.** The archives in range are
the directories under `openspec/changes/archive/` that appear in the name list of
`git log <range> --name-only --diff-filter=AM` — added or modified. Comparing the
`YYYY-MM-DD` prefix against the last tag's commit date was the alternative; it is simpler
but wrong whenever a change is archived in a commit whose date and the directory name
disagree (rebases, an archive committed after midnight), and it silently drops an archive
whose files were only *touched* after archiving, which is how the 0.2.0 range actually finds
`2026-09-29-cost-anomaly-indicators` (its `tasks.md` was ticked in a later commit).

**D5 — Notes shape: one section per archived change, then the remaining commits.**
Each archived change becomes a `### <Title>` section — the name humanized (`cost-anomaly-
indicators` → `Cost anomaly indicators`) — with the proposal's `## Why` prose (collapsed to
its first paragraph, hard-wrapped) followed by its `## What Changes` bullets verbatim,
marked `**Breaking change.**` above them if the proposal says `**BREAKING**`. The order is
the commit that added the archive directory, read from the whole history, not the
`YYYY-MM-DD` prefix: several changes are archived on the same day, so the name cannot order
them, and the commit can. Below the sections, `## Other changes` lists the subjects of the
range's non-merge commits that touched **no file under `openspec/`** — planning commits are
never release content, and the archiving of a change is already that change's section.
Conventional prefixes (`feat:`, `fix:`, `docs:`) are stripped from the subjects. Alternative
considered: excluding only the archive directory, which still lists a change's own
implementation commit next to its section; and imposing Conventional Commits and classifying
by prefix, rejected twice over — the first is duplication, the second is a contribution
policy change and the repository's existing subjects (`Add cost anomaly indicators to the
Cost view`) are not in that form.

**D6 — `prepare` edits, verifies, and stops.** It takes the version as an argument and
refuses anything that is not an `x.y.z` version ahead of the current one, runs `check` (which
covers the three places agreeing, the tree being clean and `v<version>` not existing yet),
rewrites the three lines, then runs `npm run lint` and `npm test` and prints a draft commit
message. It does not commit, push or tag: a commit message and a commit are exactly what the
repository's rules make a draft-first, human-approved step. `--commit` is not offered —
approval is a human act that happens outside the script. `publish` is the mirror image: it
requires the tree to already carry the version it is asked to tag, because by then `prepare`
has run and committed.

**D7 — `publish` is the only script that talks to GitHub, and it is refused by default.**
It requires that the tree already carries the version being published (that is `prepare`'s
job), re-runs `check`, requires a clean working tree, that `v<version>` does not already
exist, and that a repository to publish to is known — `GH_REPO` or `origin` — with the
owner/name derived from the remote and passed to `gh` as `--repo`, so a release cannot land
in a fork because the script ran in the wrong checkout. It requires a notes file (defaulting
to the `tmp/` path, overridable with `--notes`), prints the release title, the notes body and
the exact `gh release create` command, and exits without touching anything unless `--yes` is
given. `--dry-run` prints the command and stops even with `--yes` absent. Alternative
considered: an interactive prompt; rejected because the agent-facing path in `AGENTS.md` must
be scriptable — approval is a separate conversation step, not a TTY prompt.

**D8 — Pure core, thin shell.** Each script exports pure functions (`parseVersion`,
`compareVersions`, `rewriteVersionIn`, `humanizeChangeName`, `renderNotes`,
`collectCommits`) and calls `git`, `gh` and the filesystem only in a small `main()` guarded
by an `import.meta.main`-style check. `test/release.test.js` imports the pure functions and
feeds them strings; no test needs a repository. This is also what keeps `knip` quiet: the
files are entries, and their exports are used by the tests.

**D9 — `knip.json` gains `scripts/*.mjs` as an entry.** Without it, the new files are outside
`project` and unreferenced, which the `files` rule reports. The `binaries` rule accepts `node`
(a Node built-in), and the new `package.json` scripts therefore need no allow-list entry.
*Corrected after review:* this was first written as "a leftover exported helper fails lint",
which knip does not do for entry files — its default `includeEntryExports` is false, so the
`exports` rule stays quiet about exports that only the file itself uses. The guard against
those is `test/release.test.js`, not knip; enabling `includeEntryExports` would be a separate
decision, because the six internal-only exports would then have to lose their `export`.

**D10 — Missing lint tools are a clear failure, not a skip.** `prepare` runs `npm run lint`
through the npm script, and if it fails it prints that `npm run ci` needs the dev
dependencies installed (`npm ci --ignore-scripts`) and that this is the same rule the
`Development` section of `README.md` describes. It does not fall back to `npx` — a release
must not quietly lint less than CI did.

**D11 — Documentation is split by audience.** `AGENTS.md` gets a `Releasing` section: the
ordered procedure an agent follows, ending in "show the notes and the commit message, wait
for approval". `CONTRIBUTING.md` is the human-facing process (branch → PR → merge → release)
with a table of the four commands and what each refuses. `README.md` gets a short `Releasing`
paragraph next to `Development` that points at `CONTRIBUTING.md` and does not restate the
process — a second copy of the procedure is a second thing to forget to update.

**D12 — The 0.2.0 release itself is the last step of this change.** `prepare 0.2.0` → commit
(the message is the script's draft) → push → `release:notes` regenerated and reviewed →
`publish 0.2.0 --yes`. The archive of this change lands in the range, so the notes for
0.2.0 include it — which is correct: the release tooling ships *in* 0.2.0.

## Risks / Trade-offs

- **A notes draft that is a wall of bullets** → the `Why` paragraph leads each section, and
  the file is explicitly a draft the maintainer edits; the range and the sections it used are
  printed at the top of the file so a wrong range is visible without opening GitHub.
- **Prose is duplicated between `proposal.md` and the release notes** → accepted. The
  proposal is written for someone deciding whether to build; the notes are written for
  someone deciding whether to upgrade. The copy is generated, never hand-maintained twice.
- **Three version places can drift again** → `check` is run by `prepare` and `publish` and
  fails on any disagreement, and a test asserts the rewrite hits exactly one line in each
  file. A fourth place added later makes `check` fail rather than pass quietly, because it
  reports the places it knows about and the version it read.
- **`gh` missing or unauthenticated** → `publish` checks for the binary and for
  `gh auth status` before editing anything, and names the fix in the error.
- **The first run has no tag, so the 0.2.0 notes include 0.1.0's commits** → intended
  (proposal D3), stated in the notes' own header, and fixed for every release after it.
- **The scripts become project surface that nobody maintains** → they are four small
  subcommands with pure cores, covered by `test/release.test.js`; the tests are the contract
  that keeps the arithmetic and the rendering stable.

## Migration Plan

Additive: new files and new npm scripts; no existing script changes behaviour, no existing
file is renamed. The version rewrite is the only edit to existing content, and it is the
release itself — revertible with a single `git revert` of the bump commit before the tag
exists. Rolling back the tooling after 0.2.0 is deleting `scripts/`, `test/release.test.js`,
the four `package.json` scripts and the `knip.json` entry; nothing else depends on it.

## Open Questions

None that would change the approach. Whether the first release deserves a retroactive
`v0.1.0` tag was decided (no), and whether `package.json` should stop being `private` was
decided (no — delivery is the flake plus GitHub Releases).
