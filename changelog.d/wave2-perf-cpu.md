### Changed

- Builders Bot uses less CPU and battery when it is idle. The main process wakes up 10 times a second
  to measure its own delays, not 50 times. The Computer Use outline asks the driver once a second
  while no agent uses the desktop, not 30 times a second, and still shows at the first action of an
  agent.
- The idle Dynamic Island blinks its logo from a timer, and draws no frames between two blinks.
- A working agent's avatar stops moving while it is out of sight, such as in a collapsed sidebar
  section or below the end of the sidebar. A collapsed section also stops the shimmer, the dots and
  the breathing of its rows.
- A browser preview card captures a page that does not change less often: the wait grows from 3 to
  12 seconds, and goes back to 3 seconds when the page changes.
- While a reply streams in a channel that is not open, Builders Bot reads only the channel list, not
  the open channel's page again.
- Each window of Builders Bot loads only English and Portuguese at start. Another language loads the
  first time that a window shows it. Each window uses less memory.
- A conversation keeps fewer inline images of agent messages in memory. A chat that you open again
  can read its older images again.
