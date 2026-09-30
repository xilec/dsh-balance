# Spec Delta

## MODIFIED Requirements

### Requirement: Findings list

The Cost view SHALL show the Findings of the visible range as a card of the same height beside the
two readings it already shows under the chart, scrolling inside itself rather than extending the
page. The list SHALL be ordered by `severity × confidence`, ties broken by the Finding's share of the
session cost, then by the earlier position, then by `kind`. Each row MUST name the Indicator, the
location it blames, its severity, its confidence as a ranking aid, and its evidence; activating a row
SHALL select the Step it starts at, and — when that Step is outside the visible range — the first
Step of its range that is inside it. A Finding whose whole range is outside the visible range MUST
NOT be listed.

#### Scenario: Order is stable

- **WHEN** the same series is rendered twice
- **THEN** the list is in the same order both times

#### Scenario: Row selects its Step

- **WHEN** the reader activates a row
- **THEN** the Step the Finding starts at is selected on the chart and in the inspector

#### Scenario: A Finding that starts off screen

- **WHEN** the Step a Finding starts at is outside the visible range but a later Step of its
  range is inside it
- **THEN** the row is listed, marked as reaching beyond the range, and activating it selects the
  first referenced Step the range holds
