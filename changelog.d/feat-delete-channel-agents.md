### Added

- Delete a channel together with its agents: when some members are in no other channel, the delete
  confirmation lists them with "Also delete the agents that exist only in this channel", off by
  default. The channel goes to Deleted channels first, then each agent is deleted (on desktop, each with its own Undo).
  Restoring the channel does not bring these agents back.
