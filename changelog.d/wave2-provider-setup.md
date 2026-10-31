### Changed

- The provider step of a server shows Builders first, marked "Recommended", then the accounts that
  are connected. Builders is the choice while no other provider is connected, and an account that
  connects while the step is open takes its place, unless the user chose a row. A provider whose CLI
  is too old is now in "More providers", with one short line on its row when the row can download or
  update it. Pi and the key providers that run in it are rows only when they are connected or chosen.
  The key providers that wait for a newer Pi share one notice with one "Update Pi" button. The text
  under the title now says that Builders is free.
- When Builders is not installed and another row is selected, setup suggests it, installs it with its
  progress, and offers a retry with the reason when the install fails. With Builders selected, the
  main button downloads it.
- First run and the server step use the same label for the main button.

### Fixed

- The Cultura Builder row no longer shows a "Sign in" button that did nothing, in setup and in
  Settings. Its Connect is the Cultura Builder sign-in.
- On a joined server whose host has no Cultura Builder sign-in, the row is in "More providers" and
  says that Cultura Builder does not connect through a remote server yet. Its main button selects
  another provider. Another problem of the host keeps the host's own message.
- The Cultura Builder row no longer asks for a new sign-in each time the access token expires. The
  provider check now refreshes and saves the token before it starts the provider, as a turn does.
- A Cultura Builder with no sign-in, a refused refresh token, or a refused token now shows "Not
  connected" and Connect, not "Unavailable", and none of them counts as a failed start. An account
  without access to the LLM says so. The Cultura Builder messages are translated.
