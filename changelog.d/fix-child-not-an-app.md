### Fixed

- On macOS, a server on this computer no longer shows as a second "Builders Bot" in the Force Quit
  and low-memory panels. Each process of the app now starts as a UI element. The app then becomes a
  normal app with a Dock tile, and a server on this computer becomes background-only. Before, each
  start of a server while such a panel was open added an entry with the memory of the whole app.
