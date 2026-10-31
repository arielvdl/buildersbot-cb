import { defineMessages } from "../../../message";

export const messages = defineMessages("error.dictation", {
  // The dictation of the global combination.
  "error.dictation.microphone": "Builders Bot could not open the microphone.",
  "error.dictation.noWindow": "Open the Builders Bot window first, so it can use the microphone.",
  "error.dictation.empty": "Nothing was heard. Try again.",
  "error.dictation.tooLong": "The dictation is too long.",
  "error.dictation.failed": "Builders Bot could not transcribe the dictation.",
  "error.dictation.paste": "The transcript is on the clipboard. Press the paste key in the app.",
  "error.dictation.pastePermission":
    "The transcript is on the clipboard. Allow Builders Bot in System Settings → Privacy → Accessibility to paste it, or press the paste key.",
  "error.dictation.shortcutTaken": "Another app already uses that combination.",
  // The speech recognition of the operating system.
  "error.dictation.system.platform":
    "This system has no speech recognition. The dictation uses the voice model instead.",
  "error.dictation.system.missing":
    "The system speech recognition is not installed. On macOS, turn on Dictation in System Settings → Keyboard; on Windows, add the language pack of the language.",
  "error.dictation.system.language":
    "The system does not recognize this language. Add it in the system settings, or choose another language in Voice.",
  "error.dictation.system.permission":
    "Builders Bot may not use speech recognition. Allow it in System Settings → Privacy → Speech Recognition, or use the voice model.",
});
