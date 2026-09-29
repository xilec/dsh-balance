# Design

## Context

See `proposal.md` — Why. The measurements behind the four findings, and the checks behind the
six claims the review asked to be verified rather than assumed.

### 1. The patch file's path

`cordis.patch.yml` lines 3-5, in Russian, say the row's `name` points at `lib/index.js` and
that the browser half is found through `exports["./client"]` of the nearest `package.json`.
The first half is the drift: `flake.nix`'s `runCommand` copies `package.json`,
`cordis.patch.yml`, `src/` and `client/` into `$out` and nothing else, so the shipped entry
point is `$out/src/index.js`. The second half is correct — `client/client.js:1-18` and the
README's Home Manager snippet agree with it. `flake.nix`'s own comment already says
`src/index.js`, so the flake and the patch file disagree and the flake is right.

Nothing else in the patch file mentions a path: the seven config keys are
`refreshIntervalMs`, `clientPollIntervalMs`, `currency`, `warningThreshold`, `dangerThreshold`,
`dayZone` and `historyDays`, and every one of them is a key of `Config` in `src/index.js` with
the value the comment claims. The file is otherwise in sync.

### 2. When CI runs

`.github/workflows/ci.yml` is `on: push: branches: [main]` and `on: pull_request`, so the
three jobs (`test`, `lint`, `package`) run on a push to `main` and on every pull request — and
on nothing else. A push to a feature branch is silent; the pull request is what runs it. The
README's Development section already carries the local equivalents (`npm test`, `nix flake
check`, and the two `npx` lint invocations for a kernel-linked tree), so the corrected sentence
points there instead of inventing a second list.

### 3. The layout line

`client/client.js` is 4732 lines against 9050 for `src/` and `client/` together. What is in
it: the readout (`Readout`, `client.js:1171`), the peak chip (`createPeakChip`,
`client.js:1250`), the panel (`Popover`, `Summary`, `DaysTable`, `Credits`, `Settings`,
`client.js:1348-1703`), the Cost view and its chart, inspector, findings table and export
builder (`CostView` at `client.js:3067`, `Findings` at `client.js:3592`, `EXPORT_TEXT_LIMIT`
at `client.js:2523`), plus the style sheet and the two locales. The three surfaces named in
the line are the first 1700 lines.

### 4. Does the lockfile drift break `npm ci`?

Measured, not guessed. A scratch copy of the tree at the review's state (manifest `0.2.0`,
lockfile root `0.1.0`), with a real `node_modules` from `npm ci --ignore-scripts`:

```
added 142 packages, and audited 143 packages in 884ms
found 0 vulnerabilities
```

`npm ci` does not compare the manifest's `version` with the lockfile root's, so the install
succeeds and the test and lint jobs are unaffected. What the drift does do is leave the file
lying: `npm install --package-lock-only` in the same scratch copy rewrote both `version`
fields to `0.2.0`, which is the shape `prepare` has to produce. So the fix is housekeeping —
a wrong number in a file nobody reads — and the reason to fix it in the tooling is that
`prepare` is the only thing that writes the version, and it was writing three of the four
places.

`VERSION_PLACES` is already a list with a per-file pattern and a `rewriteVersionIn` that
refuses anything but exactly one match. The lockfile needs a fourth entry and nothing else:
its root entry carries `"name": "dsh-balance", "version": "0.1.0"` on the line after
`"packages": {`, and the same pattern finds it. The two `version` fields (the top-level one
and the `packages[""]` one) are both the root package's version, and npm keeps them equal, so
`rewriteVersionIn`'s exactly-one-match rule has to be satisfied by a pattern that hits one of
them — the anchor is what picks which.

`inspect` reads `VERSION_PLACES`, so a lockfile that has drifted is now a mismatch reported by
`check`, `prepare` and `publish` alike, and `checkRefusals` already knows how to phrase it.

### The six claims the review asked to be checked

Each was verified by reading or running, not by reading the comment next to it:

- **The flake output covers every bare import.** `src/` and `client/` import exactly four bare
  specifiers — `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-home-paths` in `src/index.js`,
  `zod` and `@deepseek-ai/dsh-chunked-list` in `src/session-cost.js` — plus `node:fs/promises`
  and `node:path` in `src/store.js` and a `require('react')` the module loader supplies in
  `client/client.js`. Every one of them is a platform package the consumer's `node_modules`
  symlink provides; the flake output carries no third-party files and needs none. True.
- **`files` covers what `exports` points at.** `exports` names `./src/index.js`,
  `./client/client.js` and `./package.json`; `files` lists `src` and `client`, and npm always
  includes `package.json` whatever `files` says. True (and the package is `private`, so `files`
  only matters if it is ever packed).
- **CI's `node-version-file: package.json` reads `engines.node`.** Read from
  `actions/setup-node`'s `src/util.ts`: it tries `volta.node`, then `devEngines.runtime`, then
  `engines.node`, and returns null only if the manifest is JSON with none of them. The CI
  comment is accurate. All four dev pins resolve on the public registry — `npm view
  @deepseek-ai/dsh-chunked-list@0.1.7-rc.2`, `@deepseek-ai/dsh-home-paths@0.1.7-rc.2`,
  `@deepseek-ai/schemastery@3.18.4` and `zod@4.4.3` each returned their exact version.
- **The README's stated Node requirement matches `engines.node`.** It states none, which is a
  gap rather than a falsehood: `engines.node` is `>=22`, and the Development section's command
  block now says so instead of leaving a reader to find it in the manifest.
- **The README's numbers match the code.** Peak windows `PEAK_WINDOWS_BJT_MINUTES` is
  `[[9*60, 12*60], [14*60, 18*60]]` Beijing time and `OFF_PEAK_RATIO` is `0.5`, as documented.
  The 2026-09-10 12:00 BJT Flash cut is in `RATE_SCHEDULE`. `PRESETS` is
  `{ strict: 1.5, balanced: 1, loose: 0.6 }` and the `spike` indicator's `madMultiple` is `6`,
  so the README's `6 × 1.5 = 9` example is right. The ten indicator ids in the README table
  are the ten `id:` fields in `src/indicators.js`, in the same order, and `expensive-subtree`'s
  `share: 0.3` is the "a third" the README claims. Every default in the config table
  (`refreshIntervalMs` 300000, `clientPollIntervalMs` 15000, `currency` USD, `dayZone` local,
  `historyDays` 30, `keepDays` 120, `warningThreshold` 10, `dangerThreshold` 5, `preset`
  `balanced`) matches `Config` in `src/index.js`. The legacy model ids in the pricing section
  match the classifier at `src/pricing.js:399-401`. The export's 2000-character cut matches
  `EXPORT_TEXT_LIMIT` in `client/client.js:2523`. The two sample output lines are the chip's
  own strings: `client.js:8` and the `peak.chip.off` template with `formatRemaining`'s
  `2d 15h` form. All true.
- **Found beyond the list, fixed here:** `CONTRIBUTING.md` said the version lives in "three
  places" in three places of its own, and the `release.mjs` header said it twice. All of it
  is corrected alongside the code. `AGENTS.md` says the same thing and is deliberately left
  for the orchestrator: half a dozen branches of this epic are editing that file, and the
  conflict would be about wording.

## Goals / Non-Goals

**Goals:**

- Four statements that were wrong are true again, in the place a reader reaches for them.
- The lockfile version cannot drift again, because the one script that writes versions writes
  it, and the script refuses on anything it cannot rewrite unambiguously.
- A test on the pure part: the fourth entry rewrites a stale lockfile and refuses an
  unreadable one.

**Non-Goals:**

- Validating the lockfile's dependency graph, or running `npm install` from `prepare`. The
  entry is rewritten as text so `prepare` stays a file editor, not a package manager.
- A spec or capability change. Nothing here is behaviour.
- Rewording the README. Two lines and one sentence change; the rest of the document is left
  byte-for-byte alone.

## Decisions

**The lockfile is a fourth `VERSION_PLACES` entry, not a special case in `prepare`.** The list
is already the answer to "where does the version live", and `inspect`, `checkRefusals` and
`prepare` all read it. A special case in `prepare` would write the lockfile without `check`
ever seeing it, which is the half of the problem that made the drift invisible in the first
place.

**The pattern is anchored on the root entry, not the first `"version"` in the file.** The
lockfile has two `version` fields for the root package and hundreds more for its dependencies,
and `rewriteVersionIn` refuses anything but exactly one match — so the pattern has to select
the root's and only the root's. `("packages"\s*:\s*\{\s*"")` followed by the name and version
is what identifies it, and it is what the test pins.

**The wording changes with the count.** "Three files", "three places" and "the three version
places do not all carry the same x.y.z version" are all true today and false after this
change; the refusal text in `checkRefusals` is a user-facing string and had to follow.

**The README's CI sentence names the trigger and the local commands.** Saying "CI runs on
pushes to `main` and on pull requests" is the fact; adding that a feature-branch push is
silent, and that the Development block above is what to run locally, is the part that saves
the afternoon.

**`client/client.js` is described by what is in it, not by size.** "The whole browser half —
the readout, the peak chip, the panel, the Cost view with its Indicators, and the history
export builder" is checkable against the file; "the largest file in the project" is a number
that goes stale.

## Risks / Trade-offs

- [A fourth place makes `check` refuse on a lockfile a contributor edited by hand] → That is
  the point: a hand-edited lockfile with a different root version is the drift. `npm install`
  writes the same value, so the file cannot legitimately disagree.
- [The pattern could match a dependency's `version`] → It is anchored on `"packages": { ""`
  and the root's own name, and `rewriteVersionIn` refuses anything but a single match; a test
  covers a lockfile whose root line is missing.
- [A line-number-free README gets a vaguer] → The two corrected lines are longer than the ones
  they replace by a few words. The layout block's alignment is kept.
- [Touching `scripts/release.mjs` risks the release gates] → The loop is unchanged; it is the
  same `writeFileSync` over the same `rewriteVersionIn`, and `test/release.test.js` already
  covers the other three places.

## Migration Plan

None. A comment, three lines of documentation and one extra entry in a list. The lockfile in
the tree is brought to `0.2.0` in the same commit that adds the entry, so the next release
finds nothing to fix.

## Open Questions

None.
