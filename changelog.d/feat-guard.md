### Added

- Add the Guard, an agent that checks what enters and what leaves your agents' work. It is on by
  default at Light, where it looks for prompt injection: in pages that the built-in and the shared
  Playwright browser read, and in the URLs, text, scripts, files, chat posts, sites and MCP servers
  that agents send or add. A fast local check reads everything first, and a small model (Builder
  Fast of Cultura Builder by default) reviews only what looks suspicious. A clear risk goes to the
  approval card, also for an agent with Full access; Light never stops the work by itself. Turn it
  off, or choose another model or the local check only, in Settings, Guard.
