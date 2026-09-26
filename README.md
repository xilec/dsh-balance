# dsh-balance

A DeepSeek Harness (`dsh`) plugin that shows **what the account actually spent**,
measured from balance differences, next to **what the current session cost**,
estimated from tokens.

A chip in the bottom-left corner of the shell (right of the sidebar) shows the
account balance and the spend of the last day, week and month. Clicking it opens
the per-day ledger — every day editable — plus the credit (top-up) events and the
sampling settings.

```
🟢 Balance $19.67 · $0.42 1d · $2.80 1w · $11.05 1m · $0.31 session
```

## Why balance differences

DeepSeek exposes exactly one money-related endpoint, `GET /user/balance`; there
is no usage or billing API. Token counting can therefore only ever be an
*estimate* — it depends on your copy of the price table, on the model actually
served, and on the tariff in force at the instant of each request. The balance,
by contrast, is what was really deducted:

```
spend(t0..t1) = balance(t0) − balance(t1) + credits(t0..t1)
```

So the plugin polls the balance on the Host (every 5 minutes by default, whether
or not a browser tab is open), keeps every sample on disk, and turns the
differences into:

* **1d / 1w / 1m totals** — calendar days in the zone you choose;
* **a per-day ledger** — each row showing the value derived from samples and an
  input to correct it by hand;
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

  # The package itself is dependency-free; dsh plugins run with the harness's own
  # node_modules, so the row is wired like every other plugin:
  # a store path plus a node_modules symlink to the dsh kernel.
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

The composition row is read while the Host runs, but a plugin's *code* is imported
once: after changing the row or the plugin, quit `dsh` **completely** (closing the
window or reloading the page does not restart the Host process) and start it again.
A browser-half change only needs a reload, and that reload should bypass the cache
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>).

### As a dsh plugin

```sh
dsh plugin --profile web add dsh-balance
```

## Configuration

Every field can be set from the composition row or from the Settings tab in the
panel; the panel writes its changes back to `$DSH_HOME/dsh-balance/state.json`.

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` / `apiKeyRef` | — / `DEEPSEEK_API_KEY` | Explicit key, or the credential (or environment variable) to resolve |
| `baseUrl` | `https://api.deepseek.com` | API base |
| `refreshIntervalMs` | `300000` | How often the Host samples the balance |
| `clientPollIntervalMs` | `15000` | How often the chip re-reads the Host cache |
| `currency` | `USD` | Ledger currency preference |
| `dayZone` | `local` | Day-boundary zone: `local` or an IANA name |
| `historyDays` | `30` | Day rows kept and rolled up |
| `keepDays` | `120` | Full-resolution sample retention |
| `warningThreshold` / `dangerThreshold` | `10` / `5` | Chip colouring |
| `holidays` | 2026 list | Chinese public holidays (Beijing dates) |
| `priceUnknownModels` / `fallbackPrices` | `false` / — | Price models outside the built-in table |

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

## Layout

```
src/pricing.js        the tariff rule and the rate tables (pure)
src/history.js        samples → intervals → day ledger → 1d/1w/1m (pure)
src/session-cost.js   the sessionProjections unit (tokens priced per event time)
src/store.js          samples.ndjson and state.json on disk
src/index.js          the Host plugin: sampler loop, HTTP routes
client/client.js      the browser half: the chip, the tooltip, the panel
test/                 node --test suite (55 cases, no build step)
```

`npm test` runs the suite; `nix flake check` runs the same suite with the dsh
kernel's `node_modules` linked in.

## Sources

* Pricing rule and rates — <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
  (verified 2026-09-27)
* Chinese public holidays 2026 — 国务院办公厅关于2026年部分节假日安排的通知 (2025-11-04)

## License

MIT.
