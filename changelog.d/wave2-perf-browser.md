### Fixed

- OpenCode and Cultura Builder agents no longer start the Playwright server of your own
  `opencode.json` next to the shared browser of Builders Bot. With OpenCode 2, the setting that
  turned it off did nothing, so each OpenCode process of the app kept a second browser server open.
- On a Mac that is low on memory, an agent tab in the Builders Bot browser that nobody uses now
  unloads its page after 5 minutes, not 30, when that agent is not working on a reply. The tab of
  an agent that is still working keeps the 30 minutes. You and your agents can still open new tabs
  and pop-up windows. Before, only a server unloaded tabs sooner.
- When the site caches of a browser profile (service workers and compiled scripts) are larger than
  100 MB, Builders Bot clears them after it opens. Your sign-ins stay. The first visit to such a
  site after that is a little slower.
