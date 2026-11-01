### Fixed

- A usage limit that stops a task before it does any work, such as the 5-hour window of Claude, now
  gets the same tries again and backup model as a task that did not start. Before, it went to the
  agent's backup at once, or waited for the reset, and never used the default backup model.
- A slow summary of the channel history runs on the lead's model, so it no longer moves another
  agent to its backup model or keeps that agent's model from other agents.
- An agent whose model failed no longer moves other agents on the same model to their backups.
- A task that waits to run on the backup model no longer stays in "Trying again" for good: after 10
  minutes it runs, or it stops and the task reviewer takes it.
- While an agent waits on its backup model, its other tasks no longer start on its own model and
  make the wait longer. Tasks that fail together count as one failure.
- An agent goes back to its own model when its wait ends. A task that waits for a person no longer
  keeps it on the backup model, and a task that keeps it there does so for at most 2 hours.
- An agent set to ask before it switches never moves to the default backup model. Settings › Agents
  lists it with "asks first".
- An agent can no longer give another agent a backup model that switches without asking, or one on
  a provider account that the other agent does not use. Only you can.
