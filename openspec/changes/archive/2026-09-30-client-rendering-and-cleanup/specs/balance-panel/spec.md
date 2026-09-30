# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
