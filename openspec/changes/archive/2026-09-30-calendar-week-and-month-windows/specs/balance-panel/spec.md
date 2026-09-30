# Spec Delta

## MODIFIED Requirements

### Requirement: The composer readout

The readout SHALL show, in one unlabelled line, the account balance, the spend of today, of the
week so far and of the month so far, and the current session's estimated cost, separated by dots
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
- **THEN** the line shows the balance, the three windows and the session estimate without
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

### Requirement: The Summary tab

The Summary tab SHALL present the account as cards for the balance, today, this session, the
week and the month, and below them the detail rows the payload supports: the balance, its
granted and topped-up split, the three windows, the session estimate, the tariff in force and
the instant of the next change, the sample count, the sampling cadence, the credit total with
its event count, and when the balance was last read. A window card MUST name the calendar its
window is anchored to — the week from Monday, the month from its 1st — and both the card and
its detail row MUST be labelled with what the window is ("so far this week", "so far this
month"), never with a fixed count the panel assumed; the number of calendar days the window
spans MUST be shown from the payload's own count, and omitted rather than guessed when the
payload reports none. It MUST flag a stale reading, every window whose ledger does not reach
back to its first day — naming the days that were measured out of the days the window spans, for
that window — a day measured across a day boundary, and every model the rule cannot price, and
MUST NOT flag a window that is short only because today is early in it, and MUST report an
unavailable account rather than a zero.

#### Scenario: A complete reading

- **WHEN** the payload carries a balance and a ledger
- **THEN** the cards and every supported detail row are shown with their values

#### Scenario: A week that started on Monday

- **WHEN** the payload reports a week that measured four of its four days
- **THEN** the week card reads as the week from Monday, its detail row reads as the spend so
  far this week, and both name the four days it spans

#### Scenario: A window shorter than the panel's own label

- **WHEN** the payload reports a 1-month window that measured 3 of the 24 days it spans
- **THEN** the month card and its detail row are not labelled with a length of their own, the
  card names the month from its 1st, and the flags line says 3 of 24 days measured

#### Scenario: A payload with no day count

- **WHEN** the payload's windows report no count of the days they span
- **THEN** the cards and rows name the windows and no count is invented for them

#### Scenario: An unpriced model

- **WHEN** the session used a model with no rate
- **THEN** the flags line names that model

#### Scenario: Only a coarse day

- **WHEN** some day row was measured across a day boundary
- **THEN** the flags line says so, so the reader knows why an override exists
