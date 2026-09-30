# Spec Delta

## MODIFIED Requirements

### Requirement: Subagent sessions

The view SHALL mark subagent spawns on the Step that spawned them, using the subagent catalog
for the child's id, label and mode and the child's own session cost estimate for its total. The
cost of a subagent session MUST NOT be folded into the session total of the parent, which
covers that session only. Expanding the subtree SHALL be an explicit action with progress that
reads the child sessions through a separate route walking the subagent catalog; the main series
route MUST NOT serve any child session. That walk MUST stop when the reader's connection closes
before the answer has been written, and MUST NOT stop for any other signal: a request whose
body has already been consumed is a finished request, not a reader who went away. Per-child lines and the subtree cost attributed to the
spawning Step SHALL be shown only after that action: the first ask reads the direct children,
and the explicit "load full history" action — which exists for the subtree only — extends the
read to every session below the session. Reading the subtree SHALL be a tab of the view beside
the session's own reading, so including or excluding subagents is a tab switch and never a
change to what the header total means; the selection of the session's own tab SHALL be a saved
view choice. Each child line SHALL offer a one-click jump into that child session's own Cost
view, so following the money does not require retyping an id. The jump SHALL open the session
through the shell and SHALL ask for the Cost tab both as that session's stored view preference
and on the live conversation binding, because a session the shell has not bound yet can only be
steered through its stored preference.

#### Scenario: Markers by default

- **WHEN** the reader opens the Cost view of a session that spawned subagents
- **THEN** the spawning Steps carry markers and the header total still covers the session alone

#### Scenario: Switching between the session and the subtree

- **WHEN** the reader switches the tab under the chart
- **THEN** one tab shows the session's own top list and the other shows the subtree, while the
  header total covers the session alone on both

#### Scenario: Expanding the subtree

- **WHEN** the reader asks to include subagents
- **THEN** progress is shown, the child sessions are read through the subagent route, and their
  costs appear as per-child lines attributed to the spawning Step

#### Scenario: Loading the whole subtree

- **WHEN** the reader asks for the full history of the subtree
- **THEN** every session below the session is read, and each one appears as its own line with its
  own cost under the Step that spawned it

#### Scenario: Following a child into its own Cost view

- **WHEN** the reader activates the jump on a child line whose session is already open on another
  tab
- **THEN** the shell switches to that session with its Cost view active, or — if the shell offers
  neither the preference nor the binding — opens the session and leaves the tab to the reader

#### Scenario: The reader closes the Cost view mid-walk

- **WHEN** the connection behind a subtree request closes while the walk is running and no
  answer has been written
- **THEN** the walk is cancelled, while a request whose body is merely consumed, and a request
  that was answered, are not

#### Scenario: A child that cannot be read

- **WHEN** a child session cannot be read
- **THEN** the remaining lines are still reported and the unreadable branch is named as a
  diagnostic

