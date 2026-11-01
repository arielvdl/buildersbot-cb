### Fixed

- A quit request for Builders Bot from a script, such as `tell application "Builders Bot" to quit`,
  now quits the app. On a computer with a server on this computer, macOS could deliver it to that
  server: the server quit and started again, and the app kept running until a script stopped it
  about a minute later.
- A second quit while Builders Bot was still quitting, such as Cmd+Q again, no longer ends it before
  the database closes.
- The quit steps that keep no data share one time limit. When several of them do not stop, such as
  the team connection, Builders Bot still closes the database and quits within 30 seconds. The steps
  that save your data, such as the agent stop that records the turns it interrupts, keep their full
  time, and the database closes after them.
- A server on this computer that does not stop when Builders Bot quits is ended. It no longer keeps
  running after the app, which held its port and stopped it from starting again.
