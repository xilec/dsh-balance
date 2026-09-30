# AGENTS.md — dsh-balance

This project uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) as its spec-driven
layer: agree on the change in `openspec/` first, write code second.

## Repository boundaries

- Work in the current working directory; leave it only on an explicit request.
- One task = one branch from a fresh `origin/main`. Never commit to `main` directly.
- Any text headed to GitHub (commit message, PR, issue, comments) is shown as a draft
  first and waits for approval. `git push` is approved separately.
- Exception — finishing a feature (see below): once correctness is confirmed, archiving,
  the PR, and the merge run autonomously, with no further confirmation requests.
- Commit messages are written in English, with no mention of an AI assistant.

### Finishing a feature: autonomous once confirmed

Until a feature is confirmed correct, the usual rule applies — drafts for approval.
As soon as correctness is confirmed (the user accepted the result, or
`openspec-verify-change` plus tests/lint are green and the user did not object), the
rest proceeds **without stopping for confirmation**:

1. tick off the completed items in the change's `tasks.md`;
2. `openspec validate --all` and `openspec archive <change> --yes`;
3. commit the change (English message, no mention of an assistant);
4. push the branch, open the PR, and merge it (merge commit) unless the repo says otherwise;
5. after the merge — update local `main` and clean up temporary artifacts.

Do not ask again across those five steps: approval was granted together with the feature
confirmation. If the scope shifts or tests/validation fail along the way, stop and go back
to asking.

## Releasing

A release is a git tag plus a GitHub Release; there is no `CHANGELOG.md` and no npm
publish (`package.json` stays `private`). The version of the plugin is written in four
places — `package.json`, `package-lock.json`, `src/index.js`, `client/client.js` —
and the scripts below are the only supported way to move them. When the user asks to cut a release, work in this order and
stop where a draft is required:

1. `npm run release:check -- <version>` — refuses a mismatched version, a dirty tree, an
   existing `v<version>` or a version at or behind the last tag. Fix what it names rather
   than working around it. A non-zero exit means it found a problem, not that it broke.
2. `npm run release:prepare -- <version>` — writes the version into the four places, runs
   `npm run lint` and `npm test`, prints a draft commit message. It does not commit. In a
   kernel-linked development tree the lint tools are absent, so this fails with a message
   about `npm ci --ignore-scripts`; that is the rule, not an obstacle to bypass — do the
   work in a scratch tree under `./tmp/` when the tools are needed, never by replacing the
   kernel symlink in the working tree. A scratch tree has to be a release tree of its own
   (see below), and the version it writes lands there, not in the checkout you release
   from.
3. Commit the bump with the drafted message, **show it first**, then push. The bump has to
   be on `origin/main` before anything is published; `publish` refuses a commit that is not.
4. `npm run release:notes` — writes the notes draft to `tmp/release-notes-<version>.md` from
   the archived OpenSpec changes in the range since the last tag plus the remaining commits.
   **Show the file to the user and wait for approval.** It is prose written for the upgrade
   decision, not for the change record: cut the noise, keep the numbers. Regenerate it if
   the merge added commits of its own.
5. `npm run release:publish -- <version>` — prints the notes and the exact `gh` command and
   refuses to act. Review, then re-run with `--yes`. It creates the tag and the release in
   one step (`gh` creates the tag on the remote and pushes it), so there is no tag to push
   afterwards; `git fetch --tags` afterwards to see it locally.
6. Report the release URL and stop.

### Scratch trees for `release:prepare`

Every release command acts on one tree: the root of the git repository it is run in, and
it has to be run in that root. A directory inside a repository, a copy with no repository
of its own, a bare clone and a repository that is not the plugin are each refused with a
sentence naming the tree that was found and the one that was wanted, and nothing is
written. `release:check` prints `tree: <path>` as its first line, so a run always says
which checkout the rest of its output is about.

A scratch tree under `./tmp/` is inside this repository, so it has to be a git root of its
own:

```sh
git worktree add --detach tmp/prepare   # one command: own root, own history, clean tree
cd tmp/prepare && npm ci --ignore-scripts
npm run release:prepare -- 0.3.0
cd ../.. && git -C tmp/prepare diff | git apply   # the bump, back in the checkout
```

A `tar` or `cp` copy of a worktree has no `.git` at all and is refused until `git init`
makes it a root — and then its clean-tree check wants a first commit, so `git add -A &&
git commit` as well. Because the scratch tree is now the tree the script writes, the four
rewritten files are yours to bring back; the script no longer edits the checkout above it,
which is the point.

Nothing in a release skips the draft steps: step 4 is a GitHub-bound text and step 3 is a
commit, so both wait for the user, even when the feature that precedes them was confirmed
and the autonomous-finish rule above applies. The rule covers finishing a *change*; a
release publishes a *version*, and that is a separate decision. Contributors who are not
releasing need none of this — see `CONTRIBUTING.md`.

## OpenSpec

CLI: `npx @fission-ai/openspec@latest <command>` (not installed globally).
The OpenSpec root is `openspec/` in this repository. Artifacts are written in English;
project context and constraints live in the `context` field of `openspec/config.yaml`.

OpenSpec skills live in `.agents/skills/openspec-*/` and are read by DSH — invoke them by
name (`openspec-propose`, `openspec-apply-change`, ...) instead of replaying the steps by
hand. The `/` menu in DSH caches the skill catalog per session: after `openspec init` or
`openspec update`, new skills appear in autocomplete only after a page reload (or an agent
preset switch); within the current session, type `/openspec-propose` manually.

### Standard loop

```
explore (optional) → propose → apply → sync → archive
```

1. **`openspec-explore`** — think out loud when the task is still taking shape. No code is touched.
2. **`openspec-propose`** — create the change and all artifacts: `proposal.md`, delta specs
   `specs/<capability>/spec.md`, `design.md`, `tasks.md`.
   This is planning only: implementation does not start in the same response.
3. **`openspec-apply-change`** — work through `tasks.md`, implement, tick items off.
4. **`openspec-sync-specs`** — merge delta specs into `openspec/specs/` before archiving,
   when the state needs recording without an archive.
5. **`openspec-archive-change`** — finalize the change and update the main specs.
6. **`openspec-verify-change`** — check that the implementation matches the artifacts
   before archiving.

### CLI reference

```bash
openspec list [--specs] [--json]        # what is in flight
openspec status --change <name> --json  # artifact progress
openspec show <name>                    # content of a change/spec
openspec validate --all --json          # structural validation
openspec archive <name> --yes           # archive (no interactive prompts)
openspec doctor [--json]                # root and reference health
```

### Rules

- Do not hardcode paths from the root: `openspec status --json` returns `root.path`,
  `artifactPaths`, and `actionContext` — use those.
- `openspec/changes/<name>/` is the plan for a change; `openspec/specs/` is the system's
  current behavior. Specs change only through delta specs and archiving.
- If the scope shifts after implementation starts, fix the artifacts first, then the code.
- The `openspec-*` skills and the `openspec/` folder are owned by the CLI: edits inside
  them are overwritten by `openspec update`.
