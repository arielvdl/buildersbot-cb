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
- The Guard reads every connection input and result. It stops a cookie, a session or a sign-in
  token before it leaves, with no way to allow it. It asks you before a long free text or a long
  block of data in one field leaves, and it puts a note in front of a result that asks the agent to
  install a tool, run a script, sign up, top up a balance, star a project or use the vendor first.
- The first lookup of data about people in a conversation shows a card with the names and the
  addresses that it sends. A routine never makes such a lookup. A result with emails or phone
  numbers tells the agent that they are unverified guesses.
- If treg's installer put a treg connection of your own in the MCP files of Codex, OpenCode, Cursor
  or Claude Code, Builders Bot turns it off inside its Codex, OpenCode, Cultura Builder and Claude
  Code agents, also when Codex cannot read its own config. Settings › General tells you that its
  token is in plain text, which files hold it, which agents (Cursor, Grok, custom agents) can still
  use it, and that you should remove it and rotate the token.
