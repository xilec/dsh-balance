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
