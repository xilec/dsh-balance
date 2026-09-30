# Design

## Context

See `proposal.md` — Why. What matters here is the state of the tree this change lands on:
the rule is already implemented, in `addedSince` in `src/history.js`, as a comparison of the
anchor's instant against the day's own first and last sample instants:

```js
if (newest === undefined || entry.at > newest.t || entry.at < oldest.t) return 0
```

The change is a documentation repair. Nothing in the arithmetic moves, so the design question
is not "how" but "which artifact carries the repair and how is it pinned".

## Goals / Non-Goals

**Goals:**

- Make the spec's rationale equal to the invariant the code holds, so a reader following the
  spec can predict the ledger.
- Name the same-day case, so the reachable case below is a documented consequence rather than
  a finding to be rediscovered.
- Pin the same-day case with a test, so the wording and the arithmetic cannot drift apart.

**Non-Goals:**

- Changing the rule, the `computed` field, the panel, or the state format.
- Documenting the case in `README.md` or `CONTRIBUTING.md`: neither states the rule (the
  README's "anchored" is about the panel's position above the terminal, not the override).
- Reopening whether the maintainer was right to keep the rule. That decision is made and
  recorded here; this change records the consequence, it does not relitigate the rule.

## Decisions

**D1 — MODIFIED requirement, not an ADDED scenario.** The wrong rationale lives *inside* the
requirement's own prose ("because a window that starts before the day began carries the
previous day's spend"). No ADDED scenario can repair a requirement's text: the archive would
append a scenario to a requirement that still argues from a premise that is false half the
time, and the two halves would contradict each other in the same block. A MODIFIED
requirement restates the whole block, so the invariant, the same-day case and the remedy can
be written as one argument. The normative sentence — "MUST be measured only when the anchor
lies inside that day's own span of samples — at or after the day's first sample and at or
before its last" — is carried over word for word; only the "because" clause after it is
replaced.

*Alternative considered:* ADDED scenario alone, which would have left the false premise in
place. Rejected: the premise is the defect.

**D2 — The invariant is stated as the guarantee, not as the old reason.** The replacement
rationale is the invariant the archived design already identified: **a base is only ever
added to by a drop between two instants of the same ledger day.** That phrasing is the one
the code can be held to, and it explains the same-day case as a consequence rather than as an
exception — an anchor before the day's first sample has no measurement *of that day* to start
from, whether it sits on the previous day or, seventeen minutes earlier, on the same one.

**D3 — The consequence is stated together with the remedy, so the requirement is actionable.**
Left alone, "nothing is added" reads as data loss. The spec now says in the same breath that
the day's own sampled spend is still reported as the row's sampled value (the panel's
"From samples" column, which `openspec/specs/balance-panel/spec.md` already requires) and
that re-entering the correction once the anchor falls inside the day restores the sampled
part. That is the reader's actual path back, and it is what makes the 0 a consequence rather
than a defect.

**D4 — The reachable case is pinned by a test, and the test is labelled a specification
test.** The case: a poll succeeds at 00:05 with the balance unchanged, 17 minutes after the
previous day's last sample, so the 30-minute heartbeat has not fired and the day has no
sample. The reader corrects it; polls at 00:07 and 00:20 then append the day's first and
second samples. With samples `23:50 @ 10`, `00:07 @ 8`, `00:20 @ 5` and an override of
`1` anchored at `00:05 @ 10`, the row reports `spend 1`, `measuredAfter 0`, `computed 5`.
The test asserts those three figures. It passes on the current code — that is the point: it
exists so that a future change to `addedSince` cannot pass while the spec still claims a
different rule, and the PR says so rather than calling it a regression test.

*Alternative considered:* assert only the `0`. Rejected — pinning `spend` and `computed` too
is what makes the test the same shape as the sentence it backs (the base stands, the sampled
figure survives beside it).

## Risks / Trade-offs

- **The spec grows a paragraph on a behaviour nobody asked to change.** Accepted: the
  behaviour is reachable, and the old wording predicted a figure the ledger does not
  produce.
- **A reader may still be surprised that a correction entered in the first minutes of a day
  is not additive.** The scenario names the remedy; the panel already shows the sampled
  value next to the input. Widening the rule to admit a same-day pre-first-sample anchor
  would let a base absorb a window no sample of the day witnessed, which is the failure the
  rule exists to prevent.
- **A future change to the anchor span will now break a test.** That is the intended signal.
