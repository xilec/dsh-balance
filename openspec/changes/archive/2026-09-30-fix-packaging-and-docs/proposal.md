# Proposal

## Why

A review of the packaging and the documentation found four statements that no longer describe
the tree. None breaks the plugin at runtime; each costs a contributor an afternoon.

- `cordis.patch.yml` says the composition row's `name` points at `lib/index.js`. The flake
  ships `$out/src/index.js` — a directory that has never existed.
- The README says CI runs "on every push and pull request". `ci.yml` triggers on pushes to
  `main` and on pull requests only, so a feature-branch push starts nothing.
- The README's layout calls `client/client.js` "the readout, the peak chip, the panel". The
  file is 4732 lines and also holds the Cost view, the Indicators UI and the export builder.
- `package.json` says `0.2.0` and the lockfile's root entry says `0.1.0`, because
  `release:prepare` writes three files and never the lockfile — every release recreates the
  drift. `npm ci` accepts it (measured, `design.md`), so this one is housekeeping, not a
  broken release.

## What Changes

- `cordis.patch.yml`: the header comment names the real path (`src/index.js`) and drops the
  `lib/` prefix, which is the only drift the file carried.
- `README.md`: the CI sentence says what `ci.yml` actually triggers on — pushes to `main` and
  pull requests — and points a contributor at the local commands the Development section
  already lists, because a feature-branch push is where CI is silent.
- `README.md`: the layout line for `client/client.js` says it holds the whole browser half —
  the readout, the peak chip, the panel, the Cost view with its Indicators and the export
  builder.
- `scripts/release.mjs`: `prepare` brings `package-lock.json`'s root version with it, through
  the same `VERSION_PLACES` loop and the same `rewriteVersionIn` rule the other three files
  use, so the lockfile becomes a fourth place that cannot drift on its own. A test pins the
  pure part: a lockfile whose root version is behind is rewritten, and one whose version line
  is missing or ambiguous is refused rather than guessed at.
- No delta specs: nothing about how the plugin behaves changes. See `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None — the six claims the review asked to be checked turned out to be true as written (the
flake output covers every bare import, `files` covers every `exports` target, CI reads
`engines.node` and all four dev pins resolve on the public registry, the peak windows, the
preset factors, the balanced `spike` threshold, the sample output lines and the config
defaults all match the code), so there is no requirement to restate. The evidence is in
`design.md`.

## Impact

- Modified: `cordis.patch.yml` (comment only), `README.md` (three lines plus the CI
  sentence), `CONTRIBUTING.md` (the "three places" wording), `scripts/release.mjs` (one entry
  in `VERSION_PLACES` and the code that reads it), `package-lock.json` (its two root version
  fields) and `test/release.test.js` (three new cases).
- `VERSION_PLACES` gains a fourth place, so the "three places that carry the version" wording
  in `release.mjs`'s header, in `CONTRIBUTING.md` and in the README's Releasing section
  becomes four. All three are corrected here; `AGENTS.md` says the same thing and is the
  orchestrator's file, so it is left for that PR.
- `inspect` reads the lockfile like the other places, so `check`, `prepare` and `publish` all
  see a mismatched lockfile and report it as a mismatch instead of ignoring it.
- No new dependency, no plugin behaviour, no HTTP or payload change. The lockfile entry is
  the root package's own `name`/`version`; npm rewrites both from `npm install`, so the
  release tooling writes exactly what npm would.
