# Spec Delta

## MODIFIED Requirements

### Requirement: Per-day ledger, windows and coarse days

The Host SHALL produce one row per calendar day, for `historyDays` days ending with today in
the configured `dayZone`. Each spend interval MUST be attributed to the day of the later
sample. A row whose interval started on an earlier day SHALL be marked coarse, and the row for
today SHALL be the only row marked open.

The ledger MUST expose three totals, each summed from the rows whose day key falls inside a
window that ends with today: 1-day is today alone, 1-week runs from the Monday of the current
week through today, and 1-month runs from the first day of the current month through today. The
week MUST start on Monday — the ISO 8601 week — and not on Sunday. Each window's range MUST be
derived from the ledger's own day keys rather than from a fixed number of days, so a week is one
day long on a Monday and seven on a Sunday, and a month is as long as the month has. None of the
three ranges depends on `historyDays`, which states only how many day rows are kept.

Each window MUST report `days`, the number of calendar days from its first day through today,
and `measured`, the number of those days that the day rows and the samples really fill: the
smaller of `days`, the rows that exist, and the days the samples span. A `covered` flag MUST be
true only when `measured` equals `days` — the ledger holds a row for every day of the window and
the samples reach back to its first day. When the ledger is shorter than the window, the
window's total MUST be the sum of the rows that exist, `covered` MUST be false, and `measured`
MUST say how much of the window was summed. A window that is short only because today is early
in it — the first day of a week or of a month — MUST still be reported as covered when the
ledger reaches back to that first day.

The credit list MUST be returned newest first, bounded, with the all-time credit total.

#### Scenario: Day boundary without samples

- **WHEN** the app was closed across midnight and the next sample lands the following day
- **THEN** the whole interval is attributed to the later day and that row is marked coarse

#### Scenario: The week runs from Monday

- **WHEN** today is Thursday 2026-09-24 and the ledger holds every day of that week
- **THEN** the 1-week total sums Monday 2026-09-21 through today, reports 4 days, and is
  reported as covered

#### Scenario: A Monday is a one-day week

- **WHEN** today is a Monday
- **THEN** the 1-week total is the 1-day total, it reports 1 day, and it is reported as
  covered

#### Scenario: The day before a Monday

- **WHEN** today is Sunday
- **THEN** the 1-week window is the Monday six days earlier, so the week is already 7 days
  long

#### Scenario: The month starts on the 1st

- **WHEN** today is the first day of a month
- **THEN** the 1-month total is the 1-day total and reports 1 day, while the 1-week total
  still starts on the Monday before it

#### Scenario: Month boundary

- **WHEN** today is the last day of a month
- **THEN** the 1-month total spans every day that month has, and the day rows older than the
  1st are kept without entering any window total

#### Scenario: February in a leap year and outside one

- **WHEN** today is 2024-02-29
- **THEN** the 1-month total reports 29 days, and when today is 2026-02-28 it reports 28

#### Scenario: The year boundary

- **WHEN** today is the first day of January
- **THEN** the 1-month total is that day alone, and when today is 31 December it is the 31
  days of that December

#### Scenario: Window coverage

- **WHEN** the samples start after the first day of the week window
- **THEN** that window's total is reported with `covered: false`

#### Scenario: The ledger is shorter than the month window

- **WHEN** `historyDays` is 3, today is Thursday 2026-09-24, and the samples cover those
  three days
- **THEN** the 1-week and 1-month totals are the sum of those three rows, each reports 3
  measured days against the 4 and 24 the window spans, and both are reported with
  `covered: false` rather than as a covered week and month

#### Scenario: A window short only by the calendar

- **WHEN** `historyDays` is 3, today is Wednesday 2026-09-23, and the samples cover those
  three days
- **THEN** the 1-week total is reported as covered, because its three days are the whole
  week, while the 1-month total is reported with `covered: false`

#### Scenario: The ledger is longer than the month window

- **WHEN** `historyDays` is 400 and the samples reach back further than the month
- **THEN** the 1-month total sums the calendar month only, and the day rows older than its
  first day are kept without entering any window total

#### Scenario: A window the samples do not reach

- **WHEN** the ledger holds every day of a window but the first sample is later than its
  first day
- **THEN** the window reports fewer measured days than its own `days` and is reported with
  `covered: false`

#### Scenario: A week that spans a daylight-saving change

- **WHEN** the week of the ledger's zone contains a daylight-saving transition
- **THEN** the window still spans seven day keys, one per calendar day of that zone, and
  the day rows inside it are contiguous

#### Scenario: A zone with a fractional UTC offset

- **WHEN** `dayZone` is a zone whose UTC offset is not a whole number of hours, such as
  `Asia/Kolkata` (+05:30)
- **THEN** the week's first day is the Monday of that zone's own calendar, not of UTC's
