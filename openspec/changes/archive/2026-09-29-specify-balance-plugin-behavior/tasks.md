# Tasks

## 1. Balance tracking and accounting spec

- [x] 1.1 Enumerate the sampler, storage and accounting facts from `src/index.js`, `src/store.js`, `src/history.js` and their tests; verify every fact carries a file:line source in `tmp/spec-inventory-host.md` (sections 3–5, 7)
- [x] 1.2 Write `specs/balance-tracking/spec.md` (Purpose + 9 ADDED requirements) for sampling, on-disk retention, the 1d/1w/1m windows, the day ledger with overrides, credit events and the routes that expose them; verified: every requirement has at least one WHEN/THEN scenario and `openspec validate --all --strict` accepts the file
- [x] 1.3 Map each `balance-tracking` requirement to the test or route that already enforces it and verify the mapping by running `node --test test/plugin-host.test.js test/history.test.js` — sampling and cache: `test/plugin-host.test.js:141-162`, `:554-589`, `:838-876`; samples and retention: `test/history.test.js:225-247`; spend and credits: `test/history.test.js:48-206`; overrides: `test/history.test.js:73-151`, `test/plugin-host.test.js:164-200`, `:331-369`; routes: `test/plugin-host.test.js:141-235`; currency: `test/plugin-host.test.js:237-282`

## 2. Tariff rule spec

- [x] 2.1 Enumerate the pricing facts from `src/pricing.js` and `test/pricing.test.js`: rate table and its versions, legacy ids, peak windows, holidays, off-peak half, cache-write billing, fallback rates, zone handling; verified: each fact carries a file:line source in `tmp/spec-inventory-host.md` section 6
- [x] 2.2 Write `specs/tariff-rule/spec.md` (Purpose + 9 ADDED requirements) for the rule, its exposure to the browser half and the fallback-rate contract; verified: every requirement has at least one WHEN/THEN scenario and `openspec validate --all --strict` accepts the file
- [x] 2.3 Map each `tariff-rule` requirement to `test/pricing.test.js` or `test/phase.test.js` and verify the mapping by running `node --test test/pricing.test.js test/phase.test.js` — tables and legacy ids: `test/pricing.test.js:25-27`, `:39-53`, `:82-129`; pricing and cache write: `test/pricing.test.js:102-123`; phases and zones: `test/phase.test.js:24-123`, `:139-162`, `test/pricing.test.js:131-153`

## 3. Settings spec

- [x] 3.1 Enumerate the config schema, defaults, validation, precedence and on-disk state from `src/index.js`, `src/store.js`, `README.md` and `test/plugin-host.test.js`; verified: each fact carries a file:line source in `tmp/spec-inventory-host.md` sections 1–3, 7
- [x] 3.2 Write `specs/plugin-settings/spec.md` (Purpose + 7 ADDED requirements) covering the schema, row-versus-runtime precedence, restore order, and the read/write routes; verified: every requirement has at least one WHEN/THEN scenario and `openspec validate --all --strict` accepts the file
- [x] 3.3 Verify the precedence and restore-order requirements against the tests that pin them by running `node --test test/plugin-host.test.js` — precedence: `test/plugin-host.test.js:284-329`; restore-before-persist: `:793-836`; anchor migration: `:331-369`; settings route: `:202-214`, `:465-526`; heartbeat: `:216-235`

## 4. Panel and readout spec

- [x] 4.1 Enumerate the browser-half facts from `client/client.js` and `test/client.test.js`: pill contents and thresholds, peak chip and countdown, panel tabs and their interactions, formatting, polling and error states; verified: each fact carries a file:line source in `tmp/spec-inventory-client.md`
- [x] 4.2 Write `specs/balance-panel/spec.md` (Purpose + 9 ADDED requirements) for the readout, the chip and the panel tabs, referencing `session-cost-analysis` for the Cost view instead of restating it; verified: every requirement has at least one WHEN/THEN scenario and `openspec validate --all --strict` accepts the file
- [x] 4.3 Map each `balance-panel` requirement to `test/client.test.js` and verify the mapping by running `node --test test/client.test.js` — registration: `test/client.test.js:269-280`; readout: `:305-311`; chip: `:419-499`; panel: `:502-522`; days and settings: `:603` and following

