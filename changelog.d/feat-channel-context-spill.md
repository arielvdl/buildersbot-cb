### Added

- The switch "Shorter channel context" in Settings > General > Advanced optimizations (beta) now
  works. With it on, an agent in a channel gets in full only the messages that its request needs, up
  to 4,000 characters each: the request, the message it replies to, messages that mention the agent,
  results of its subtasks and the last 2 messages. Other long messages come shortened, with their
  size and a pointer that the agent uses to read the rest. A cut does not end inside a code block.
  The next request in the same session leaves out the channel rules, details and memories when they
  did not change. Off, which is the default, channels work as before.
- Agents can read one channel message by its id, in parts of 12,000 characters, and a short page of
  up to 20 messages with a preview of each one.
