# Spec Delta

## MODIFIED Requirements

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
