### Fixed

- A server on this computer no longer shows as a second Builders Bot in the low-memory panel of
  macOS. It ran as a hidden app with the footprint of the whole app, so the panel listed two Builders
  Bot entries with the same size.
- On a Mac, new agent turns now wait, and idle agent processes close, when macOS itself reports
  memory pressure. Before, the memory reading counted only the "free" percentage, which stayed near
  40% while macOS ran out of memory and asked the person to close apps.
