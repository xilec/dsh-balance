# Design

## Context

See `proposal.md` — Why.

The facts that shape the approach:

- The documented workaround for a tree without lint tools is a scratch copy under
  `./tmp/`, i.e. a directory *inside* the repository. A copy made with `tar` or `cp` has
  no `.git`, so `git rev-parse --show-toplevel` answers with the checkout above it.
- The scratch copy is not a rare thing to do. It is step 2 of the release procedure in
  `AGENTS.md` and the last paragraph of the development notes in `CONTRIBUTING.md`, so the
  dangerous case is the *documented* one.
- What the scripts touch is four version files (`package.json`, `package-lock.json`,
  `src/index.js`, `client/client.js`) under one root, a notes draft under that root's
  `tmp/`, and a walk of `openspec/changes/archive/` — plus `git` for the tags, the range,
  `origin/main`, the dirty paths and the archive log. Every one of those answers a
  question about *a tree*, and none of them has an answer that is true of two trees.
- `repoSlug` and `lastTag`/`releaseRange` read git from the process working directory, not
  from the root the rest of the script had resolved. That is the same bug in a smaller
  hole: a script that resolved the right root and then asked git about the directory it
  happened to be started in.

## Goals / Non-Goals

**Goals:**

- One tree per run, decided once, named in the output, and refused — never guessed — when
  it cannot be decided.
- No `git` call and no file path in either script that is relative to the process working
  directory. The working directory is an input to the decision, not a source of paths.
- A refusal a maintainer can act on: it names the tree that was found, the tree that was
  wanted, and what to do about it.

**Non-Goals:**

- No `--tree` / `--dir` flag. Choosing a tree by hand is how the wrong tree gets chosen;
  the fix is to make the tree you are standing in the only tree that can be meant.
- No change to the plugin, to the four version places, or to any refusal the scripts
  already have. This change only decides which directory those refusals are about.
- No `git init` run by the script. A script that repairs the tree it was pointed at is a
  script that has already decided it may write there.

## Decisions

**D1 — The tree is the git root, and the command has to be run in it.** `releaseTree()`
resolves `git rev-parse --show-toplevel` from the working directory and refuses unless
that answer *is* the working directory. Two candidates were on the table and they answer
different questions.

*A: resolve to the nearest ancestor holding a `package.json`.* The manifest is the plugin's
own, so the tree a release writes to is the one the plugin was loaded from — including a
scratch copy, which `AGENTS.md` asks for, so the documented workflow keeps working
unchanged. Its hole is the same shape as the defect it fixes: when a directory holds no
manifest, the walk continues upwards and finds the checkout above, and the scripts go on
acting on it. A copy of `scripts/` alone is exactly that directory, and it is the smallest
and most likely thing to make by hand. "Wherever the nearest manifest is" is an inference,
and the four files that carry the version are not a place to infer.

*B: require the tree to be the git root, refusing when the working directory is not it.*
This is the safety property: a directory that is not a root is a copy or a subdirectory,
and both of the facts above such a directory (which repository contains it, which manifest
is nearest) belong to a tree nobody asked the script to touch. The refusal names both and
costs one `cd` or one `git init`.

B is chosen. The cost is real and is listed under Trade-offs: running the script from a
subdirectory of a checkout is refused, where A allowed it. That is one command away, it is
refused loudly rather than acted on, and every npm entry point already runs with the
package root as its working directory, so the workflow the tooling exists for is untouched.

**D2 — The tree has to be the plugin's, checked in the place the root is resolved.**
D1 says which tree among the ones git knows about; this says it is the right one. A `git`
repository that is not the plugin checkout — a notes repository, a vendored tree, a
scratch copy of `scripts/` with a manifest in it and nothing else — is refused with the
manifest named. A tree that has the manifest but is missing one of the four version
places is refused with that place named, which is what the same half-made copy hits one
step later: `inspect` reports `the tree has no package-lock.json, src/index.js,
client/client.js` instead of throwing `ENOENT` out of `readFileSync` with a stack trace on
top. Both are refusals rather than diagnostics because both are states the documented
scratch-tree workflow walks through, and a stack trace in the middle of a release is the
worst place to meet one.

**D3 — Both facts are read, then the refusal is composed; never one without the other.**
A bare clone answers `--is-bare-repository` with `true` and `--show-toplevel` with a fatal
error, because a bare repository has no working tree to be the root of. A directory with no
repository answers both with the same fatal error. Reading the two apart is what lets the
refusal say *which* of the two it is, and it is the whole difference between "your copy
has no repository" and "this is not a checkout". The order is git first, then the manifest:
a bare clone is refused as a bare clone, which is the more specific fact, and never as a
directory that happens to have no `package.json` — it has no files at all.

**D4 — One resolver, exported from the notes script, used by both.** `releaseTree` lives
in `scripts/release-notes.mjs` beside the `git` helper it uses, and `scripts/release.mjs`
imports it, the direction the two files already have (it imports the version comparison and
the range from there). Two copies of the rule would be two rules; the defect is that
nothing in the tooling said which tree it meant, and a second `git rev-parse` is where that
comes from. It returns `{ root }` or `{ refusal }` rather than throwing: nothing in it
writes, so each script prints the sentence with its own prefix (`release: `,
`release-notes: `) and stops, and a test can read the sentence without a process.

