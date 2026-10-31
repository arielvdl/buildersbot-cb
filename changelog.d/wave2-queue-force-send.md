### Added

- Each message in the queue above the composer has "Force now" (bolt icon). It stops the agent that
  works now, as Stop does, puts the message in the conversation and starts the same agent again with
  it, before the other queued messages. In a channel, only that agent stops. If the turn ends by
  itself first, the message starts once, with no stop. If the stop fails, the message stays in the
  queue and you see why.
- Before a force, a question explains that other agents that depend on the stopped work can get out
  of sync. "Don't ask me about this again" stops the question on this device and browser; "Ask before
  forcing a message" in Settings › General turns it on again.
- A joined server forces through the new `queue-force-v1` capability. A server that does not have it
  shows the button turned off, with a tooltip that says to update the server.
