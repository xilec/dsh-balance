# dsh-balance

A DeepSeek Harness (`dsh`) plugin that shows **what the account actually spent**,
measured from balance differences, next to **what the current session cost**,
estimated from tokens — plus a **peak-tariff indicator** that shares the same
pricing rule.

```
$19.52 · $0.39/$2.29/$10.43 · $0.33        5 turns · 12 steps
```

Balance, then the last day / week / month, then this session — one pill in the
composer dock, immediately left of the shipped turn counters, with the same size,
colour and hover wash as the token-usage pills beside it. It carries no labels
(the legend is the native tooltip), and clicking it opens the panel anchored above
the line, exactly as the token-usage pills open theirs. The panel opens on
**Summary** — the account cards plus every figure the plugin holds (balance split,
the three windows, the session estimate, the tariff and its next change, sample
count and cadence, credits, when the balance was last read, and the partial/coarse
warnings) — and then offers **Days** (the editable per-day ledger), **Credits** and
**Settings**.

The peak indicator is the coloured chip in the session header:

```
Off-peak · peak in 2d 15h
```

It shows the tariff in force, counts down to the next change, and expands into
the day's windows in your time zone, the published UTC windows, the holiday note
and the source of the rule.

## Why balance differences

DeepSeek exposes exactly one money-related endpoint, `GET /user/balance`; there is
no usage or billing API. Token counting can therefore only ever be an *estimate* —
it depends on your copy of the price table, on the model actually served, and on
the tariff in force at the instant of each request. The balance, by contrast, is
what was really deducted:

```
spend(t0..t1) = balance(t0) − balance(t1) + credits(t0..t1)
```

So the plugin polls the balance on the Host (every 5 minutes by default, whether
or not a browser tab is open), keeps every sample on disk, and turns the
differences into:

* **1d / 1w / 1m totals** — calendar days in the zone you choose;
* **a per-day ledger** — each row showing the value derived from samples and an
  input to correct it by hand. A correction is a *base* that remembers the balance
  of the moment it was made, so the day keeps filling as `base + (balanceThen −
  newestBalance) + creditsSince` — the same window formula as everywhere else, and
  one subtraction rather than a sum of hundreds of small deltas;
* **credit events** — a rising balance is recorded as a top-up/refund rather than
  as negative spend.

The session estimate is kept as a *second* metric, because balance differences
cannot be attributed to a session, a model, or a project.

## What is accounted for

* **Peak / off-peak rates.** Peak hours are 09:00–12:00 and 14:00–18:00 Beijing
  time, Monday to Friday, **excluding Chinese public holidays**; everything else —
  weekends, holidays, and the make-up working weekends around them — is off-peak
  at exactly half the peak rate. The 2026 holiday calendar is built in and
  overridable, and the rule carries the URL and the date it was verified on.
* **Rates in force at the event.** Each token sample is priced at the instant it
  was taken, so a session that ran across a peak boundary, on a weekend, or on a
  holiday is not repriced wholesale by whatever tariff happens to be current when
  you look at it. The 2026-09-10 Flash price cut is applied by the same rule.
* **One rule for both indicators.** The readout, the peak chip, the panel, the
  session estimate and the balance accounting all read `src/pricing.js`; the
  browser half receives the Host's transition schedule and only renders it, so a
  display can never disagree with what was billed.
* **Legacy model ids.** `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and
  `deepseek-v4.1-flash` are billed at Flash rates; `deepseek-v4-pro` at Pro rates.
* **Account currency.** `currency` in the config is a preference: if the account
  answers in another currency, that one is used for the ledger, the symbols and
  the rate table, and the deviation is reported.
* **Deduction order.** The panel shows the granted and topped-up parts of the
  balance separately, because DeepSeek draws granted balance down first and its
  expiry would otherwise look like spend.

## Install

### Nix / Home Manager

```nix
{
  inputs.dsh-balance.url = "github:xilec/dsh-balance";
}
```

The `dsh-balance.nix` in a Home Manager configuration builds the row:

```nix
{ inputs, pkgs, ... }:
let
  src = inputs.dsh-balance.packages.${pkgs.stdenv.hostPlatform.system}.default;
  plugin = pkgs.runCommand "dsh-balance" { } ''
    cp -r ${src}/. $out/
    chmod -R u+w $out
    ln -s ${pkgs.dsh.dsh-kernel}/lib/deepseek-harness/node_modules $out/node_modules
  '';