**D5 — The tree is threaded, not re-derived.** Every `git` call in both scripts takes the
tree and passes `-C <tree>`: the tag list, `origin/main`, `HEAD`, the dirty paths, the
archive log and the range. `repoSlug` takes it (it read `git remote get-url origin` from
the working directory, so a release could have been pointed at the remote of whatever
repository the maintainer was standing in), and `prepare` runs `npm run lint` / `npm test`
with `cwd` set to the tree. `lastTag`, `releaseRange`, `archivesInRange`, `archiveOrder`,
`commitsInRange` and `buildDraft` all take the tree as an argument — required, not
defaulted, because a default would be the process working directory, which is the defect.
The exported helpers that take an options object take `root` in it; the ones that took a
bare string take the tree as a second argument.

**D6 — `release:check` names the tree.** The report opens with `tree: <path>`. The
refusals are the interesting output when something is wrong, and a line that says which
checkout the other lines are about is what makes a wrong run visible after the fact — the
`version: 0.2.0` in the reproduction above reads as a statement about the tree the
maintainer is standing in, which is the whole misunderstanding. `inspect` carries the root
so the report and the tag lookup cannot disagree about it.

**D7 — The tests use a real `git init`, and are skipped where there is no `git`.** The
resolver's answer is decided by where `.git` and `package.json` are on the filesystem, so a
mock of `git` would decide it by whatever the mock was told. Each case gets a throwaway
repository under the system temporary directory, removed when the test ends, with the
identity passed on the command line (`-c user.email=… -c user.name=…`) so the developer's
git configuration cannot change the result. `nix flake check` runs the same suite in a
sandbox whose `nativeBuildInputs` are `nodejs` alone, so these tests are skipped there with
a stated reason; adding `pkgs.git` to that list is the one-line change that would run them
in the flake check as well, and it is left out here because this change does not edit
`flake.nix`.

## Trade-offs

| Where the command runs | Before | After |
| --- | --- | --- |
| The repository root | works | works — the one tree the rule accepts |
| A subdirectory of a checkout | worked on the root | refused, naming the root: one `cd` |
| A git worktree root | worked | works — the root of a worktree *is* a repository root, and its `package.json` is a tracked file like any other |
| A subdirectory of a worktree | worked on the worktree | refused, naming the worktree root |
| A `tar`/`cp` copy under `tmp/`, no `.git` | acted on the parent checkout | refused, naming the copy and the repository above it, with `git init` named as the fix |
| The same copy after `git init` | acted on the parent | works on the copy (and its clean-tree check then wants a first commit) |
| A bare clone | threw git's `must be run in a work tree` | refused, naming that a bare repository has no working tree |
| A repository that is not the plugin | failed on a missing version file | refused, naming the absent `package.json` |
| A tree with a manifest and no version files | `ENOENT` with a stack trace | refused, naming the missing places |

Two costs, both accepted. A subdirectory of a checkout is refused (D1), which is the
annoyance that bought the safety; and a `tar` copy needs `git init` before it can be
released in, which `AGENTS.md` and `CONTRIBUTING.md` now say, with `git worktree add
--detach tmp/prepare` as the one-command form that has a history and a clean tree already.
The refusal is the right failure here: the alternative is a script that rewrites four
version files in a tree the maintainer did not name, and reports success.

## Amends the archived design

`openspec/changes/archive/2026-09-29-release-tooling/design.md` records the decisions this
change narrows, and the archive is the record of a shipped change — it is not edited here.
What a note on that archive would have to say: **D8** ("pure core, thin shell … no test
needs a repository") is amended by D7, the tree tests need a repository because the tree is
a filesystem fact; **D6** is amended by D1–D2, `prepare` still edits four files and stops,
but only the files of the tree it is run in; **D7** is amended by D5, `publish` still
refuses by default and still passes `--repo` to `gh`, and the slug now comes from the
release tree rather than from the working directory.

## Risks / Trade-offs (remaining)

- **A maintainer reads the new refusal as a broken tool** → the sentence says what to do
  (`git init`, or run it in the root) and names both trees; `CONTRIBUTING.md` documents the
  scratch-tree workflow next to the command table.
- **A release cut from a worktree is cut from the wrong commit** → unchanged by this
  change and already covered: `publish` refuses a commit that is not on `origin/main`.
- **The tests do not run in `nix flake check`** → stated in D7 with the one-line fix, rather
  than hidden: the suite that matters for this change is `npm test`, which runs them.

## Migration Plan

Behaviour-preserving for every documented workflow except the one that was broken. A
maintainer running a release in the normal checkout sees no change beyond the added `tree:`
line. A maintainer using a scratch copy under `tmp/` now gets a refusal until the copy has
a repository of its own, and the documentation says so in both files.
