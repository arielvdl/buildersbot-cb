### Fixed

- Dictation with ElevenLabs no longer acts as if no API key is saved when the saved key cannot be
  read, for example after the keychain changed or after a profile was copied from OpenBot.
  Settings > Voice says that the key cannot be read, and gives Use Parakeet (local) and Remove
  unreadable key. Before, the app asked for a key and the microphone was never asked for.
- The dictation of the global shortcut shows the real reason when it fails, such as a missing or
  unreadable API key. Before, it always showed the same general failure.
- When macOS refuses the microphone, the message under the message field has an Open System Settings
  button that opens Privacy & Security > Microphone.
- When the saved key of your own voice server cannot be read, Settings > Voice and the voice server
  dialog say so, and a refused request says that the saved key cannot be read. Before, the app
  showed no key and the server answered that it refused the key. A save without a new key keeps the
  file, and a server that needs no key still works.
- On macOS, dictation reads the microphone permission before it downloads a model. macOS asks for
  the microphone at once, and a refused or blocked microphone shows its own message, also in the
  dictation of the global shortcut. On Windows, dictation opens the microphone as before, and a
  refusal has Open Windows Settings.
- Read aloud stays in the right-click menu of a reply when the voice is not downloaded. It tells you
  to download the voice and gives the download, with its size. Before, the item was not shown and
  nothing told why. The action bar of a reply shows no Read aloud button without the voice, as before.
  A build with no speech runtime does not offer the download, because the download does not repair it.

### Added

- Settings > Voice shows the microphone permission of macOS or Windows: allowed, not allowed,
  blocked by the administrator, or (on macOS) not asked yet. On macOS it gives Ask for access, Open
  System Settings and Restart Builders Bot; on Windows it gives Open Windows Settings. It says that
  commands that agents run can also use the microphone.

- Settings > General warns when Builders Bot cannot decrypt saved data on this computer, which
  happens when the keychain changes or a profile is copied from another app. It lists the ElevenLabs
  key, the voice server key, custom agent values, custom provider credentials, provider API keys,
  messaging tokens and the network egress proxy that cannot be read, with the file name and what to
  do for each.

### Changed

- The text of Settings > Voice > Read replies aloud says that only the reply to a dictated message is
  read by itself, and that Read aloud in the menu of a reply reads any reply. Without the voice, it
  gives the download size.
- The macOS microphone prompt says that commands that agents run from Builders Bot can also use the
  microphone, and that the audio stays on the Mac unless you choose a cloud voice model or your own
  voice server.
- The system dictation of macOS recognizes on the Mac only. Before, when the on-device pass failed
  or the language had no on-device recognition, it sent the audio to the speech server of Apple. Now
  such a language uses the voice model when the dictation engine is Automatic, and says that the
  system cannot recognize it when the engine is System.
