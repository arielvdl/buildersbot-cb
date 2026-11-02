### Added

- A Feed page in the page rail shows what each run of each agent does, on every project and every
  server, as it happens. Each run is one card that changes in place: the agent, the project, the
  task, the state, the step that it does now and what it waits for. The newest run is at the bottom.
- The Team is a list on the side of the Feed page. Select an agent to see only its runs.
- Filter the feed by project, agent and state, search it (press `/`), or group it by project or by
  agent. The counters "Needs you", "Stopped" and "Working" go to the next such run.
- When you scroll up, the feed pauses and counts the new runs. A button goes back to the newest run.
- A run that needs you opens its conversation, where you answer. The feed shows only summaries: it
  never shows the text of a conversation, the arguments of a tool, or a secret.
