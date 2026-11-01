### Fixed

- OpenCode used much memory when agents worked in many folders. It kept a full set of your MCP
  servers for each agent folder, about 200 MB each, for as long as any agent used it. Now Builders
  Bot stops OpenCode when no turn runs and a folder was idle for 5 minutes, or when it holds more
  than 4 folders. The next message starts it again in the same conversation; only that first
  message is slower.

### Changed

- The resource log (`logs/resources.ndjson`) now records the memory level of the Mac, and for each
  provider the number of MCP processes, folders and sessions. This helps to find the cause of a
  memory problem.
