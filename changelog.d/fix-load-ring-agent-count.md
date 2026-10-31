### Fixed

- The number in the load ring counts the agents that run now. Before, it stayed at 0 while agents
  worked in channels, in side threads or in messaging chats. An agent with more than one turn counts
  one time, and the number can be more than ten.

### Changed

- The arc of the load ring shows the agents that run, and ten agents close the circle. The memory now
  sets the colour of the ring, and the tooltip and the panel still show it.
