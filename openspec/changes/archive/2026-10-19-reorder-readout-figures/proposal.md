# Proposal

## Why

The compact readout leads with the account balance, which belongs to the whole account, and
buries the session's own cost at the far right. A reader glancing at the pill is asking about the
session in front of them first; the account balance and the calendar windows are context that
should follow.

## What Changes

- The composer readout's line changes from *balance · 1d/1w/1m · session* to
  *session · balance · 1d/1w/1m*. The figures, their formatting, the muted-window treatment, the
  separators and the no-label rule are unchanged.
- The legend — the tooltip and the accessible name — moves with the line, so the labels stay in
  the same order as the figures they describe.
- The panel is untouched: its Summary rows, the Days/Credits tabs and the footer keep their
  current order.
- Tests: the two assertions that pin the compact line's text are updated to the new order.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `balance-panel`: "The composer readout" now fixes the order as the session estimate, then the
  account balance, then today/week/month, and the "Figures and their legend" scenario reads in
  that order.

## Impact

- Modified: `client/client.js` — the `line` and `legend` arrays in `Readout`.
- Modified: `test/client.test.js` — the expected text of the compact line in two cases.
- No HTTP, payload, Host or stored-data change; no dependency change.
