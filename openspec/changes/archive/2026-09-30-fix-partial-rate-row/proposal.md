# Proposal

## Why

The fallback-rate editor decides between three cases — an all-empty row removes the model's
entry, a complete row is written, an invalid row is refused — by counting the non-empty fields
of a row and then converting **every** field with `Number()`. An empty field converts to `0`,
which passes both the `Number.isFinite` and the `>= 0` check, so a reader who types a cache-miss
rate and presses Save gets `{ cacheMiss: X, cacheHit: 0, output: 0 }` written: the Host
reprices the whole history with two zero rates and no message is shown. That is wrong money on
the chip, the panel and the Cost view, and `openspec/specs/balance-panel/spec.md` already
requires the refusal — the code simply did not implement it.

## What Changes

- `RateEntry`'s save handler treats an empty or whitespace-only field as a refusal rather than
  as a rate of zero. The row is written only when every one of the three fields is a
  non-negative number; otherwise the existing `cost.rates.invalid` message is shown and nothing
  is submitted to the Host. The all-empty row keeps removing the entry, and the complete row
  keeps being written unchanged.
- No new copy: the refusal reuses the message that was already there for a negative rate,
  because that message already says what is wrong ("every rate must be a non-negative
  number") and an empty field is not a number.
- A test case in `test/client.test.js` for the partially filled row: the status is rendered
  and nothing reaches the Host. The all-empty, complete and negative cases are unchanged.
- No delta specs: the requirement is unchanged, the code was wrong. See `skip_specs: true`.

## Capabilities

### New Capabilities

None — see `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None — `balance-panel`'s Settings-tab requirement already states that a row is "written only
when every rate is a non-negative number". This change makes the code match it.

## Impact

- Modified: `client/client.js:3777-3784` (the rate write loop in `RateEntry`), plus the JSDoc
  above it if the reasoning needs to be recorded there.
- Modified: `test/client.test.js` — one new case inside the existing rate-editor test.
- Both editors are covered by the single fix: the Settings tab (`client.js:3839`) and the Cost
  view (`client.js:3533`) render the same `RateEntry` component, so there is one write loop,
  not two.
- No new dependency, no Host-side change, no HTTP or payload change. Already-stored rows that
  hold a zero rate are not migrated — a zero is a legitimate rate the reader may have typed on
  purpose, and the fix is about what the editor accepts from now on.
