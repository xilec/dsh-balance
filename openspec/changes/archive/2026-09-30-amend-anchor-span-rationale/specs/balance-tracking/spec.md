# Spec Delta

## MODIFIED Requirements

### Requirement: A manual override is an anchored base

A day row SHALL be correctable by hand through the ledger's override. When an override is
written, the Host MUST remember the account balance of that instant together with the amount
and the instant that balance was read — the same reading the reader was looking at, not a
nearby one — and MUST NOT record an instant for a balance it has not read. The day's value
MUST then be that base plus everything measured since: the drop from the anchor balance to the
newest sample of the same day, plus the credits recorded after the anchor. The added part MUST
be measured only when the anchor lies inside that day's own span of samples — at or after the
day's first sample and at or before its last. What that guarantees is that a base is only
ever added to by a drop between two instants of the same ledger day: the base is a measurement
of the day taken from its first sample onward, so an anchor before that first sample has no
measurement of the day to start from, and an anchor after the last has nothing left to
measure. An anchor before the day's first sample therefore adds nothing even when it lies on
that same day, minutes earlier, before any sample of the day exists. Nothing is lost by that:
the row keeps reporting the day's own sampled spend as its sampled value beside the
correction, and re-entering the correction once the anchor falls inside the day restores the
sampled part. An override written without an anchor (the older file format) MUST stay frozen
at its amount. A day with an override MUST ignore its sampled value.

#### Scenario: A corrected day keeps filling

- **WHEN** the reader sets today's spend by hand and spend continues afterwards
- **THEN** the row shows the base plus the spend measured after the override, and the 1d total
  follows it

#### Scenario: A base anchored to the day's last sample

- **WHEN** an override's anchor is the reading of that day's newest sample
- **THEN** nothing is added to the base, which is the reader's final word for the day

#### Scenario: A correction made after the day closed

- **WHEN** the anchor is later than the last sample of the day it corrects
- **THEN** nothing is added to the base

#### Scenario: A base anchored before the day began

- **WHEN** the anchor is earlier than the first sample of the day it corrects, so the window it
  would be measured over starts on the previous day
- **THEN** nothing is added to the base, because that window carries another day's spend

#### Scenario: A base anchored before the day's first sample, on that same day

- **WHEN** the reader corrects a day that has no sample yet, and the anchor is a reading taken
  on that same day before its first sample — a poll succeeded in the first minutes of the day
  with the balance unchanged, and too little time had passed since the previous day's last
  sample for the heartbeat to fire, so the reader saw that reading and anchored to it; later
  polls then append the day's first and second samples
- **THEN** nothing is added to the base, even though the window would lie inside the day,
  because the base is a measurement taken from the day's first sample onward; the day's
  sampled spend is still reported as the row's sampled value, and re-entering the correction
  once the anchor falls inside the day adds the sampled part

#### Scenario: A correction made while the newest reading is a failed poll's

- **WHEN** an override is written after polls have been failing, so the balance the Host holds is
  the last one it did read
- **THEN** the entry is anchored to that reading and to the instant it was read, and the day
  fills from there rather than being treated as final

#### Scenario: A correction written before any balance was read

- **WHEN** an override is written while the Host has read no balance at all
- **THEN** the entry carries no instant and no balance, and the day stays frozen at its amount

#### Scenario: Clearing an override

- **WHEN** an override is removed by sending no amount
- **THEN** the row falls back to the sampled value

#### Scenario: Override from an older version

- **WHEN** the state file holds an override as a bare number
- **THEN** the row reports that amount as a frozen base and the override is not lost
