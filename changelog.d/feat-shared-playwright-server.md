### Changed

- Agents share one Playwright connection to your browser. No Chrome starts for each agent, so many
  agents at once no longer use all the memory of the computer.
- Up to 8 agents can use the browser at the same time. Each agent can keep 4 tabs open, and all
  agents together 12. When an agent asks for one more tab, the browser refuses it and tells the
  agent to close a tab first.
