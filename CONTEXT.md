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

**Calibration line**:
The account-wide spend over the part of a session the balance samples cover, shown
beside the session estimate and labelled as account-wide. It includes every other
session and every other charge, so it calibrates the estimate rather than measuring
it, and it exists only when two or more samples fall inside the interval.
_Avoid_: balance delta, real cost.

**Subagent session**:
A session spawned by another session through the subagent catalog. It has its own
log, its own models and its own estimate, and its cost never enters the parent's
total; the Cost view marks the Step that spawned it and reads the child only on an
explicit ask.
_Avoid_: child thread, nested session.

**Spawn marker**:
The mark a Step carries because it established a subagent, drawn on the chart and
counted in the header. It is a fact about this session's own catalog, not a read of
the child.
_Avoid_: badge, subagent chip.

**Subtree**:
A session together with every session below it. Its total is the sum of the child
lines and of nothing else, so it never moves the session's own headline number.
_Avoid_: whole tree, full history.

**History export**:
One ordered NDJSON stream of a session's own records — usage and money per report,
retries, tool calls, and at the `full` level its words — with the subtree merged in
only when it is asked for. Assembled by the view from the Host's priced routes and
downloaded by the browser; never written into the workspace or `$DSH_HOME`.
_Avoid_: dump, log export, session download.

**Indicator**:
One deterministic, cheap detector over the per-Step series that names a single kind of
cost problem. It calls no model and touches no network, so detecting costs nothing and
the same series always yields the same verdict.
_Avoid_: check, rule, heuristic, anomaly detector.

**Finding**:
What an Indicator reports — `{kind, refs, severity, confidence, evidence}`, blaming a
Step, a Turn or a range of them. It ranks suspicion inside the **Session cost estimate**
and never states a real charge.
_Avoid_: alert, warning, issue, anomaly, problem.

**Severity**:
The `info` / `warn` / `alert` grade of a Finding. It restates the same margin the
**confidence** measures in discrete form; it is not a second, independent judgement.
_Avoid_: priority, level, importance, risk.

**Sensitivity preset**:
The one `strict` / `balanced` / `loose` choice that moves the thresholds and reporting
floors each Indicator ships by one factor together. Individual thresholds are pinned
beside it in the plugin configuration — used as written rather than scaled again — so
tuning never needs a code change.
_Avoid_: mode, level, threshold profile, sensitivity level.

**Compaction step**:
The node that carries the bill for one context compaction — the call that wrote the
summary — so that the **Session cost estimate** stays the sum of its nodes. It is
anchored to the Turn whose accumulated context it rewrote; a compaction before the
session's first Turn has no Turn to anchor to and stays turn-less, still counted in the
estimate. It is not a Step of the conversation: it holds no tool call and has no place
in Trajectory.
_Avoid_: synthetic step, summary step, compaction event, compaction record.
