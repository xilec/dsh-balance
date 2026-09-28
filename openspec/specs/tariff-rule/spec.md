# tariff-rule Specification

## Purpose
The published DeepSeek pricing decision the plugin bills with — rates per model and their
effective dates, the Beijing peak windows, the Chinese public holidays, off-peak pricing at
half, and the fallback rates for models the table does not price. One rule serves the ledger,
the readout, the peak chip and the session estimate, so a display can never disagree with what
was billed.

## Requirements

### Requirement: The rule carries its provenance

The Tariff rule SHALL name the published price list it was transcribed from and the date it
was last verified, and the Host MUST ship both to the browser half together with the holiday
list and the peak windows it is using, so a reader can check the rule and see when it was
last confirmed against the publisher.

#### Scenario: The rule is shown

- **WHEN** the panel or the peak chip renders the tariff
- **THEN** it offers the source URL and the verification date that came from the Host

### Requirement: Rate tables with effective dates

The Host SHALL price with a table of peak rates per model class, per million tokens, split into
cache hit, cache miss and output, and in the account currency. The rule MUST carry more than
one table, each with the instant it took effect, including the start of peak/off-peak pricing
and the Flash price cut of 2026-09-10 12:00 Beijing time; rates are those in force at the
instant of the event, not those current when the reader looks. A session that spans a price
change MUST be rendered against the tables the Host priced it with. Anything older than the
earliest table MUST be priced by that table and the payload MUST be able to mark it as an
approximation.

#### Scenario: An event before the cut

- **WHEN** a token is reported before 2026-09-10 12:00 Beijing time
- **THEN** it is priced with the earlier Flash table, while a token after it is priced with the
  current one

#### Scenario: A session spans the change

- **WHEN** the browser renders a session whose events fall on both sides of a price change
- **THEN** it receives the Host's rate schedule with effective dates and renders the change
  rather than re-deriving prices

#### Scenario: Pre-schedule history

- **WHEN** a sample predates the earliest published table the rule carries
- **THEN** it is priced by the earliest table and treated as an approximation

### Requirement: Peak windows and holidays

Peak SHALL be 09:00–12:00 and 14:00–18:00 Beijing time, Monday to Friday, excluding Chinese
public holidays. Everything else MUST be off-peak: nights, weekends, the holidays themselves
and the make-up working weekends around them. Every phase decision MUST be taken in Beijing
time, so the machine's own zone never changes what was billed. The rule MUST carry the
published holiday list for its year, allow the list to be replaced from configuration, and its
own calendar MUST be per year: a missing new year's list MUST be treated as ordinary weekdays
in the estimate rather than guessed.

#### Scenario: A weekday afternoon

- **WHEN** an event falls inside a peak window on an ordinary Beijing weekday
- **THEN** its phase is peak

#### Scenario: A public holiday

- **WHEN** an event falls on a date on the holiday list
- **THEN** its phase is off-peak with the reason `holiday`, and the reason is reported

#### Scenario: A make-up working weekend

- **WHEN** an event falls on a weekend that the notice designates as a working day
- **THEN** it is still billed off-peak, because weekends are off-peak in their own right

### Requirement: Off-peak is exactly half of peak

The off-peak rate SHALL be exactly half of the corresponding peak rate for every bucket, for
every model class and in both currencies. No table may carry an independently chosen off-peak
number.

#### Scenario: Comparing phases

- **WHEN** the same tokens are priced once at the peak rate and once at the off-peak rate
- **THEN** the off-peak answer is half the peak answer for each of cache hit, cache miss and
  output

### Requirement: Model classes and unpriced models

The rule SHALL resolve a model id to a class by the ids it knows, including the legacy ids
that are still billed at their class rates, and by a substring fallback for dated variants. A
model it cannot resolve MUST be reported as unpriced: its tokens are counted, its money
metrics are excluded, and it is never silently priced as zero.

