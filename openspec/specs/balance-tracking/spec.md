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
