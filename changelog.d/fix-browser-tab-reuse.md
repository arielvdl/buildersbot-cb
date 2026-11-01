### Fixed

- Agents that use your own Chrome no longer open a new tab and a new tab group at each turn. The
  connection to the Playwright extension stays between turns, and an agent goes back to the tab it
  used last.
- Two agents no longer drive the same tab: an agent gets a tab that no other agent works in.
- Closing the last tab of a group no longer ends the connection: the tab stays, blank, for the next
  page.

### Changed

- The tabs of each project are in one tab group with the project's name: the sidebar section of the
  agent, else the agent. Up to 3 projects get a group of their own; the others use the
  "Builders Bot" group.
- Agents are told to open each page in their current tab, and to open a second tab only when they
  need two pages at the same time.
- After 10 minutes with no agent, a group is put away: its blank tabs close, and tabs with a page
  stay open.
