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
describes, or work in a scratch copy with `npm ci --ignore-scripts`. Do not replace the
symlink.

## Releasing

A release is a git tag plus a GitHub Release. There is no `CHANGELOG.md` and nothing is
published to npm; consumers take the plugin from the Nix flake, pinned to a tag.

The version is written in three places — `package.json`, `src/index.js` and
`client/client.js`, the last two being what the panel footer reports — and the four commands
below are the only supported way to move them. They refuse rather than guess: a mismatched
version, a dirty tree or an existing tag stops the release with the reason named.

| Command | What it does | What it refuses |
| --- | --- | --- |
| `npm run release:check -- 0.3.0` | Reports the version the three places carry, the last tag and the range a release would cover | Exits non-zero on a mismatch, an uncommitted change outside `tmp/`, an existing `v0.3.0` |
| `npm run release:notes` | Writes a **draft** to `tmp/release-notes-0.3.0.md`: a section per archived OpenSpec change (its `Why` and its `What Changes` bullets) plus the remaining commits | Nothing — it only reads git and the archive |
| `npm run release:prepare -- 0.3.0` | Writes `0.3.0` into the three places, runs `npm run lint` and `npm test`, prints a draft commit message | A version that is not `x.y.z`, is not ahead of the current one, or any failing check |
| `npm run release:publish -- 0.3.0` | Creates the tag `v0.3.0` and the GitHub Release from the reviewed notes file | Runs the checks again, requires the tree to already carry the version, a clean tree, a notes file and an authenticated `gh`; and does nothing at all without `--yes` |

### Cutting a release

```sh
npm run release:check   -- 0.3.0     # is the tree releasable?
npm run release:prepare -- 0.3.0     # writes the version, runs lint and tests
git commit -am "Release 0.3.0"       # the message prepare printed
git push
npm run release:notes                # writes tmp/release-notes-0.3.0.md
#   ← edit it: it is a draft. Keep what a reader deciding to upgrade needs.
npm run release:publish -- 0.3.0    # prints the notes and the gh command, changes nothing
npm run release:publish -- 0.3.0 --yes
git push origin v0.3.0
```

`release:publish` prints the notes and the exact `gh release create` command before it acts,
so `--dry-run` (or simply omitting `--yes`) is enough to review what would happen. It targets
`origin` by default; set `GH_REPO=owner/name` to publish elsewhere.

The notes come from the OpenSpec archive, so they are as good as the proposals behind them.
A change with no archived proposal shows up only as a commit subject — write the prose the
proposal would have carried.
