# Contributing to dsh-balance

`dsh-balance` is a [DeepSeek Harness](https://github.com/xilec/deepseek-harness) (`dsh`)
plugin: plain JavaScript ESM, no TypeScript, no build step, and the test suite is
`node --test` on the files in `test/`.

- [Working on a change](#working-on-a-change)
- [Releasing](#releasing)

## Working on a change

1. `git fetch origin` and branch from a fresh `origin/main` — one branch per change.
2. Agree on the change in `openspec/` before writing code: `openspec-propose` writes
   `proposal.md`, `design.md`, `tasks.md` and the delta specs under
   `openspec/changes/<name>/`; `openspec-apply-change` implements them. A change that alters
   what the plugin *does* needs a delta spec; repository infrastructure (scripts, docs, CI)
   declares `skip_specs: true` instead.
3. Keep `npm run lint` and `npm test` green. They are the same two checks CI runs
   (`knip` for dead code, `jscpd` for duplication) plus the suite.
4. Open a PR against `main` and merge it with a merge commit.

Commit messages are written in English and describe the change. No generated files, no
"Generated with …" lines, and no mention of an assistant.

A kernel-linked development tree is the normal setup: `node_modules` is a symlink to the dsh
kernel's `node_modules`, which is how the plugin resolves platform packages at runtime. That
symlink does not contain the lint tools, so `npm run lint` does not run locally — use `npx
knip --no-config-hints` and `npx jscpd …` as the `Development` section of `README.md`
describes, or work in a scratch tree with `npm ci --ignore-scripts` (see [Scratch
trees](#scratch-trees) — a scratch tree has to be a git root of its own). Do not replace the
symlink.

## Releasing

A release is a git tag plus a GitHub Release. There is no `CHANGELOG.md` and nothing is
published to npm; consumers take the plugin from the Nix flake, pinned to a tag.

The version is written in four places — `package.json`, `package-lock.json`, `src/index.js`
and `client/client.js`, the first two being what npm installs and the last two what the panel
footer reports — and the four commands below are the only supported way to move them. They
refuse rather than guess: a mismatched version, a dirty tree or an existing tag stops the
release with the reason named.

Every one of them acts on a single tree: the root of the git repository, and the command has
to be run in it. `release:check` prints that path as its first line, so a run always says
which checkout the rest of its output is about.

| Command | What it does | What it refuses |
| --- | --- | --- |
| `npm run release:check -- 0.3.0` | Reports the tree, the version the four places carry, the last tag and the range a release would cover | Exit status 1 on a tree it cannot name, a mismatch, a place the tree does not have, an uncommitted change outside `tmp/`, an existing `v0.3.0`, or a version at or behind the last tag |
| `npm run release:notes` | Writes a **draft** to `tmp/release-notes-0.3.0.md`: a section per archived OpenSpec change (its `Why` and its `What Changes` bullets) plus the remaining commits | A tree it cannot name; otherwise nothing — it only reads git and the archive, and writes under the gitignored `tmp/` |
| `npm run release:prepare -- 0.3.0` | Writes `0.3.0` into the four places of that tree, runs `npm run lint` and `npm test`, prints a draft commit message | A tree it cannot name, a version that is not `x.y.z`, is not ahead of the current one, an existing `v0.3.0`, an unknown flag, or any failing check |
| `npm run release:publish -- 0.3.0` | Creates the tag `v0.3.0` and the GitHub Release from the reviewed notes file | A tree it cannot name; then it runs the checks again, requires the tree to already carry the version, a clean tree, a commit that is on `origin/main`, a non-empty notes file without its `DRAFT` marker, and an authenticated `gh`; and does nothing at all without `--yes` |

Every refusal is a non-zero exit status: `npm run release:check` reporting problems is the
command working, not failing.

### Which tree a command acts on

The scripts used to find the repository with `git rev-parse --show-toplevel`, which is
ambiguous in the one case the release process creates on purpose: a scratch tree under
`./tmp/` is *inside* the checkout, so git answered with the checkout above it and
`release:prepare` run in the scratch tree rewrote the real `package.json`,
`package-lock.json`, `src/index.js` and `client/client.js`. The four version files are not a
place to guess.

A command now runs on the tree it is run in, or refuses:

| Where the command runs | What happens |
| --- | --- |
| The repository root | It acts on that tree — the one thing the rule accepts |
| A subdirectory of a checkout | Refused, naming the root: one `cd` away |
| A `git worktree` root | It acts on the worktree, which is a repository root with the manifest as a tracked file |
| A `tar`/`cp` copy under `tmp/`, no `.git` | Refused, naming the copy and the repository above it, with `git init` named as the fix |
| The same copy after `git init` (and a first commit) | It acts on the copy |
| A bare clone | Refused, naming that a bare repository has no working tree |
| A git repository that is not the plugin | Refused, naming the absent `package.json` |

### Scratch trees

When a kernel-linked tree cannot run `npm run lint`, the release is prepared in a scratch
tree under `./tmp/`, which has its own `node_modules` after `npm ci --ignore-scripts`. That
scratch tree has to be a git root of its own, or it is refused until it is:

```sh
git worktree add --detach tmp/prepare   # own root, own history, clean tree, one command
cd tmp/prepare && npm ci --ignore-scripts
npm run release:prepare -- 0.3.0
cd ../.. && git -C tmp/prepare diff | git apply   # the bump, back in the checkout you release from
```

A `tar` copy of a worktree has no `.git`; `git init` there makes it a root, and the
clean-tree check then wants a first commit (`git add -A && git commit`). The bump the script
writes lands in the scratch tree and is yours to bring back with the `git apply` above —
before, the script silently wrote it into the checkout above the copy, which is the bug the
worktree workflow is now explicit about.

### Cutting a release

```sh
npm run release:check   -- 0.3.0     # is the tree releasable?
npm run release:prepare -- 0.3.0     # writes the version, runs lint and tests
git commit -am "Release 0.3.0"       # the message prepare printed
git push                             # the bump has to be on origin/main before a release
npm run release:notes                # writes tmp/release-notes-0.3.0.md
#   ← edit it: it is a draft. Keep what a reader deciding to upgrade needs.
npm run release:publish -- 0.3.0    # prints the notes and the gh command, changes nothing
npm run release:publish -- 0.3.0 --yes
```

The notes are drafted after the bump is pushed so the range is exactly what the release
covers; regenerate them after the merge if the merge added commits of its own.

`release:publish` creates the tag and the release in one step — `gh` creates the tag on the
remote and pushes it — so there is no `git push origin v0.3.0` afterwards. It prints the
notes and the exact `gh release create` command before it acts, so `--dry-run` (or simply
omitting `--yes`) is enough to review what would happen. It targets `origin` by default; set
`GH_REPO=owner/name` to publish elsewhere, and `git fetch --tags` afterwards to see the tag
locally.

The notes come from the OpenSpec archive, so they are as good as the proposals behind them.
A change with no archived proposal shows up only as a commit subject — write the prose the
proposal would have carried.
