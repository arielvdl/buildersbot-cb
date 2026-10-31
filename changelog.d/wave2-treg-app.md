### Added

- Agents can use paid data connections of Cultura Builder, such as the tool catalog (SEO and
  keyword data, company data, web search, app store and review data), through two tools that they
  find with `tool_search`: `openbot_connections.list` and `openbot_connections.call`. The key of each
  vendor stays in the Cultura Builder Hub; Builders Bot and its agents never get it. The tools are
  there only when you are signed in to Cultura Builder, your organization gives the connection, and
  the turn comes from you or from one of your routines.
- A call that costs more than your organization's approval limit shows a card with the cost and
  the organization that pays. Only you can allow it, once. A routine cannot approve a cost.
- When you have more than one organization, a card asks which one pays. If that organization
  removes you, Builders Bot asks again and never moves the cost to another organization by itself.
- Builders Bot refuses, before anything leaves the computer, a call input that holds a key, a
  token, a cookie or a session, or a URL of a private, local or Tailscale address.
