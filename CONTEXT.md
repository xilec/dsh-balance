# dsh-balance

Domain glossary: `CONTEXT.md` — canonical terms and avoid-lists. The project
description lives in the `context` block of `openspec/config.yaml`.

## Language

**Spend**:
Account-wide money actually deducted, derived from balance differences
(`balance(t0) − balance(t1) + credits`). The truth this plugin is built on.
_Avoid_: cost, usage, consumption, expense.

**Credit event**:
A rise in the balance recorded as a top-up or refund instead of negative spend.
_Avoid_: payment, recharge, adjustment.

**Session cost estimate**:
Money estimated for one session from the provider-reported tokens, each sample
priced by the tariff rule in force at the instant it was reported. An estimate,
never the truth.
_Avoid_: session spend, session cost, bill.

**Tariff rule**:
The published DeepSeek pricing decision this plugin bills with: rates per model,
the Beijing peak windows, the Chinese public holidays, and the date the rule was
verified.
_Avoid_: price table, pricing config, schedule.

**Tariff projection**:
One of the three ways the same tokens are priced — `fact` (rates at the event's
instant), `offPeak` (every token at the off-peak rate), `peak` (every token at
the peak rate). Always write the qualifier; `fact` is the default.
_Avoid_: scenario, mode, variant, projection (unqualified).

**Session projection**:
The dsh host mechanism (`sessionProjections`) that folds committed session events
into a client-visible value; dsh-balance registers `dshBalanceCost` through it.
_Avoid_: projection (unqualified).

**Step**:
One `(turn, step)` location: the finest granularity the provider reports usage
for, because usage arrives per assistant message. A step may hold several usage
reports when a model is switched or an attempt is retried.
_Avoid_: request, call, round.

**Turn**:
A sequence of steps opened by one user message; the natural boundary for per-turn
aggregates.
_Avoid_: exchange, conversation, interaction.

**Unpriced model**:
A model with no rate in the tariff rule. Its tokens are counted and shown, never
silently priced as zero.
_Avoid_: unknown model, missing rate.

**Cost view**:
The per-session `conversation.view` tab that shows where a session's estimated
cost goes.
_Avoid_: cost tab, cost page, analytics view.
