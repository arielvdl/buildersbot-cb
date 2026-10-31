### Added

- Add the Guard, an agent that checks what enters and what leaves your agents' work. It is on by
  default at Light, where it looks for prompt injection: in pages that the built-in and the shared
  Playwright browser read, and in the URLs, text, scripts, files, chat posts, sites and MCP servers
  that agents send or add. A fast local check reads everything first, and a small model (Builder
  Fast of Cultura Builder by default) reviews only what looks suspicious. A clear risk goes to the
  approval card, also for an agent with Full access; that card has no "Always allow". Ordinary
  pages, such as sign-in pages, cookie banners and pages about prompt injection, pass. Light never
  stops the work by itself, except in the shared Playwright browser, which cannot show the card: a
  call there that needs your answer does not run, and the agent tells you. Settings, Guard says when
  the chosen model is not available. Turn the Guard off, or choose another model or the local check
  only, in Settings, Guard.
