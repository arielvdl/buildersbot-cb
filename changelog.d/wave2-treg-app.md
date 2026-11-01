### Added

- Agents can use paid data connections of Cultura Builder, such as the tool catalog (SEO and
  keyword data, company data, web search, app store and review data), through two tools that they
  find with `tool_search`: `openbot_connections.list` and `openbot_connections.call`. The key of each
  vendor stays in the Cultura Builder Hub; Builders Bot and its agents never get it. The tools are
  there only when you are signed in to Cultura Builder, your organization gives the connection, and
  the turn comes from you, from one of your routines, or from an agent that your turn started. A
  turn that a team member, a channel or a chat app started never gets them, also through a task, a
  routine, a new agent or a message to another agent that the turn makes. An agent that such a turn
  creates has every connection off until you turn them on.
- A routine that you saved before this version uses no connection until you save it again in
  Routines.
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
  Code agents, also when Codex cannot read its own config. For a Cursor agent, Builders Bot adds
  its names to the Cursor CLI's list of turned-off servers of the agent's project. Settings › General
  tells you that its token is in plain text, which files hold it, which agents (Grok, custom agents)
  can still use it, and that you should remove it and rotate the token.
- Marketplace › Apps has a Connections group with the paid connections of Cultura Builder, such as
  the tool catalog. The curated list hides a connection that you do not use, unless your
  organization's profile names it; the search and a link always reach it. Its page shows what it
  gives, the categories that your organization allows, your monthly limit with the 80 % mark, who
  pays (you can choose), a switch per agent, and where the data goes ("Provided by treg.to").
  "Ask the admin" and "Ask the admin for more" send a request through Cultura Builder, once in 7
  days.
- Usage shows the charges of the connections, apart from the model estimate, with a breakdown by
  platform, when Cultura Builder turns connection usage on.
- After a paid call, the chat shows what it cost and who paid. The first call over 80 % of your
  limit adds a notice, and a call that the limit stopped adds a line with "Ask the admin for more".
  A charge above the amount that you approved adds a line that tells you to tell an admin.
- When you sign out of Cultura Builder, or another person signs in, the payer that you chose, the
  lookups about people that you allowed and your use are forgotten.

### Fixed

- Usage no longer scrolls sideways when the totals have long labels, as in Portuguese.
- An app page whose status is long, such as "Precisa de atenção", puts the status under the name
  in a narrow window, instead of pushing the page action out of it.
