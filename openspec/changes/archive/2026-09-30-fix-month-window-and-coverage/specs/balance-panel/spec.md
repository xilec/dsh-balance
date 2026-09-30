# Spec Delta

## MODIFIED Requirements

### Requirement: The Summary tab

The Summary tab SHALL present the account as cards for the balance, today, this session, the
week and the month, and below them the detail rows the payload supports: the balance, its
granted and topped-up split, the three windows, the session estimate, the tariff in force and
the instant of the next change, the sample count, the sampling cadence, the credit total with
its event count, and when the balance was last read. A window card and its detail row MUST be
labelled with the number of days that window reports, not with a fixed count assumed by the
panel, so a window the ledger could not fill is labelled with what it holds. It MUST flag a
stale reading, an account-wide window that the samples do not cover — naming the days that
were measured — a day measured across a day boundary, and every model the rule cannot price,
and MUST report an unavailable account rather than a zero.

#### Scenario: A complete reading

- **WHEN** the payload carries a balance and a ledger
- **THEN** the cards and every supported detail row are shown with their values

#### Scenario: A window shorter than the panel's own label

- **WHEN** the payload reports a 1-month window that measured 3 days
- **THEN** the month card and its detail row are labelled 3 days rather than 30

#### Scenario: An unpriced model

- **WHEN** the session used a model with no rate
- **THEN** the flags line names that model

#### Scenario: Only a coarse day

- **WHEN** some day row was measured across a day boundary
- **THEN** the flags line says so, so the reader knows why an override exists
