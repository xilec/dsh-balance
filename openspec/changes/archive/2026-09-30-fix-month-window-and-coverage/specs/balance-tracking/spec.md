# Spec Delta

## MODIFIED Requirements

### Requirement: Per-day ledger, windows and coarse days

The Host SHALL produce one row per calendar day, for `historyDays` days ending with today in
the configured `dayZone`. Each spend interval MUST be attributed to the day of the later
sample. A row whose interval started on an earlier day SHALL be marked coarse, and the row for
today SHALL be the only row marked open. The ledger MUST expose 1-day, 1-week and 1-month
totals, summed from the rows whose day key falls inside a window of that fixed length —
1, 7 and 30 days — independently of `historyDays`, which states only how many day rows are
kept. Each window MUST report the number of days it measures inside itself, and a `covered`
flag that is true only when that number is the whole window: the ledger holds a row for every
day of it and the samples reach back to its first day. When the ledger is shorter than the
window, the window's total MUST be the sum of the rows that exist, `covered` MUST be false,
and the reported day count MUST be what was summed. The credit list MUST be returned newest
first, bounded, with the all-time credit total.

#### Scenario: Day boundary without samples

- **WHEN** the app was closed across midnight and the next sample lands the following day
- **THEN** the whole interval is attributed to the later day and that row is marked coarse

#### Scenario: Window coverage

- **WHEN** the samples start after the first day of the week window
- **THEN** that window's total is reported with `covered: false`

#### Scenario: The ledger is shorter than the month window

- **WHEN** `historyDays` is 3 and the samples cover those three days
- **THEN** the 1-month total is the sum of those three rows, it reports 3 days, and it is
  reported with `covered: false` rather than as a covered month

#### Scenario: The ledger is longer than the month window

- **WHEN** `historyDays` is 400 and the samples reach back further than 30 days
- **THEN** the 1-month total sums the last 30 day rows only, and the day rows older than that
  are kept without entering any window total

#### Scenario: A window the samples do not reach

- **WHEN** the ledger holds every day of a window but the first sample is later than its
  first day
- **THEN** the window reports fewer days than its length and is reported with `covered: false`

#### Scenario: Month boundary

- **WHEN** today is the first day of a month
- **THEN** the day rows roll back into the previous month rather than stopping at the boundary
