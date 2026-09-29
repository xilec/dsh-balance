# Design

## Context

See `proposal.md` — Why.

The facts that shape the approach:

- The fallback-rate editor is one component, `RateEntry` (`client/client.js:3745`), rendered in
  two places: the Cost view (`client.js:3533`) and the Settings tab (`client.js:3839`). Both
  pass their own `onSave`, so the acceptance of a row lives in the component and there is a
  single write loop to fix.
- Its save handler has two stages. First `filled` counts the fields whose
  `String(row[key] ?? '').trim()` is non-empty: zero filled means "remove the entry", which is
  the only way a model leaves the store. Then a second loop converts every key of the row and
  refuses on `!Number.isFinite(value) || value < 0`.
- The two stages disagree about what an empty field is. The first treats it as "not filled in";
  the second asks `Number('')` and gets `0`, which is finite and non-negative, so the refusal
  never fires. The disagreement is the whole bug — the count is right, the conversion is not.
- Field values are DOM strings from `type="number"` inputs, and the draft is seeded from stored
  rates as `String(rate[key])` or `''` (`rateDraftOf`, `client.js:3729`). So the only states a
  field can be in are: a number's string form, `''`, or whatever the reader typed — including
  `'-'`, `' '` or `'1e'`, which browsers and `Number` disagree about.
- `Number` is the wrong tool for "did the reader type a rate here?". It answers "what is this
  string worth if it is a number", and its answer to "not a number" is a number. The predicate
  the handler actually wants is about the string.
- `cost.rates.invalid` already exists in both locales and already reads "every rate must be a
  non-negative number" — which is true of an empty field too, since it is not a number.

## Goals / Non-Goals

**Goals:**

- One rule for the empty field, applied where the row is read, so the count and the conversion
  cannot drift apart again.
- No change to what a complete row does, what an all-empty row does, or what a negative rate
  does. The refusal reuses the existing message and the existing all-or-nothing submit: one bad
  field refuses the whole save, not one model.
- A test that fails on the old code for the right reason: a partially filled row must render
  the status and must not call `onSave`.

**Non-Goals:**

- Validating on blur or per-field as the reader types. The spec puts the check at save, and a
  message on every keystroke of a half-typed number is worse than one message on save.
- Migrating rows already stored with a zero. Zero is a legitimate price — a free cache hit is
  not unheard of — and the stored payload is not this component's to reinterpret.
- Changing the note, the field order, the step, or anything on the Host side.

## Decisions

**The refusal is decided on the string, before the conversion.** The write loop checks
`String(row[key] ?? '').trim() === ''` alongside the numeric check and refuses on either, so an
untouched field never reaches `Number()`.

The alternative was to make `Number('')` fail — parsing with a guard, or checking
`Number.isNaN(Number(field))` against an emptiness sentinel. That asks the conversion to lie
about its result to compensate for a predicate it was never meant to answer, and the same
mistake then has to be avoided at the next call site. Deciding on the string costs one extra
condition in a loop that already has one, and it reads as the rule it is: a rate the reader
did not type is not a rate of zero.

**The same emptiness test the count uses is the one the refusal uses.** `filled` already
computes `String(row[key] ?? '').trim() !== ''`; the fix uses the same expression negated, so
the two stages are the same test and one of them cannot be right while the other is wrong. This
is why the fix is a two-line condition rather than a rework of the loop.

**Whitespace is emptiness, and a message is reused rather than added.** `.trim()` is already
what the count uses, so `' '` and `'-'` both refuse. A reader who typed a sign and stopped gets
the same message as one who typed a negative rate: the existing text is accurate for both, and a
second key would mean translating and deciding a wording nobody asked for.

**Both editors are fixed by the one change.** The brief mentions a second editor; there is one
component behind both entry points, so fixing the loop fixes the Settings tab and the Cost view
together. Verified by reading every `RateEntry` render site rather than by assumption — the only
other rate-shaped loop in the file is `rateDraftOf`, which reads stored rates through
`Number.isFinite` and has no reader input to misread.

## Risks / Trade-offs

- [A reader who deliberately wants a rate of zero now has to type `0`] → It already had to: the
  field is `type="number"` and the draft seeds a stored `0` as `"0"`, which trims to non-empty
  and is written. Only an untouched field changed meaning.
- [The refusal is all-or-nothing across models] → That is the existing behaviour for a negative
  rate and is the safer one: a partial write would leave the display priced from a mixture of
  what the reader meant and what they did not finish.
- [An existing test could have depended on the loose conversion] → `test/client.test.js` has
  three rate-editor cases (all-empty, complete, negative) and none of them types a partial row,
  which is the reviewer's point. `npm test` decides.
- [jscpd flags the repeated `.trim()` expression] → The expression already appears once in the
  same function; two adjacent occurrences in a seven-line loop are the kind of thing the gate
  exists to catch, and it is re-run before the PR.

## Migration Plan

None. The change is a client-side guard in one save handler plus a test; nothing is stored,
migrated or republished. Reverting the commit restores the old acceptance.

## Open Questions

None.
