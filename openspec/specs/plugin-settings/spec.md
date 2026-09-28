# plugin-settings Specification

## Purpose
The configuration surface of the plugin: the fields and defaults a profile row can set, the
subset the panel may change while the Host runs, the precedence between the row and a stored
change, and the on-disk state that carries both the settings and the browser's own choices.

## Requirements

### Requirement: Configuration schema and defaults

The plugin SHALL declare a configuration schema in which every field is overridable from the
composition row, each with the default, type and constraint it documents. The schema MUST be
validated strictly: a value of the wrong type or outside the declared range MUST be rejected
rather than coerced, while keys the schema does not declare MUST be kept in the parsed result
and ignored by the plugin. The declared defaults MUST be the values used when the row omits a
field.

#### Scenario: A row with one field

- **WHEN** the composition row sets only the currency
- **THEN** every other field keeps its declared default

#### Scenario: An out-of-range value

- **WHEN** the row sets a cadence below the schema minimum
- **THEN** configuration parsing fails instead of silently clamping the value

#### Scenario: An unknown key

- **WHEN** the row carries a key the schema does not declare
- **THEN** configuration still parses and the key has no effect

### Requirement: The composition row stays the source of truth

A value written at runtime SHALL win only for the key the panel actually wrote. On startup the
Host MUST read the row, then overlay the stored preferences for exactly those keys, so a later
edit of the row for any other key still takes effect. The Host MUST NOT persist its whole
runtime configuration, because doing so would shadow every later row edit.

#### Scenario: A row edit survives

- **WHEN** the panel has written one setting and the operator later changes a different field
  in the row and restarts the Host
- **THEN** the stored key keeps the panel's value and the other key takes the row's new value

#### Scenario: A stored value is invalid

- **WHEN** the stored preferences hold a value that no longer passes its check
- **THEN** the value is ignored and the row's value applies

### Requirement: State is restored before anything is written

The Host SHALL finish reading its on-disk state before any write can put it back. A request
that needs the loaded state MUST await the load rather than edit a half-filled structure, and
everything the state file holds — the day overrides, the client identity and the preferences —
MUST be taken into memory before a write triggered during the load can occur. A write must
therefore never blank an identity or a stored choice.

#### Scenario: A request arrives during startup

- **WHEN** a settings or override write is requested before the load has completed
- **THEN** the request waits for the load and then acts on the restored state

#### Scenario: A migration writes during the load

- **WHEN** loading upgrades stored data and persists as a side effect
- **THEN** the file keeps the client identity and the preferences that were just read

### Requirement: The on-disk state document

The Host SHALL keep its mutable state in `$DSH_HOME/dsh-balance/state.json` as a JSON document
carrying the day overrides, the last client heartbeat, the stored preferences and the update
time. The file MUST be replaced through a temporary sibling and a rename, so a reader never
sees a partial document; a missing file MUST read as empty state, and an unparsable or damaged
document MUST be treated as empty rather than fail the plugin. A failed write MUST warn and
MUST NOT break the running plugin.

#### Scenario: Damaged state file

- **WHEN** `state.json` cannot be parsed
- **THEN** the plugin starts with empty overrides and preferences and keeps serving

#### Scenario: Concurrent read during a write

- **WHEN** the state is being replaced while another reader opens the file
- **THEN** the reader sees either the old or the new document, never a partial one

### Requirement: Runtime-writable settings

The Host SHALL expose `POST /dsh-balance/settings` accepting any subset of the writable
settings — the account currency, the day zone, both polling cadences, both balance
thresholds, the day-row count and the per-model fallback rates — plus the browser-only
preferences. Each present value MUST be checked, and an invalid one MUST reject the whole
request with `400` and an error naming the offending key. Accepted settings MUST be normalized
(for example the currency upper-cased and unknown entries in a rate map dropped) and applied
to the running Host, and a changed sampling cadence MUST restart the sampler. Keys the request
does not name MUST be left alone, and unknown keys MUST be ignored. The answer MUST list the
keys that changed together with the stored preferences, the fallback rates and the sampling
cadences.

#### Scenario: Changing the day zone

- **WHEN** a valid day zone is posted
- **THEN** the Host applies it, persists it and reports it as changed

#### Scenario: Rejected value

- **WHEN** a cadence below its minimum is posted
- **THEN** the answer is `400` naming that key and the running configuration is unchanged

#### Scenario: A new cadence takes effect

- **WHEN** the polling cadence is changed through the route
- **THEN** the sampling loop is rescheduled with the new value

#### Scenario: Fields the request omits

- **WHEN** the request names only the day row count
- **THEN** no other setting is written or reported as changed

### Requirement: Browser preferences are stored, never applied

The preferences that belong to the browser half — the Cost view's metric, its X axis, its
Tariff projection, its top-K mode and its open tab — SHALL be accepted by the settings route,
persisted and echoed back to the browser, and MUST NOT be applied to the Host configuration.
The view's brush and zoom MUST NOT be stored, so reopening the view shows the whole range.

#### Scenario: A stored view choice

- **WHEN** the reader changes the metric and reloads the page
- **THEN** the preference is returned by the read route and the view reopens with it

#### Scenario: Brush is not a preference

- **WHEN** the reader zooms into a range and reloads
- **THEN** the zoom is not restored

#### Scenario: An invalid choice

- **WHEN** a preference value outside its allowed set is posted
- **THEN** the answer is `400` naming the key

### Requirement: The client heartbeat

The Host SHALL expose `POST /dsh-balance/hello` for the browser half to check in. The route
MUST tolerate an unreadable body, MUST record the reported version, the instant, and whether
the contact was a mount or a later read, MUST persist that identity fire-and-forget, and MUST
answer with the current sampling cadences so the browser can time its own polling. The recorded
identity MUST survive a Host restart and MUST be part of the read payload, so a headless
diagnosis can tell whether the browser half ever loaded.

#### Scenario: The browser half mounts

- **WHEN** the view mounts and heartbeats
- **THEN** the Host counts a mount, stores the identity, and returns the cadences

#### Scenario: A later read

- **WHEN** the same browser half heartbeats again
- **THEN** the Host counts a read, distinguishing it from a mount

#### Scenario: Unreadable heartbeat body

- **WHEN** the posted body cannot be parsed
- **THEN** the Host still records the contact and answers successfully
