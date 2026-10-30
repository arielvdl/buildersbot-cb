### Added

- The load panel lists the work that stopped, with its channel, its request, the reason and the
  agent. You can resume one task, resume all, or reassign a task to another agent of the channel,
  the same model first. The panel also lists the agents that work now, with a Stop button.
- Resume by itself: stopped work starts again after an interval that you set (30 minutes is
  suggested). When you allow it, a task can go to another agent of the channel. Each task gets a
  fixed number of tries. It is off by default.
- A red count on the load ring shows how much work stopped.

### Fixed

- The load ring opens its panel again on a click. Before, a click did nothing.
- When the Mac is low on memory, new agent messages wait in the queue and start by themselves when
  memory is free again. Before, agents could use all the memory until macOS asked you to close apps.
- OpenCode agents no longer start the Playwright of your own `opencode.json`. Before, each agent
  started its own Playwright and Chrome, which used much memory.
