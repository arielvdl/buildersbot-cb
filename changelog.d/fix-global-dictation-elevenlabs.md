### Fixed

- Dictation from the global key combination now works when ElevenLabs Scribe is the voice model.
  Before, each dictation failed with "Builders Bot could not transcribe the dictation", because the
  recording was sent as one file, and the ElevenLabs model takes only a stream. The recording now
  goes through a stream, as it does in the message box. A model on this computer and your own voice
  server still get the whole recording.