## 5. Verification and archiving

- [x] 5.1 Cross-check every requirement against the implementation once more and record any place where the README or `CONTEXT.md` disagrees with the code, with file:line, under section 6 — five divergences found, all in `README.md` and the client docstring
- [x] 5.2 Run `npm test`, `openspec validate --all --strict` and verify the suite stays green with no source file touched — `npm test`: 168 passed, 0 failed; validation: 2 passed, 0 failed; `git status --short` lists only `openspec/` and `tmp/`
- [x] 5.3 Archive the change with `openspec archive specify-balance-plugin-behavior --yes` and verify the four specs appear under `openspec/specs/` with their purposes and requirement counts
- [x] 5.4 Update `CONTEXT.md` or `README.md` only if the verification found a wording divergence that belongs in the repository; verified: the stale case count (`README.md:200`), the misleading balance-colouring row (`README.md:148`) and the stale readout docstring (`client/client.js:6-9`) were fixed, and the remaining findings needed no change (see section 6); no runtime code was touched

## 6. Divergences found

- [x] 6.1 Record every README/CONTEXT wording divergence with file:line and the code that contradicts it

Findings, none of which changed a requirement away from the code:

1. `README.md:148` presents `warningThreshold` / `dangerThreshold` as "Balance colouring", and
   the panel's own summary is described as showing the warnings (`README.md:18-22`), but no
   render path colours the balance: the client defines a threshold helper
   (`client/client.js:758`) that only the test export ever reaches
   (`client/client.js:4020`). History: the readout used to draw a coloured status dot
   (`dshb_dot dshb_dot_${level}`, `git show 0de66ef:client/client.js`) beside the balance;
   `54c1851` ("Compress the readout and open the panel like the token-usage pills do") dropped
   the dot and set the level on the anchor as `data-level` instead, which no stylesheet rule
   ever targeted — so the colouring went away with the dot while the thresholds, the settings
   fields and the helper stayed. Fixed in the README: the row now says the thresholds are
   stored and relayed but unused by any surface, and names the peak chip's phase colour as what
   the UI actually shows. The `balance-panel` spec describes the readout as it is, without
   threshold colouring; the dead helper was left in place rather than deleted in a docs change.
2. `README.md:79-81` says the account-currency deviation "is reported". The Host reports it
   (`src/index.js:791`, `currencyMissing`) and the account's own currency is what the ledger,
   the symbols and the rate table use — so the figures are right. No client surface reads
   `currencyMissing`, but the field the reader actually cares about is honoured, so this was
   left alone: no wording change and no issue.
3. `README.md:200` said the suite has "136 cases"; `npm test` reports 168. Fixed by dropping the
   number from the README instead of tracking it, because it goes stale with every test added.
4. The client module docstring documented a labelled readout
   (`b:$19.52 · 1d:$0.39 · …`, `client/client.js:6-9`) while the rendered line is unlabelled
   (`client/client.js:1088-1101`, `README.md:12-16`). Fixed in the docstring.
5. The peak chip's mini-panel prints the rule source as plain text
   (`client/client.js:1200`); checked against `README.md:224`, which says the *panel* links the
   rule — the panel footer does (`client/client.js:1264-1270`), so this is not a divergence,
   only two surfaces treating the same link differently. No change made.

Not divergences, but worth knowing: `state.json` writes a `version` that is never read back
(`src/index.js:221`); `historyDays` limits the produced rows without trimming stored samples
(`src/index.js:801`); the client prefills `historyDays` from the number of rows it received
(`client/client.js:861-871`), which round-trips only because the Host caps the rows.
