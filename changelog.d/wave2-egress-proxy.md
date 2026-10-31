### Added

- Send the internet traffic of a server's agents through an HTTP proxy, such as a residential proxy
  in Brazil. Server settings › Network egress (owner or admin only) takes one pasted line
  (`host:port:user:password` or `http://user:password@host:port`), a bypass list that keeps sign-in,
  the account service, Signal and the Tailscale network direct, and an expected country. The
  embedded browser, the shared Playwright browser, the provider CLIs (the Codex app-server and
  Cultura Builder too) with their titles, reviews and routing, the tools and MCP servers that agents
  start, the WhatsApp accounts panel, and the MCP requests that Builders Bot sends for the agents use
  the proxy. Sign-ins and the app's own services stay direct. **Test proxy** shows the IP
  address, city and country. When the proxy fails, or the country is not the expected one, pages and
  tools stop with a clear message: Builders Bot never falls back to a direct connection. A change of
  the switch starts the agent processes again after their current turn. The password is encrypted on
  the server and is never shown again, written to a log or put in a process environment; a change of
  host, port or user asks for it again. **Use as default for new servers** gives the same proxy to
  each server that the app makes later.