in
{
  programs.dsh.patch = [
    {
      insert = [
        {
          id = "dsh-balance";
          name = "${plugin}/src/index.js";
          config = { currency = "USD"; };
        }
      ];
    }
  ];
}
```

The package itself needs no build step and no `node_modules` of its own: dsh
plugins resolve platform packages from the harness, so the row points at a store
path and the symlink supplies the rest.

### As a dsh plugin

```sh
dsh plugin --profile web add dsh-balance
```

## Configuration

Every field can be set from the composition row or from the Settings tab in the
panel; the panel writes its changes back to `$DSH_HOME/dsh-balance/state.json`,
and a value written there outranks the row for that key only.

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` / `apiKeyRef` | — / `DEEPSEEK_API_KEY` | Explicit key, or the credential (or environment variable) to resolve |
| `baseUrl` | `https://api.deepseek.com` | API base |
| `refreshIntervalMs` | `300000` | How often the Host samples the balance |
| `clientPollIntervalMs` | `15000` | How often the readout re-reads the Host cache |
| `currency` | `USD` | Ledger currency preference |
| `dayZone` | `local` | Day-boundary zone: `local` or an IANA name |
| `historyDays` | `30` | Day rows kept and rolled up |
| `keepDays` | `120` | Full-resolution sample retention |
| `warningThreshold` / `dangerThreshold` | `10` / `5` | Balance colouring |
| `holidays` | 2026 list | Chinese public holidays (Beijing dates) |
| `priceUnknownModels` / `fallbackPrices` | `false` / — | Price models outside the built-in table |
| `fallbackRates` | `{}` | Peak rates per 1M tokens keyed by model id, for a model the table does not price; they win over `fallbackPrices` and can be entered from the Cost view or the panel. Off-peak is half, a cache write is billed as a cache miss |

State lives in `$DSH_HOME/dsh-balance/`: `samples.ndjson` is the append-only
sample log (thinned to one sample per hour beyond `keepDays`), `state.json` holds
the day overrides, the settings and the last client contact.

## Limits worth knowing

* **Day boundaries need samples.** A day is attributed to the later sample of its
  interval; if the app was closed across a day boundary the row is marked
  *coarse* and is the thing the manual override exists for. Totals of a week and
  a month are far less sensitive to this than a single day.
* **Everything under the API key counts.** The balance is account-wide, so the
  1d/1w/1m figures include any other machine or tool using the same key. Only the
  session estimate is per-session.
* **A top-up hides the spend inside the same sampling gap.** With 1–2 top-ups a
  month and a five-minute cadence this is negligible; the credit list shows every
  event so a suspicious day can be corrected.
* **Granted balance expiry** looks like spend; the granted/topped-up split and the
  override are how you tell them apart.
* **Sessions before 2026-08-23** are priced by the earliest table in
  `src/pricing.js`, which is an approximation: the price list has changed several
  times and old tables are not published.
* **The holiday list is per year.** `holidays` ships the published 2026 dates; a
  new year needs a new list, otherwise holidays are billed as ordinary weekdays in
  the *estimate* (the balance ledger is unaffected).

## Development

```
src/pricing.js        the tariff rule, phases and zone labels (pure)
src/history.js        samples → intervals → day ledger → 1d/1w/1m (pure)
src/session-cost.js   the sessionProjections unit (tokens priced per event time)
src/store.js          samples.ndjson and state.json on disk
src/index.js          the Host plugin: sampler loop, HTTP routes
client/client.js      the browser half: the readout, the peak chip, the panel
test/                 node --test suite (76 cases, no build step)
```

```sh
npm test          # the whole suite
nix flake check   # the same suite inside Nix
```

Locally `node_modules` is a symlink to the dsh kernel's `node_modules` (that is
how a plugin resolves platform packages at runtime); the `devDependencies` in
`package.json` exist for CI, which has no kernel checkout and installs the same
packages from npm. `npm ci` therefore belongs to CI, not to a development tree —
and so do the lint scripts, which need those tools installed:

```sh
# in a kernel-linked development tree
npx knip --no-config-hints                                        # dead code
npx jscpd --min-tokens 60 --min-lines 10 --threshold 1 \
  --reporters console --format javascript src client              # duplication
```

`knip.json` fails on an unused file, export, dependency or binary; the two
deliberate exceptions are the platform packages (resolved from the dsh kernel at
runtime) and `react` (supplied by the client module loader). `jscpd` fails above
1% duplicated lines in `src/` and `client/`; the test suite repeats fixtures on
purpose and is not scanned.

GitHub Actions runs the suite, both lint checks and the flake package build on
every push and pull request.

## Sources

* Pricing rule and rates — <https://api-docs.deepseek.com/quick_start/pricing>
  (verified 2026-09-27); the panel links it together with the platform's own
  <https://platform.deepseek.com/usage> view
* Chinese public holidays 2026 — 国务院办公厅关于2026年部分节假日安排的通知 (2025-11-04)

## License

MIT.
