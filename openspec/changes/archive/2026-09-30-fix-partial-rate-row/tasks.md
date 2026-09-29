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
