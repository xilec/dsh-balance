# Tasks

## 1. Reorder the compact line

- [x] 1.1 In `Readout` (`client/client.js`), build `line` as the session estimate, then the
  balance, then the 1d/1w/1m totals, keeping the two separators and the placeholder rules as they
  are
  — done: `line` is `session · sep1 · balance · sep2 · spend`, with the same `money` calls and
  placeholders
- [x] 1.2 Build `legend` in the same order — the session label, the balance label, then the three
  window labels — so the tooltip and the accessible name still describe the figures left to
  right
  — done: `legend` opens with `tip.session` and `tip.balance`, then the joined window labels
- [x] 1.3 Update the comment above `legend` and the test comment that pin the old order
  — done: both comments now name the session estimate first

## 2. Update the tests that pin the line

- [x] 2.1 In `test/client.test.js`, change the expected compact line in "the readout renders the
  compact balance and spend line" to the session-first order, before and after the first payload
  — done: the placeholder line stays `— — —`; the loaded line is
  `$0.33 $19.52 $0.39/$2.29/$10.43`
- [x] 2.2 Change the expected line in "the session projection outranks the payload copy of the
  session cost" the same way
  — done: `$0.91 $19.52 $0.39/$2.29/$10.43`
- [x] 2.3 Pin the legend order in the same test, so the tooltip cannot drift from the line
  — done: two `indexOf` assertions put `tip.session` before `tip.balance` and `tip.balance` before
  `tip.spend1d`

## 3. Verify

- [x] 3.1 `npm test` green, no reduction in the number of tests — 343 pass, 0 fail, 1 skipped
  (same suite size)
- [x] 3.2 `npm run lint` clean — knip silent, jscpd 0 clones (run in a scratch tree, because the
  working tree's `node_modules` is the kernel snapshot and has no lint tools)
- [x] 3.3 `openspec validate reorder-readout-figures --strict` and `openspec validate --all` green
  — change valid; 7 passed, 0 failed
