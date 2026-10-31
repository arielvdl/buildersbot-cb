### Added

- Add the task reviewer, an experimental helper in the load panel that is off by default. While
  Resume by itself is on, it looks for channel tasks that are parked too long: a run that gives no
  sign for a long time while it holds a place, a request that waits in the queue with a free place,
  and a start that the provider fails again. It acts on one task at a time: it gives the task more
  time, resumes it, gives it to another agent of the channel (the same model first, when you allow
  it), or stops it and says so. It never touches a task that you stopped. It uses the tries of
  Resume by itself, so a task cannot loop. Set when a task counts as stopped (15 minutes with no
  sign by default). For a task that is only slow, it can ask the model of the Guard, with a short
  summary that has secrets masked; with no model, its local rules decide. Its actions show in
  "Lately", and a run with no sign shows its minutes.
