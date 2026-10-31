### Fixed

- OpenCode and Cultura Builder agents no longer start the Playwright server of your own
  `opencode.json` next to the shared browser of Builders Bot. With OpenCode 2, the setting that
  turned it off did nothing, so each OpenCode process of the app kept a second browser server open.
- On a Mac that is low on memory, an agent tab in the Builders Bot browser that nobody uses now
  unloads its page after 5 minutes, not 30, when that agent is not working on a reply. The tab of
  an agent that is still working keeps the 30 minutes. You and your agents can still open new tabs
  and pop-up windows. Before, only a server unloaded tabs sooner.
- When the offline cache of one site in the Builders Bot browser (the cache of its service worker) is
  larger than 100 MB, Builders Bot clears the cache and the service worker of that site after it
  opens. Other sites keep theirs. When the compiled scripts of a browser profile are larger than
  100 MB, Builders Bot clears them for all sites of that profile. Your sign-ins stay. The first visit
  to such a site after that is a little slower.