#### Scenario: A legacy id

- **WHEN** a session uses an older id that belongs to a priced class
- **THEN** it is billed at that class's rates

#### Scenario: An unknown model

- **WHEN** the model is outside the table and no fallback rate applies
- **THEN** the event is reported as unpriced and contributes nothing to a money total

### Requirement: Pricing one report

Pricing an event SHALL use the phase in force at that event's instant, unless a Tariff
projection explicitly asks for all tokens at the peak or the off-peak rate, in which case the
phase MUST be forced without changing which table the event's instant selects. Cache-write
tokens SHALL be billed as a cache miss. The priced result MUST carry the three bucket rates in
force, the currency, the phase and the reason for it.

#### Scenario: A forced projection

- **WHEN** the same event is priced under the `peak` and under the `offPeak` projection
- **THEN** each uses the table of the event's instant with the requested phase forced

#### Scenario: A cache write

- **WHEN** a report carries cache-write tokens
- **THEN** they are charged at the cache-miss rate

### Requirement: Fallback rates for models outside the table

The Host SHALL support two ways to price a model the table does not know: account-wide
`fallbackPrices`, applied only when pricing unknown models is enabled, and per-model
`fallbackRates` entered by the reader, which MUST win over the account-wide ones and MUST price
the model even when that setting is off. A fallback rate is a peak rate per million tokens with
cache hit, cache miss and output; off-peak MUST be half of it, cache write MUST be billed as a
cache miss, and the same rule MUST price the ledger, the composer readout and the session
estimate. Entering a rate MUST reprice the history, and that recomputation is described by the
`session-cost-analysis` capability.

#### Scenario: Pricing unknown models is on

- **WHEN** a model has no table rate and pricing unknown models is enabled
- **THEN** the account-wide fallback prices are used

#### Scenario: A rate entered for one model

- **WHEN** the reader enters rates for a specific unpriced model
- **THEN** that model is priced by them on both phases even though pricing unknown models is
  off, and the unpriced mark disappears

### Requirement: Phase, transitions and countdown

The Host SHALL expose the phase in force with the instant of the next change and whether that
change enters or leaves peak, the next peak instant while off peak, the windows of the reader's
current and following local day, and the upcoming transitions over the following days bounded
to a small number. It MUST render a timezone label for an IANA zone or the machine's own zone,
falling back to UTC for an unrecognized name, and MUST derive the published UTC window labels
from its Beijing windows rather than from a second hand-written copy. A remaining time MUST be
rendered compactly in days, hours, minutes and seconds, and a past instant MUST render as zero.

#### Scenario: Off peak with a change coming

- **WHEN** the reader is off peak and the next window starts soon
- **THEN** the payload says so, names the reason, and carries the transition the chip counts
  down to

#### Scenario: The reader's zone

- **WHEN** the browser asks for a specific zone
- **THEN** the windows are labelled in that zone, and an unusable zone name falls back without
  an error

#### Scenario: A countdown under a minute

- **WHEN** fewer than 60 seconds remain until the phase changes
- **THEN** the countdown renders in seconds and never renders a negative value

### Requirement: The rule is served, not re-derived

The browser half SHALL receive the rule from the Host and MUST NOT hold its own copy of the
rates, the windows or the holidays. The read route MUST carry the current phase, the schedule
of upcoming transitions, the off-peak ratio, the reader's zone, the local windows, the holiday
list, the published UTC labels and the source of the rule; the panel's price columns MUST be
priced by the Host at an instant inside a peak window, and each MUST be reported as unpriced
rather than zero when no rate applies.

#### Scenario: A rule update

- **WHEN** the Host changes a rate, a window or the holiday list
- **THEN** every display follows the new rule on its next read, with no client-side change

#### Scenario: No rate for a published model

- **WHEN** a model shown in the panel's price list has no rate
- **THEN** the entry is reported as missing rather than as a zero price
