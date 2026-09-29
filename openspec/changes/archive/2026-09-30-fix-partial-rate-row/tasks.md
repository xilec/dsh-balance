# Tasks

## 1. Refuse a partially filled rate row

- [x] 1.1 In `RateEntry`'s save handler (`client/client.js`), refuse a row in which any of the
  three fields is empty or whitespace-only, using the same emptiness test the `filled` count
  uses, keeping the all-empty row as "remove the entry" and the existing `cost.rates.invalid`
  message; verify by reading the loop that the two stages can no longer disagree
  — done: the write loop now trims the field to `text` first and refuses on `text === ''`
  alongside the finite and non-negative checks, so the conversion never sees a field the
  reader left alone; the JSDoc above `RateEntry` and the inline comment say why
- [x] 1.2 Confirm there is no second rate write path: check every `RateEntry` render site
  (the Settings tab and the Cost view) and every rate-shaped loop in the file, so that the one
  guard covers both editors; verify with a search for the rate keys and for `Number(row` that
  the conversion exists in exactly one place
  — done: `RateEntry` is rendered in three places (the Settings tab, the Cost view and the
  Cost view's empty state) and all three share the one save handler; `rg 'RATE_KEYS|Number\(row'`
  finds the conversion only in that handler, and the other rate-shaped loop, `rateDraftOf`,
  reads stored rates through `Number.isFinite` and has no reader input to misread

## 2. Cover the partial row with a test

- [x] 2.1 Add a partially filled case to the rate-editor test in `test/client.test.js`: type one
  rate, leave the other two empty, save, and assert both that the rendered status is
  `cost.rates.invalid` and that `onSave` was not called; verify with `npm test`, and that the
  all-empty, complete and negative cases still pass unchanged
  — done: the case types the cache-miss rate only, saves, and asserts the rendered
  `cost.rates.invalid` plus an unchanged `writes` length; `npm test` is 262/262, the same count
  as before, with the three neighbouring cases untouched
- [x] 2.2 Verify the new case fails against the pre-fix handler (restore the old condition in a
  scratch copy, not the worktree) so the test proves the finding and not just the message
  — done: in a scratch copy with `client.js` taken from `HEAD` and only `test/client.test.js`
  from the branch, the case fails on the status assertion, with the tree reporting
  `cost.rates.saved` — the old code wrote `{ cacheMiss: 2, cacheHit: 0, output: 0 }`, which is
  the finding
- [x] 2.3 Cover the cases the review named: a row of deliberate zeros is written, the empty
  field may sit first, and a field holding only spaces counts as empty
  — done: the same test types `['0','0','0']` and asserts the write reaches `onSave` with three
  zeros, then `['', '2', '']` and `['2', ' ', '']` and asserts both are refused
- [x] 2.4 Cover the Host's half of the same rule in `test/plugin-host.test.js`: a body whose
  rate field is a blank string is refused with 400, and a body of zeros is accepted
  — done: both cases sit beside the negative-rate rejection, and the accepted zero row is read
  back from the response body

## 3. Teach the Host the same rule

- [x] 3.1 In `src/index.js`, stop reading a rate field with bare `Number()`: `Number('')`,
  `Number(null)`, `Number(false)` and `Number([])` are all zero, so `isFallbackRates` accepted a
  hand-written body that priced a model at nothing; read the field through `rateOf`, which takes
  a number or a string that reads as one and nothing else
  — done: `rateOf` guards the four shapes `Number` folds to zero, `isFallbackRates` uses it for
  both the finite and the non-negative test, and a stored zero still passes
- [x] 3.2 Verify the client and the Host now agree on one definition of a valid rate: a number
  that is finite and non-negative, or a string that reads as one; no `Number()`-only coercion
  is left on either side of the settings write
  — done: the two read sites are the editor's write loop and `rateOf`; searching the rate paths
  for a `Number(` coercion finds nothing else that can turn a blank field into a rate
