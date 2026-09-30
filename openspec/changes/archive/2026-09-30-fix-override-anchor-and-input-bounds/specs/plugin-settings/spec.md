# Spec Delta

## MODIFIED Requirements

### Requirement: The on-disk state document

The Host SHALL keep its mutable state in `$DSH_HOME/dsh-balance/state.json` as a JSON document
carrying the day overrides, the last client heartbeat, the stored preferences and the update
time. The file MUST be replaced through a temporary sibling and a rename, so a reader never
sees a partial document; a missing file MUST read as empty state, and an unparsable or damaged
document MUST be treated as empty rather than fail the plugin. A failed write MUST warn and
MUST NOT break the running plugin. The corrections it carries MUST be bounded: the document
SHALL hold no more of them than the longest ledger the plugin can show — `historyDays` is
capped at 400 by the configuration schema — and a write that would exceed that MUST drop the
oldest corrections, which no row could show in any case. The bound applies to what a write
adds: a load MUST NOT prune the stored corrections, so a document edited by hand is never
rewritten behind the reader's back.

#### Scenario: Damaged state file

- **WHEN** `state.json` cannot be parsed
- **THEN** the plugin starts with empty overrides and preferences and keeps serving

#### Scenario: Concurrent read during a write

- **WHEN** the state is being replaced while another reader opens the file
- **THEN** the reader sees either the old or the new document, never a partial one

#### Scenario: More corrections than the longest ledger

- **WHEN** a correction is written to a document that already holds as many corrections as the
  longest ledger the plugin can show
- **THEN** the oldest corrections are dropped, the new one is stored, and the answer reports
  the bounded document

#### Scenario: A hand-edited document is not pruned on the way in

- **WHEN** the stored document holds more corrections than the bound, because it was edited by
  hand or written by an older version
- **THEN** the load restores all of them and only a later write brings the document back
  within the bound

### Requirement: Runtime-writable settings

The Host SHALL expose `POST /dsh-balance/settings` accepting any subset of the writable
settings — the account currency, the day zone, both polling cadences, both balance
thresholds, the day-row count and the per-model fallback rates — plus the browser-only
preferences. Each present value MUST be checked, and an invalid one MUST reject the whole
request with `400` and an error naming the offending key. The day zone MUST be accepted only
when the runtime can actually use it: `local`, or an IANA name the runtime's own date
formatter accepts. The same check governs a zone restored from the document and a zone the
composition row supplies, so the zone the payload reports is always the one the ledger is
reading in rather than a name the ledger silently fell back from. Accepted settings MUST be
normalized (for example the currency upper-cased and unknown entries in a rate map dropped)
and applied to the running Host, and a changed sampling cadence MUST restart the sampler. Keys
the request does not name MUST be left alone, and unknown keys MUST be ignored. The answer MUST
list the keys that changed together with the stored preferences, the fallback rates and the
sampling cadences.

#### Scenario: Changing the day zone

- **WHEN** a valid day zone is posted
- **THEN** the Host applies it, persists it and reports it as changed

#### Scenario: Rejected value

- **WHEN** a cadence below its minimum is posted
- **THEN** the answer is `400` naming that key and the running configuration is unchanged

#### Scenario: A zone the runtime cannot use

- **WHEN** a day zone no formatter accepts is posted
- **THEN** the answer is `400` naming `dayZone`, and the zone the ledger is reading in is
  unchanged

#### Scenario: A row naming a zone the runtime cannot use

- **WHEN** the composition row supplies a day zone no formatter accepts
- **THEN** the Host reads the ledger in its own zone and the payload reports that zone

#### Scenario: A new cadence takes effect

- **WHEN** the polling cadence is changed through the route
- **THEN** the sampling loop is rescheduled with the new value

#### Scenario: Fields the request omits

- **WHEN** the request names only the day row count
- **THEN** no other setting is written or reported as changed
