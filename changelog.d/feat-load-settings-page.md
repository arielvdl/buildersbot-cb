### Added

- The load ring in the bar on the left now opens Settings › Load, a page with room for the work.
  It counts the stopped, failed and paused runs and the runs whose source was deleted. You can
  search, filter by state, agent, channel or tab, origin (routine or task) and source, and mark some
  rows, all rows, or all rows that the filters show.
- With rows marked, you can resume them, give them to another agent, change the model of their
  agents, or remove them, all at once. Remove asks first and can be undone for 10 seconds. A line
  says how many were done and why the others failed. Space marks a row and Shift marks a range.
- What runs now, the one-channel-at-a-time mode, the agent limit, Resume by itself and the task
  reviewer are on the same page, below the stopped work. The ring keeps its count and its tooltip.

### Fixed

- Stopped work of a deleted channel routine now leaves with the routine. Before, it stayed stopped
  for ever and you could not clear it.
- A channel routine no longer posts its request again each time the app starts. Before, a request
  that the lead could not route added one more stopped task at each start, and the run stayed queued.
- The red count of the ring counts every stopped run. Before, it stopped at 50.
