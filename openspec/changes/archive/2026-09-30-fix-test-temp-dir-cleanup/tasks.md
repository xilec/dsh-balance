# Tasks

## 1. Reproduce

- [x] 1.1 Reproduce the flake on unmodified `origin/main`: 72 concurrent copies of
      `test/plugin-host.test.js`, recording the exit code and the failing message.
      Got **25 hits in 144 copies** (1 in 72 on the first attempt)
- [x] 1.2 Establish which write repopulates the directory, by instrumenting the failing
      fixture to list the directory on `rm` failure. Expect `dsh-balance/samples.ndjson`
      — the sampling tick's `appendSample`, not the heartbeat's `state.json`

## 2. The removal helper

- [x] 2.1 Add `removeHome(home)` to `test/plugin-host.test.js`: `rm` with
      `recursive: true, force: true, maxRetries: 5, retryDelay: 50`, in a comment that says
      why both halves of the fix are there (disposal stops every *future* write, the retry
      absorbs the one already in flight that disposal cannot reach)
- [x] 2.2 Route all thirteen `rm(home, …)` call sites in `test/plugin-host.test.js` through
      it. Verify `grep -c "await rm(" test/plugin-host.test.js` reports only the helper's own
- [x] 2.3 Reorder `a write that arrives while the state is still loading survives the load`
      (`:1372`) and `the client heartbeat that lands during the load does not blank the
      stored state` (`:1420`) so `ctx.dispose()` runs before the removal — move the `rm` out
      of the `try` into the `finally`. Verify `npm test -- test/plugin-host.test.js` is green

## 3. The other suite

- [x] 3.1 Audit every removal of a temporary directory in `test/store.test.js` and
      `test/plugin-host.test.js` for a plugin that may still be writing into it; confirm
      `test/plugin-host.test.js:1526` (`rm(statePath, …)`) and
      `test/store.test.js:63` (`rm(blocked, …)`) are file-scoped and safe, and record why
- [x] 3.2 Add the retry to `withDir` in `test/store.test.js` — every store call its tests make
      is awaited, so there is nothing to dispose and nothing to reorder; the retry is the same
      belt on the same reasoning. Verify `npm test -- test/store.test.js` is green
- [x] 3.3 Confirm nothing touches `~/.dsh`: the suite home is still created at module load,
      still defaults a missing or blank `$DSH_HOME`, and is still never removed. Verify
      `test/plugin-host.test.js:276`'s assertion about `~/.dsh` is untouched and passing

## 4. Proof

- [x] 4.1 Re-run 72 concurrent copies of `test/plugin-host.test.js`. Got 0 non-zero exits and 0 `ENOTEMPTY` in 144 copies (baseline: 25 in 144)
- [x] 4.2 Re-run 36 concurrent copies of `test/plugin-host.test.js` as well, so the count the reviewer reported
      zero for is reported here too. Got 0/36
- [x] 4.3 Run 6 concurrent copies of the whole suite (`node --test test/*.test.js`).
      Got `tests 321 pass 321 fail 0` in all six

## 5. Gates

- [x] 5.1 `npm test` in the worktree — 321 tests, 321 pass, 0 fail
- [x] 5.2 `npm run lint` (knip + jscpd) in `tmp/lint-t13` with its own `node_modules` — knip clean, jscpd 0 clones
- [x] 5.3 `nix flake check` in the worktree — all checks passed
- [x] 5.4 `openspec validate --all` — 7 passed, 0 failed
