### Fixed

- The task reviewer tries a start that failed after 2 × its threshold (10 minutes at 5), not after the
  30 minutes of "Resume by itself". Before, a stopped card stayed for more than 15 minutes with the
  reviewer on.
- "Resume by itself" reads every stopped run, not only the first 50 rows. Before, a channel with many
  stopped runs hid the stopped work of the channels after it.
- "Resume by itself" no longer resumes a task that a resume cannot fix, such as a request that
  exceeds the routing context limit or a task whose agent was deleted. It gives the task to an agent
  with the same model when allowed, else it says that the task needs you.
- The lines of the task reviewer, of "Resume by itself" and of the memory level now go to
  `logs/task-reviewer/task-reviewer.log`. Before, they went nowhere in an app started from the Dock.

### Added

- Each stopped row of Settings › Load says what the app does next and when, such as "The task
  reviewer resumes it in 6 min", "Resume by itself waits: the agent waits for you" or "Needs you".
- The Task reviewer page of Settings shows why it waits for each task that it watches, and its last
  20 actions, which stay after a restart.
