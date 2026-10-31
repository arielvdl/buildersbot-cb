### Fixed

- Dictation with ElevenLabs no longer acts as if no API key is saved when the saved key cannot be
  read, for example after the keychain changed or after a profile was copied from OpenBot. Settings
  > Voice says that the key cannot be read, and gives Use Parakeet (local) and Remove unreadable key.
  Before, the app asked for a key and the microphone was never asked for.
- The dictation of the global shortcut shows the real reason when it fails, such as a missing or
  unreadable API key. Before, it always showed the same general failure.
- When macOS refuses the microphone, the message under the message field has an Open System Settings
  button that opens Privacy & Security > Microphone.
- Read aloud stays in the menu of a reply when the voice is not downloaded. It tells you to download
  the voice and gives the download, with its size. Before, the item was not shown and nothing told why.

### Changed

- The text of Settings > Voice > Read replies aloud says that only the reply to a dictated message is
  read by itself, and that Read aloud in the menu of a reply reads any reply. Without the voice, it
  gives the download size.
- The macOS microphone prompt says that commands that agents run from Builders Bot can also use the
  microphone, and that the audio stays on the Mac unless you choose a cloud voice model.
