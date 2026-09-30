# balance-panel Specification

## Purpose
The browser half of the plugin: the balance pill in the composer dock, the peak chip in the
session header, and the panel that opens from the pill with the account summary, the editable
day ledger, the credit list, the settings and the fallback rates. It renders the Host's cached
payload and never talks to DeepSeek itself.

## Requirements

### Requirement: The client half registers its own surfaces

The plugin SHALL ship a browser half for the `web` platform that declares the slots and locale
services it needs and requires nothing but the shared React runtime. It MUST register the
balance readout in the composer dock to the left of the shipped token-usage pills, the peak
chip in the session header actions and in the input overlay for a fresh session, and its own
locale namespace for the copy it renders. It MUST inject its stylesheet once and MUST NOT
depend on any other plugin's JavaScript.

#### Scenario: The plugin loads in the shell

- **WHEN** the profile includes the plugin and a session is open
- **THEN** the readout appears in the composer dock and the peak chip in the session header,
  with no other plugin required

#### Scenario: The Cost view is registered separately

- **WHEN** the shells enumerate conversation views
- **THEN** the Cost view is offered by this plugin and its behavior is the subject of the
  `session-cost-analysis` capability, not this one

### Requirement: The composer readout

The readout SHALL show, in one unlabelled line, the account balance, the spend of today, of the
week so far and of the month so far, and the current session's estimated cost, separated by dots
and slashes. It MUST carry no visible labels: the legend MUST be the native tooltip and the
panel. The legend MUST name the three windows as today, the week so far and the month so far, and
MUST append the number of calendar days the week and the month span when the payload reports
it. A window whose ledger does not reach back to its first day MUST be shown muted rather than
hidden, and MUST NOT be muted merely because today is early in that week or month. The readout
MUST use the same type size, colour and hover treatment as the shipped token-usage pills, MUST
render the placeholder for every figure before the first payload, and MUST be a button that
opens the panel and closes it again on a second click or `Escape`. Its accessible name MUST be
the same legend the tooltip shows.

#### Scenario: Figures and their legend

- **WHEN** a payload is available
- **THEN** the line shows the balance, the three windows and the session estimate without
  labels, and hovering reveals what each figure is

#### Scenario: Not enough samples for a window

- **WHEN** the samples do not reach back to the first day of a window
- **THEN** that figure is drawn muted while the others stay normal

#### Scenario: A window that is short only by the calendar

- **WHEN** today is a Monday, or the first day of a month
- **THEN** that window's figure is drawn normally, because the ledger does reach its first
  day

#### Scenario: No payload yet

- **WHEN** the first read has not answered
- **THEN** the line shows placeholders rather than a zero

#### Scenario: Opening and closing the panel

- **WHEN** the reader clicks the readout and then presses `Escape`
- **THEN** the panel opens above the line and closes without navigating away

### Requirement: The panel and its tabs

Clicking the readout SHALL open a panel anchored above the composer line, with no backdrop,
closed by a second click, by a click outside, by the close control or by `Escape`. The panel
MUST be a labelled dialog, MUST open on the Summary tab, and MUST offer the Summary, Days,
Credits and Settings tabs in that order with the active one marked. It MUST pin its height to
the summary content while staying inside a bounded maximum, and MUST scroll its body rather
than the page. The footer MUST link the rule's source and the platform's own usage view, MUST
offer a manual refresh, and MUST show the Host's version and the browser half's version. A
manual refresh the Host refuses MUST be reported in the footer with the reason, and the report
MUST be cleared by the next attempt.

#### Scenario: Height does not jump between tabs

- **WHEN** the reader switches from Summary to Days or Credits
- **THEN** the panel keeps the height it pinned on the first summary render

#### Scenario: Closing outside

- **WHEN** the reader clicks anywhere outside the open panel
- **THEN** the panel closes

#### Scenario: A refresh the Host refuses

- **WHEN** the reader asks the Host to sample immediately and the request is rejected
- **THEN** the footer shows the reason instead of leaving the press without an answer

### Requirement: The Summary tab

