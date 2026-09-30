# Tasks

- [x] 1.1 `scripts/release-notes.mjs`: sort the change sections oldest first in `buildDraft`, so the draft opens with the change the release is about rather than with the newest one.
- [x] 1.2 `src/store.js`: the layout comment names the four fields `state.json` actually carries instead of a currency nothing reads.
- [x] 1.3 `src/history.js`: `addedSince`'s comment states the same-day anchor invariant the requirement was amended to, instead of the pre-amendment justification.
- [x] 1.4 `client/client.js`: `peakLines` derives tomorrow's day key from the calendar, so the day word is right across a daylight-saving transition.
- [x] 1.5 `npm test`, `nix flake check`, knip + jscpd in the scratch copy, `openspec validate --all`.
