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
day's first sample and at or before its last — because a window that starts before the day
began carries the previous day's spend, and one that ends after the last sample has nothing
left to measure. An override written without an anchor (the older file format) MUST stay frozen
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

- **WHEN** the anchor is earlier than the first sample of the day it corrects, so the drop it
  would be measured over starts on the previous day
- **THEN** nothing is added to the base, because that window carries another day's spend

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

### Requirement: The ledger write routes

The Host SHALL expose `POST /dsh-balance/overrides` to set or clear one day's base and
`POST /dsh-balance/refresh` to force an immediate balance fetch. The override route MUST
reject a missing or malformed `date` and a negative or non-numeric `amount` with `400` and a
message naming the field, MUST treat a null, empty or absent amount as the removal of the
override, MUST reject a well-formed `date` the history cannot hold — a day older than the wider of the
ledger's own rows and the sample retention, or later than the day after the ledger's today, both
in the ledger's own zone — with `400` and an error naming the field, and MUST accept a removal for any well-formed
date, since a removal can only shrink what is stored. It MUST persist the accepted change, and
MUST answer with the overrides and the refreshed ledger. The refresh route MUST tolerate an
unreadable body, MUST await the shared in-flight fetch, MUST wait for the stored state to be
read before it builds its answer — the same wait the read route does — and MUST answer with
the same payload as the read route, so a refresh during the start-up load reports the history
on disk rather than an empty one. Both routes MUST answer a non-POST method with `405`.

#### Scenario: Correcting a day

- **WHEN** a valid date and a non-negative amount are posted to the override route
- **THEN** the override is stored, persisted, and the refreshed ledger is returned

#### Scenario: Bad override

- **WHEN** the posted amount is negative or the date is not `YYYY-MM-DD`
- **THEN** the answer is `400` with an error naming the offending field and nothing is stored

#### Scenario: A day the history cannot hold

- **WHEN** a well-formed date outside that history is posted — a year 0001, a year
  9999, or a day further ahead than the ledger's tomorrow
- **THEN** the answer is `400` with an error naming `date`, and no key is added to the stored
  corrections

#### Scenario: Removing a day the history cannot hold

- **WHEN** a removal is posted for a well-formed date outside that history
- **THEN** the answer is `200` and the stored corrections are unchanged

#### Scenario: Forced refresh

- **WHEN** the panel asks for a refresh
- **THEN** the Host performs a balance fetch and returns the updated payload

#### Scenario: A refresh during the start-up load

- **WHEN** a refresh is asked for while the stored samples are still being read, and the poll
  itself returns before that read finished
- **THEN** the answer reports the samples and the ledger the log on disk holds, not an empty
  history and an all-zero ledger
