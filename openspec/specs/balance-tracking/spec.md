# balance-tracking Specification

## Purpose
Measures what the account actually spent by sampling the DeepSeek balance on the Host and
turning the differences into 1d/1w/1m windows and an editable per-day ledger, keeping the
samples on disk across restarts. This is the plugin's ground truth: spend is derived from
balance differences, never from token counts.

## Requirements

### Requirement: Balance sampling

The Host SHALL poll `GET /user/balance` on its own, independently of any browser, at the
configured `refreshIntervalMs` cadence, sending the API key resolved from `apiKey`,
`apiKeyRef` through the credentials service, or the environment. The first poll MUST happen
shortly after the plugin starts, and a poll that finds no API key MUST fail with
`api-key-missing` and retry on a short fixed delay instead of the configured one. Each
request MUST carry a bearer token, an `Accept: application/json` header and the configured
timeout; a non-2xx answer MUST be reported as an HTTP failure. Concurrent polls MUST share
one in-flight request. A poll MUST NOT end the sampling loop whatever its outcome: the next
tick MUST be scheduled after a failure as well as after a success, and a poll that cannot
start at all — a service it needs cannot be read, say — MUST be reported as a failed poll and
MUST NOT leave the plugin without samples until it is restarted. Exactly one timer may be
armed at a time: restarting the loop on a new cadence while a poll is still in flight MUST
NOT leave the tick that was awaiting that poll to arm a second one, since a doubled loop
polls twice per interval, writes twice per tick, and holds a timer the plugin can no longer
clear.

#### Scenario: The account is sampled without a browser

- **WHEN** the plugin is loaded in a profile and no tab is open
- **THEN** the Host still fetches the balance on the configured cadence and appends samples

#### Scenario: No API key

- **WHEN** neither `apiKey`, the credential named by `apiKeyRef`, nor the environment
  variable holds a key
- **THEN** the cache reports `api-key-missing`, no request is made, and polling continues on
  the short retry delay

#### Scenario: The API fails

- **WHEN** a poll times out or the endpoint answers with a non-2xx status
- **THEN** the last good balances and their fetch time stay in the cache, the payload is
  marked stale, and the error message is reported without dropping any sample

#### Scenario: A poll that cannot start

- **WHEN** a poll fails before a request is built, because the service holding the API key
  cannot be read
- **THEN** the failure is reported like any other, and the next poll is still scheduled on the
  configured cadence rather than sampling stopping for the rest of the session

#### Scenario: The cadence is changed while a poll is in flight

- **WHEN** a settings write changes the sampling cadence while a tick is still awaiting its
  poll
- **THEN** the tick that was awaiting the poll does not arm a second timer, and the plugin
  keeps polling once per interval

### Requirement: Samples are recorded only when they carry news

A successful poll SHALL select the balance entry in the preferred account currency, falling
back to the first entry, and MUST append a sample only when it changes something — a
different currency, or a different total, granted or topped-up amount — or when at least 30
minutes have passed since the previous sample, which is recorded as a heartbeat. The sample
log held in memory SHALL be capped, keeping the newest samples when the cap is exceeded.

#### Scenario: Unchanged balance

- **WHEN** two consecutive polls return the same currency and amounts less than 30 minutes
  apart
- **THEN** only the first poll appends a sample

#### Scenario: Heartbeat

- **WHEN** the balance has not moved for 30 minutes
- **THEN** a sample is appended anyway, so a flat balance stays visible as a live reading

#### Scenario: Multi-currency account

- **WHEN** the response holds several balance entries
- **THEN** the entry in the preferred currency is recorded, or the first entry when the
  preferred currency is absent

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

### Requirement: Spend and credit events

The Host SHALL derive the spend of an interval as `balance(t0) − balance(t1)` plus the
credits inside it. A fall in the balance of at least the spend floor (0.001) SHALL count as
spend; a rise of at least the credit floor (0.01) SHALL be recorded as a credit event carrying
its instant, amount and surrounding balances instead of as negative spend. Money SHALL be
rounded to six decimals.

#### Scenario: Ordinary spend

- **WHEN** the balance falls between two samples
- **THEN** the difference is recorded as spend for that interval

#### Scenario: A top-up arrives

- **WHEN** the balance rises by at least the credit floor
- **THEN** a credit event is recorded and that interval contributes no negative spend

#### Scenario: Rounding noise

- **WHEN** the balance rises by less than the credit floor
- **THEN** the movement is not reported as a credit

### Requirement: Per-day ledger, windows and coarse days

The Host SHALL produce one row per calendar day, for `historyDays` days ending with today in
the configured `dayZone`. Each spend interval MUST be attributed to the day of the later
sample. A row whose interval started on an earlier day SHALL be marked coarse, and the row for
today SHALL be the only row marked open. The ledger MUST expose 1-day, 1-week and 1-month
totals summed from the rows, each with a `covered` flag that is true only when the samples
reach back to the first day of that window. The credit list MUST be returned newest first,
bounded, with the all-time credit total.

#### Scenario: Day boundary without samples

- **WHEN** the app was closed across midnight and the next sample lands the following day
- **THEN** the whole interval is attributed to the later day and that row is marked coarse

