### Changed

- Each tab of a channel is now its own line of work for each agent. A message in one tab no longer
  waits for the work of the same agent in another tab: it waits only for the earlier messages of its
  own tab. The tabs of one agent run at the same time up to a limit, 2 by default.
- Settings > Load and the load panel have "Channel tabs of one agent at the same time" (1 to 4). With
  1, an agent works in one tab at a time, as before.
- A tab whose turn waits for your answer, your approval or a browser takeover does not take a place
  among the agent's tabs. A tab whose task waits for other members did not take one before either.
- A message that waits in a channel tab shows why: the earlier message of the tab, the agent's limit
  of tabs, low memory, or a message of the agent's own chat that came first.
- The queue of the agent's own chat names the channel tab that holds the agent, and how many tabs
  hold it.
- While the computer is low on memory, an agent that works opens no second tab. The tab starts when
  memory is free.

### Fixed

- A turn that started in one tab could take the starting message of another tab of the same agent.
- The rows of a turn could go to the task of another tab of the same channel.
- The record of what an agent's session read in one tab was written for every tab of that channel,
  so the next message of another tab got the whole channel again.
- The task reviewer took the start of a turn in one tab for the start of a turn in another tab of
  the same channel, and the running list could name the task of another tab.
