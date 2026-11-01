### Added

- With "Continue after a short failure" on, in Settings > General > Advanced optimizations (beta), a
  channel task that a short provider or network failure (such as a 529 or a lost connection) stops in
  the middle of a turn continues by itself in the same session, at most 3 times. It continues only
  when nothing that the turn did can happen twice: before it continues, the app reads each step of
  the turn (reads, file changes, posts, pushes, messages) and tells the agent what is already done.
  When a post, a push or another outside action may already have happened, the task waits for you
  and says which action to check. The switch is off by default, and the app then works as before.
- Settings > Agents > Retries and backup model has the option "Continue also when an outside action
  is uncertain". It is off by default.
