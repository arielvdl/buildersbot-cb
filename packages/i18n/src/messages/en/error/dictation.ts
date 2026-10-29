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
});
