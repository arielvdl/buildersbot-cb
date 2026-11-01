### Added

- When a provider does not start a task, the app tries again by itself: 3 more times by default,
  after about 10, 30 and 90 seconds. Then it runs the task on a backup model: the agent's own, or a
  new default backup model in Settings › Agents › Retries and backup model. The channel shows
  "Trying again (2/3)" in place of the card, and the card says how many starts ran.
- A usage limit, such as the 5-hour window of Claude, is tried again by default, because some
  accounts move to another account by themselves. You can send it to the backup model at once
  instead.
- An agent whose model failed stays on its backup model for 5, 15, 30 or 60 minutes, then one task
  tries its own model again. A task that started on the backup model ends there. Settings › Agents
  lists the agents on a backup model now and until when.

### Changed

- The task reviewer acts on a failed start after 5 minutes (with "slow after" at 5), then after 10,
  20 and 30, and follows the task until it starts: a resume, then a reassign to a free agent and a
  resume by turns, at most 6 actions (about 2 hours). Before, it waited 10 minutes each time and stopped
  after 2 resumes and 2 reassigns. It waits while the app tries a start again.
- The summary of a long channel history runs at the lowest reasoning level of the lead's model, and
  one at a time for each tab. Before, it ran at the lead's own level (such as Max), and two starts in
  one tab made the same summary, so a long channel often failed with "Profile generation timed out".
