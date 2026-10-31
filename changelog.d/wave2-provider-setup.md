### Changed

- The provider step of a server shows Builders first, marked "Recommended", then the accounts that
  are connected. Builders is the choice while no other provider is connected. A provider whose CLI is
  too old is now in "More providers", with one short line on its row. The key providers that wait for
  a newer Pi share one notice with one "Update Pi" button. The text under the title now says that
  Builders is free.
- When Builders is not installed, setup suggests it, installs it with its progress, and offers a
  retry with the reason when the install fails.
- First run and the server step use the same label for the main button.

### Fixed

- The Cultura Builder row no longer shows a "Sign in" button that did nothing, in setup and in
  Settings. Its Connect is the Cultura Builder sign-in. On a joined server, whose host has its own
  Cultura Builder sign-in, the row is in "More providers" and says to sign in on the computer that
  runs the server.
