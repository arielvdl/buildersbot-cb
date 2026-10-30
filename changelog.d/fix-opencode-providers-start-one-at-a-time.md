### Fixed

- Cultura Builder no longer fails to start with "stopped before it answered (exit code 1)". The
  OpenCode providers share one CLI and one SQLite database, and started together they locked each
  other out. They now start one at a time, and a start that dies at once is tried again.
