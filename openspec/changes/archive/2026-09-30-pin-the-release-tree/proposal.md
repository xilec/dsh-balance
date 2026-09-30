# Pin the release tree: a scratch copy must not rewrite the checkout above it

## Why

`scripts/release.mjs` and `scripts/release-notes.mjs` both located the repository with
`git rev-parse --show-toplevel`, and that answered with the wrong tree in a workflow the
repository itself documents. `AGENTS.md` §Releasing step 2 tells the maintainer that a
kernel-linked development tree has no lint tools of its own and that the work is to be
done "in a scratch copy under `./tmp/`". `tmp/` is inside the repository, so the copy has
no `.git` of its own, git walks up, and the scripts acted on the **parent** checkout.

The final release-gate review hit exactly that: `release:prepare -- 0.3.0` in a scratch
copy under `tmp/` rewrote the real `package.json`, `package-lock.json`, `src/index.js` and
`client/client.js` from 0.2.0 to 0.3.0, printed `wrote 0.3.0 to …`, and only then failed
on the missing lint tools. The four files that define the released version were edited by a
command that had been told to work somewhere else, and nothing in the output said so.

Reproduced from a stand-in checkout: a directory holding nothing but `scripts/`, inside a
repository, with `node scripts/release.mjs check 0.3.0` in it:

```
release: this clone carries no tags, so the range below is the whole history
version: 0.2.0
last tag: none
next release would cover: the whole history (no tag yet)
```

`0.2.0` is the version of the repository *above* the scratch directory. `release:prepare`
in the same place wrote the version into that repository's four files.

## What Changes

- `scripts/release-notes.mjs` gains one resolver, `releaseTree`, and every path either
  script touches hangs off the tree it returns: the four version files, `package.json`,
  `tmp/release-notes-<version>.md`, the archive walk, and every `git` call, which all name
  the tree with `-C` instead of the process working directory.
- The tree is the root of the git repository the command was run in, and the command has
  to be run *in* it. A directory inside a repository, a directory with no repository of its
  own, a bare clone and a repository that is not the plugin are each refused with a
  sentence naming the tree that was found and the one that was wanted. Nothing is written.
- `release:check` prints `tree: <path>` as its first line, so a run always says which
  checkout it is about.
- `test/release.test.js` covers the resolver against real directories and a real `git init`:
  a directory inside a repository, the repository root, a worktree root and its
  subdirectory, a copy with no git at all, a bare clone, and a repository without the
  manifest. One test runs both scripts as processes from inside another repository and
  asserts the refusal names that repository and the directory, and that no version is
  reported.
- `AGENTS.md` §Releasing and `CONTRIBUTING.md` say that a scratch tree now has to be a
  repository root of its own — `git worktree add --detach tmp/prepare` is one command and
  is what the documentation recommends, a `tar` copy needs `git init` — and that the
  version the scratch tree now writes has to be brought back to the real checkout
  explicitly, because the script no longer writes there for the maintainer.

Nothing else. No spec requirement changes: the release tooling has no capability spec
(`skip_specs: true` since `2026-09-29-release-tooling`), and the plugin is untouched.
