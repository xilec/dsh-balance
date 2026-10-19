# Spec Delta

## MODIFIED Requirements

### Requirement: The composer readout

The readout SHALL show, in one unlabelled line, the current session's estimated cost, the account
balance, and the spend of today, of the week so far and of the month so far, separated by dots
and slashes. It MUST carry no visible labels: the legend MUST be the native tooltip and the
panel. The legend MUST name the three windows as today, the week so far and the month so far, and
MUST append the number of calendar days the week and the month span when the payload reports
it. A window whose ledger does not reach back to its first day MUST be shown muted rather than
hidden, and MUST NOT be muted merely because today is early in that week or month. The readout
MUST use the same type size, colour and hover treatment as the shipped token-usage pills, MUST
render the placeholder for every figure before the first payload, and MUST be a button that
opens the panel and closes it again on a second click or `Escape`. Its accessible name MUST be
the same legend the tooltip shows.

#### Scenario: Figures and their legend

- **WHEN** a payload is available
- **THEN** the line shows the session estimate, the balance and the three windows without
  labels, and hovering reveals what each figure is

#### Scenario: Not enough samples for a window

- **WHEN** the samples do not reach back to the first day of a window
- **THEN** that figure is drawn muted while the others stay normal

#### Scenario: A window that is short only by the calendar

- **WHEN** today is a Monday, or the first day of a month
- **THEN** that window's figure is drawn normally, because the ledger does reach its first
  day

#### Scenario: No payload yet

- **WHEN** the first read has not answered
- **THEN** the line shows placeholders rather than a zero

#### Scenario: Opening and closing the panel

- **WHEN** the reader clicks the readout and then presses `Escape`
- **THEN** the panel opens above the line and closes without navigating away
