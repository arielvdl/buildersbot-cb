### Fixed

- A quit request for Builders Bot from a script, such as `tell application "Builders Bot" to quit`,
  now quits the app. On a computer with a server on this computer, macOS could deliver it to that
  server: the server quit and started again, and the app kept running until a script stopped it
  about a minute later.
- A second quit while Builders Bot was still quitting, such as Cmd+Q again, no longer ends it before
  the database closes.
- The quit steps share one time limit. When several of them do not stop, such as the team
  connection, Builders Bot still closes the database and quits in about 20 seconds, not 30 or more.
- A server on this computer gets time to close its database when Builders Bot stops it.
