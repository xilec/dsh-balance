# Spec Delta

## MODIFIED Requirements

### Requirement: The sample log on disk is append-only and thinned by age

Samples SHALL be stored under `$DSH_HOME/dsh-balance/` in an append-only NDJSON log carrying
`{t, currency, total, granted, toppedUp}` per line. Reading the log MUST skip a torn or
unparsable trailing line rather than fail, and MUST return the samples ascending by time.
Samples newer than `keepDays` MUST be kept at full resolution; older ones MUST be thinned to
the last sample of each clock hour of the configured `dayZone` — not of UTC — so that a day in a
zone whose UTC offset is not a whole number of hours still keeps a sample from its last hour.
The file SHALL be rewritten through a temporary sibling
and a rename only when thinning actually dropped samples, and a failed compaction write MUST
NOT prevent the history from being read.

#### Scenario: Restart after a crash

- **WHEN** the process died while appending a sample and the file ends in a partial line
- **THEN** the plugin loads every complete sample and ignores the torn tail

#### Scenario: Old history is thinned

- **WHEN** the log holds more than one sample per hour older than `keepDays`
- **THEN** only the last sample of each of those hours is kept and the log is rewritten
  atomically

#### Scenario: Thinning in a zone with a fractional UTC offset

- **WHEN** the configured `dayZone` is a zone whose UTC offset is not a whole number of hours,
  such as `Asia/Kolkata` (+05:30)
- **THEN** the retained hours are the ledger's own clock hours, so every thinned day still
  holds the last sample of that day rather than losing its boundary to a UTC hour

#### Scenario: State directory cannot be resolved

- **WHEN** the Harness home cannot be resolved
- **THEN** the plugin keeps its history in memory only, warns, and never fails a request
