### Changed

- A message that you send to an agent starts sooner when the security reviewer is on. The reviewer,
  channel routing and side questions now use the provider process that stays ready for short
  generations. Before, each of them started a new provider process and the turn waited for it.
- While your Mac is low on memory, Builders Bot stops each provider process that did no work for a
  minute or more, with its MCP servers. Before, an idle process stayed for 10 minutes. The next
  message starts it again.
- Cultura Builder sessions are compacted near 262K tokens on every model. Before, Builder Auto, Builder
  Code and Builder Fast sent up to 1M tokens again on each step of a long conversation.

### Fixed

- OpenCode no longer starts the Playwright server of your own `opencode.json` for Builders Bot agents.
  Before, OpenCode 2 ignored the setting that turned it off, and the server ran beside the shared
  browser of Builders Bot.
