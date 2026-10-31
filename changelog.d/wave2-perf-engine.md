### Changed

- A message that you send to an agent starts sooner when the security reviewer is on. The reviewer,
  channel routing and side questions now use the provider process that stays ready for short
  generations. Before, each of them started a new provider process and the turn waited for it.
- While your Mac is low on memory, Builders Bot stops a provider process, with its MCP servers, 1 to 2
  minutes after its last turn. Before, an idle process stayed for 10 minutes. The next message starts
  it again, which takes some seconds more, and more when agents have MCP servers for each folder.
  Work that stays in that process after its turn stops too: Codex background terminals, programs
  that an OpenCode command left running, and MCP servers for each folder. Claude keeps its process
  while a background agent runs. Servers do not get this change.
- Cultura Builder sessions are compacted near 262K tokens on every model. Before, Builder Auto, Builder
  Code and Builder Fast sent up to 1M tokens again on each step of a long conversation. To keep the 1M
  window, turn on "Use the full 1M context of Cultura Builder" in Settings › General.

### Fixed

- OpenCode no longer starts the Playwright server of your own `opencode.json` for Builders Bot agents.
  Before, OpenCode 2 ignored the setting that turned it off, and the server ran beside the shared
  browser of Builders Bot.
