# Spec Delta

## MODIFIED Requirements

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
MUST NOT leave the plugin without samples until it is restarted.

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
