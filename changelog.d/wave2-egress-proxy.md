### Added

- Send the internet traffic of a server's agents through an HTTP proxy, such as a residential proxy
  in Brazil. Server settings › Network egress (owner or admin only) takes one pasted line
  (`host:port:user:password` or `http://user:password@host:port`), a bypass list that keeps sign-in,
  the account service and Signal direct, and an expected country. The embedded browser, the shared
  Playwright browser, and every tool, MCP server and provider CLI that an agent starts use the proxy.
  **Test proxy** shows the IP address, city and country. When the proxy fails, or the country is not
  the expected one, pages and tools stop with a clear message: Builders Bot never falls back to a
  direct connection. The password is encrypted on the server and is never shown again or written to
  a log. **Use as default for new servers** gives the same proxy to each server that the app makes
  later.
