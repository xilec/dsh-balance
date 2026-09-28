# Proposal

## Why

`openspec/specs/` currently documents only `session-cost-analysis`. Everything else the plugin
does — Host-side balance sampling and spend accounting, the tariff rule it bills with, the
settings surface, and the browser-side readout, peak chip and panel — predates OpenSpec and
lives only in code, tests and the README. Without spec-level requirements there is no
authoritative statement of current behavior, no baseline a later change can be proposed as a
delta against, and no cheap way to notice when the code and the documented behavior drift
apart.

## What Changes

- Add four new capabilities that describe the plugin's existing, externally observable behavior:
  balance tracking and accounting, the tariff rule, the settings surface, and the browser-side
  panel and readout.
- Write each requirement against the behavior that is in the tree today, with scenarios that can
  be checked by running the existing suite or by observing the running plugin.
- Touch no implementation code: this change is spec backfill only. Requirements are derived from
  `src/`, `client/`, the test suite and the README; where the code and the README disagree, the
  code is the contract and the divergence is recorded in `tasks.md`.
- Leave `session-cost-analysis` untouched: the Cost view keeps its own spec and its requirements
  are not repeated here.

## Capabilities

### New Capabilities

- `balance-tracking`: Host-side sampling of `GET /user/balance`, on-disk sample and state
  retention, and the spend accounting derived from balance differences — 1d/1w/1m windows, the
  per-day ledger, day overrides, credit events, and the HTTP routes that expose them.
- `tariff-rule`: The published DeepSeek pricing decision the plugin bills with — rates per model
  and their versions, legacy model ids, the Beijing peak windows, Chinese public holidays,
  off-peak pricing at half, fallback rates for unpriced models, and how the rule is exposed to
  the browser half.
- `plugin-settings`: The configuration schema with defaults and validation, the precedence
  between the composition row and values written at runtime, where the runtime state lives, and
  the read/write routes for that state.
- `balance-panel`: The browser half — the composer-dock balance pill, the peak chip in the
  session header, the panel with its Summary, Days, Credits and Settings tabs, formatting and
  colouring rules, and its polling and error behavior.

### Modified Capabilities

None. No existing requirement changes; `session-cost-analysis` is deliberately left as is.

## Impact

- `openspec/specs/` gains four capabilities; `openspec/changes/` gains this change until it is
  archived.
- No file under `src/`, `client/` or `test/` changes, and no runtime behavior changes.
- The `session-cost-analysis` spec keeps referencing the shared settings write; that write is now
  specified in `plugin-settings`, so the two capabilities must stay consistent.
- Future changes to the sampler, the tariff table or the panel can be expressed as deltas against
  these specs instead of prose in a PR description.