The Summary tab SHALL present the account as cards for the balance, today, this session, the
week and the month, and below them the detail rows the payload supports: the balance, its
granted and topped-up split, the three windows, the session estimate, the tariff in force and
the instant of the next change, the sample count, the sampling cadence, the credit total with
its event count, and when the balance was last read. A window card MUST name the calendar its
window is anchored to — the week from Monday, the month from its 1st — and both the card and
its detail row MUST be labelled with what the window is ("so far this week", "so far this
month"), never with a fixed count the panel assumed; the number of calendar days the window
spans MUST be shown from the payload's own count, and omitted rather than guessed when the
payload reports none. It MUST flag a stale reading, every window whose ledger does not reach
back to its first day — naming the days that were measured out of the days the window spans, for
that window — a day measured across a day boundary, and every model the rule cannot price, and
MUST NOT flag a window that is short only because today is early in it, and MUST report an
unavailable account rather than a zero.

#### Scenario: A complete reading

- **WHEN** the payload carries a balance and a ledger
- **THEN** the cards and every supported detail row are shown with their values

#### Scenario: A week that started on Monday

- **WHEN** the payload reports a week that measured four of its four days
- **THEN** the week card reads as the week from Monday, its detail row reads as the spend so
  far this week, and both name the four days it spans

#### Scenario: A window shorter than the panel's own label

- **WHEN** the payload reports a 1-month window that measured 3 of the 24 days it spans
- **THEN** the month card and its detail row are not labelled with a length of their own, the
  card names the month from its 1st, and the flags line says 3 of 24 days measured

#### Scenario: A payload with no day count

- **WHEN** the payload's windows report no count of the days they span
- **THEN** the cards and rows name the windows and no count is invented for them

#### Scenario: An unpriced model

- **WHEN** the session used a model with no rate
- **THEN** the flags line names that model

#### Scenario: Only a coarse day

- **WHEN** some day row was measured across a day boundary
- **THEN** the flags line says so, so the reader knows why an override exists

### Requirement: The Days tab

The Days tab SHALL list the day rows newest first, each with its date, the value derived from
the samples, and an input for the manual correction. A corrected row MUST show its reset
control, a row measured across a day boundary MUST be flagged coarse, and a corrected row that
is still growing MUST show the amount added since the correction. An entry MUST be committed on
`Enter` and on losing focus, `Escape` MUST discard the edit on screen and MUST NOT close the
panel, and a row whose request is in flight MUST not be edited again: its input MUST be
disabled and a commit attempted while it is in flight MUST be refused. The tab MUST surface a
failed write rather than swallow it.

#### Scenario: Correcting today

- **WHEN** the reader types an amount into today's row and presses `Enter`
- **THEN** the correction is written to the Host and the row shows the base and what has been
  measured after it

#### Scenario: Abandoning an edit

- **WHEN** the reader presses `Escape` while editing a row
- **THEN** the value on screen returns to the stored one, nothing is written and the panel
  stays open

#### Scenario: Emptying the field of a sampled day

- **WHEN** the reader clears the input of a day that has a sampled value and commits
- **THEN** the sampled value becomes the row's base, and clearing a day with no sampled value
  removes the override

#### Scenario: A failed write

- **WHEN** the Host rejects the correction
- **THEN** the tab shows the error

#### Scenario: A row whose write is in flight

- **WHEN** the reader presses `Enter` twice on the same row
- **THEN** only one correction is written, and the row's input cannot be edited meanwhile

### Requirement: The Credits tab

The Credits tab SHALL list the recorded credit events newest first, each with its local date
and time, its amount and the balance it produced, and MUST show the all-time credit total above
them. With no credits recorded it MUST explain that a rising balance is recorded as a credit
rather than as negative spend.

#### Scenario: A top-up was recorded

- **WHEN** the ledger holds credit events
- **THEN** each appears with its instant, amount and resulting balance, and the total is shown

#### Scenario: No credits

- **WHEN** the ledger holds none
- **THEN** the tab says so and explains what would appear there

### Requirement: The Settings tab

The Settings tab SHALL offer the account currency, the day zone, both polling cadences, both
balance thresholds and the day-row count as inputs, prefilled from the payload, and MUST submit
the changed values to the Host, reporting success or the Host's validation error; the Host
remains the authority on what a valid value is. It MUST state that the Host samples on its own
schedule and that this tab only writes settings. It MUST mark both balance thresholds as
reserved — naming that no surface colours the balance by them yet — rather than presenting
them as controls that produce a visible change, while still writing them to the Host. When the
payload knows any fallback-rate model
— an entry the reader has already entered or a model the session could not price — the tab MUST
offer the fallback-rate editor: three peak rates per million tokens (cache miss, cache hit,
output) per model, where an all-empty row removes that model's entry, an incomplete row is
refused with a message and written only when every rate is a non-negative number, and the note
explains that off-peak is half and a cache write is billed as a cache miss. A successful write
of the polling cadence MUST take effect in the running browser without a reload.

#### Scenario: Saving settings

- **WHEN** the reader changes the day zone and applies
- **THEN** the Host is asked to store it and the tab reports success or the rejection

#### Scenario: A threshold that changes nothing yet

- **WHEN** the Settings tab offers the two balance thresholds
- **THEN** both are labelled as reserved and the tab says that no surface colours the balance
  by them, and a value typed into either is still written to the Host

#### Scenario: Entering a fallback rate

- **WHEN** the reader fills all three rates for an unpriced model and saves
- **THEN** the rates are written, and a model with an incomplete row is refused with a message

#### Scenario: Removing a fallback rate

- **WHEN** every field of a model's rate row is emptied and saved
- **THEN** that model's entry is removed

### Requirement: The peak chip

The plugin SHALL show a peak chip in the session header for the session's own route, and a
floating copy for a fresh session's input, and MUST hide it rather than guess when the route is
unknown, when the route does not use the rule's provider, or when the payload carries no tariff
phase. The chip MUST read `Peak · ends in …`, `Peak soon · …` or `Off-peak · peak in …`
according to the phase, MUST count down to the next change without polling the Host more often,
and MUST be visually distinct per phase. Clicking it MUST expand a panel listing the tariff in
force, the provider and model, today's and tomorrow's windows in the reader's zone, the
published UTC windows, the weekend and holiday note, the off-peak-is-half note, the next
change, and the source of the rule with its verification date. The windows MUST be the ones the
Host computed for the reader's own zone.

#### Scenario: Off peak

- **WHEN** the phase is off peak
- **THEN** the chip names the phase and counts down to the next peak window

#### Scenario: Peak about to start

- **WHEN** a peak window starts within the warning lead time
- **THEN** the chip says peak is soon

#### Scenario: A foreign route

- **WHEN** the session's route does not use the rule's provider
- **THEN** no chip is rendered

#### Scenario: The countdown ticks

- **WHEN** the chip is visible
- **THEN** its remaining time updates every second from the Host's transition schedule without a
  request per second

### Requirement: One poller feeds every surface

The browser half SHALL read the Host through one shared poller: an immediate read, then a
chain of timeouts at the cadence the Host reports, clamped to a sane range, re-read on a
session change and when the page becomes visible, and skipped while the tab is hidden. A read
that fails MUST leave the last good payload on screen and MUST NOT show a zero; the next
scheduled poll is the retry, and the footer's refresh control asks the Host to sample
immediately. The reader's zone MUST be sent with every read so the Host computes the windows
in it. Only the conversation record that reopens the Cost view MAY be stored in the browser;
the balance, the ledger, the overrides, the settings and the chart's window range MUST NOT be
stored there.

#### Scenario: The tab is hidden

- **WHEN** the page is hidden
- **THEN** the poller does not read, and a read happens when the page becomes visible again

#### Scenario: A read fails

- **WHEN** the Host does not answer or returns an error
- **THEN** the last good figures stay on screen and the polling continues

#### Scenario: Nothing durable in the browser

- **WHEN** the page is reloaded
- **THEN** every figure comes from the Host again, and only the view choice was kept locally

### Requirement: Money, time and copy

The browser half SHALL render money with the symbol of the account currency — `¥`, `$`, `€`,
`₽`, or the currency code with a space — showing whole units from a thousand upwards and the
currency's decimals below that, and MUST render a missing figure as a placeholder rather than a
zero. Durations and remaining times MUST be rendered compactly in days, hours, minutes and
seconds, and MUST NOT render a negative value. Times and dates MUST use the browser's locale,
while the panel's labels and notes MUST come from the plugin's own copy, which ships in
English and Russian, so the two can differ.

#### Scenario: A large balance

- **WHEN** a figure reaches a thousand units
- **THEN** it is rendered without decimals

#### Scenario: An unknown figure

- **WHEN** a figure is missing or not a number
- **THEN** a placeholder is rendered

#### Scenario: A currency without a known symbol

- **WHEN** the account currency has no symbol in the plugin
- **THEN** the code is shown before the amount

### Requirement: An anchored panel stays inside the window

A panel the browser half anchors to a pill — the popover from the composer readout and the
expanded panel of the peak chip — SHALL be positioned so that it stays within the viewport:
its left edge MUST be moved inward when the anchor would place any part of the panel outside
the window, it MUST be re-positioned when the window is resized, and a panel that already fits
MUST be left where the anchor puts it.

#### Scenario: A narrow window

- **WHEN** the panel opens next to a pill at the right-hand end of a window narrower than the
  panel
- **THEN** the panel is drawn inside the window rather than hanging off its right edge

#### Scenario: A window that fits the panel

- **WHEN** the anchor is far enough from the window's edge for the panel to fit
- **THEN** the panel is drawn at the anchor's own edge, unchanged
