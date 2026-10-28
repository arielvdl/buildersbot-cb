### Added

- Review every message and image a person sends for prompt injection, before the agent acts on it.
  The reviewer is on by default and uses the model of the agent. A message that it finds suspicious
  or hostile reaches the agent with the verdict in front of it, so pasted instructions from a page,
  a README or an image are read as data. The switch is in Settings, General.