#### Scenario: Window coverage

- **WHEN** the samples start after the first day of the week window
- **THEN** that window's total is reported with `covered: false`

#### Scenario: Month boundary

- **WHEN** today is the first day of a month
- **THEN** the day rows roll back into the previous month rather than stopping at the boundary

### Requirement: A manual override is an anchored base

A day row SHALL be correctable by hand through the ledger's override. When an override is
written, the Host MUST remember the account balance of that instant together with the amount
and the time, and the day's value MUST then be that base plus everything measured since — the
drop from the anchor balance to the newest sample of the same day, plus the credits recorded
after the override. A day with an override MUST ignore its sampled value, and an override
written without an anchor (the older file format) MUST stay frozen at its amount.

#### Scenario: A corrected day keeps filling

- **WHEN** the reader sets today's spend by hand and spend continues afterwards
- **THEN** the row shows the base plus the spend measured after the override, and the 1d total
  follows it

#### Scenario: Clearing an override

- **WHEN** an override is removed by sending no amount
- **THEN** the row falls back to the sampled value

#### Scenario: Override from an older version

- **WHEN** the state file holds an override as a bare number
- **THEN** the row reports that amount as a frozen base and the override is not lost

### Requirement: The cached payload and its read route

The Host SHALL expose `GET /dsh-balance` with an optional `sessionId` and `zone` query,
answering with the cached Host state: host identity and sample count, the balance reading with
its thresholds and currency, the full ledger, the tariff phase, the published rates, the
fallback rates, the stored browser preferences, the sampling cadences, the last client
heartbeat and the session summary. The route MUST answer `HEAD` with the same status and no
body, and MUST NOT build the payload it would have answered with: a `HEAD` asks whether the
endpoint is there, not what it says, so no ledger, tariff or session read is done for it. The
route MUST answer any other method with `405` and an `Allow: GET, HEAD` header, and MUST mark
every answer `Cache-Control: no-store`. A read that arrives before the stored state has been
read MUST wait for that load. An unrecognized `zone` MUST fall back to the Host's own `local`
zone rather than fail.

#### Scenario: The panel reads the state

- **WHEN** the browser half requests `/dsh-balance`
- **THEN** it receives the balance, ledger, peak, prices, preferences and sampling cadences in
  one payload

#### Scenario: A probe asks whether the endpoint is there

- **WHEN** `/dsh-balance` is called with `HEAD`
- **THEN** the answer is `200` with no body, and no part of the payload is built to be
  discarded

#### Scenario: Method not allowed

- **WHEN** the route is called with a method other than `GET` or `HEAD`
- **THEN** the answer is `405` with `Allow: GET, HEAD` and no body

### Requirement: The ledger write routes

The Host SHALL expose `POST /dsh-balance/overrides` to set or clear one day's base and
`POST /dsh-balance/refresh` to force an immediate balance fetch. The override route MUST
reject a missing or malformed `date` and a negative or non-numeric `amount` with `400` and a
message naming the field, MUST treat a null, empty or absent amount as the removal of the
override, MUST persist the accepted change, and MUST answer with the overrides and the
refreshed ledger. The refresh route MUST tolerate an unreadable body, MUST await the shared
in-flight fetch, MUST wait for the stored state to be read before it builds its answer — the
same wait the read route does — and MUST answer with the same payload as the read route, so a
refresh during the start-up load reports the history on disk rather than an empty one. Both
routes MUST answer a non-POST method with `405`.

#### Scenario: Correcting a day

- **WHEN** a valid date and a non-negative amount are posted to the override route
- **THEN** the override is stored, persisted, and the refreshed ledger is returned

#### Scenario: Bad override

- **WHEN** the posted amount is negative or the date is not `YYYY-MM-DD`
- **THEN** the answer is `400` with an error naming the offending field and nothing is stored

#### Scenario: Forced refresh

- **WHEN** the panel asks for a refresh
- **THEN** the Host performs a balance fetch and returns the updated payload

#### Scenario: A refresh during the start-up load

- **WHEN** a refresh is asked for while the stored samples are still being read, and the poll
  itself returns before that read finished
- **THEN** the answer reports the samples and the ledger the log on disk holds, not an empty
  history and an all-zero ledger

### Requirement: The account currency is a preference

The configured `currency` SHALL be treated as a preference, not a promise: the ledger, the
published rates and the session estimate MUST use the account currency actually reported by
the endpoint, and the payload MUST report both when they differ. When the preferred currency
is absent from the response, the first reported entry's currency MUST be used.

#### Scenario: The account answers in another currency

- **WHEN** the endpoint reports only CNY while the configuration asks for USD
- **THEN** the ledger and rates are computed in CNY and the payload marks the deviation

### Requirement: Account-wide scope is reported, not hidden

The ledger SHALL describe the whole account, not one session: the day rows, the windows and
the credit list include every session, every other machine and every other charge under the
same key. The payload MUST carry the account-wide figures without attributing them to a
session.

#### Scenario: Another machine spends

- **WHEN** a second tool under the same API key consumes balance between two samples
- **THEN** that spend appears in the day row and the windows, and no session is credited or
  blamed for it
