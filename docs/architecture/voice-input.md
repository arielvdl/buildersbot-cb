# Voice input

Dictation turns a recording into text at the caret of another app, or on the clipboard. It has two
parts that are easy to confuse:

- **The recording** is the window's, through `MediaRecorder`. Main never holds a microphone.
- **The engine** reads the finished recording. It is a preference of this computer.

The global combination (`DictationService`, `voice:dictation-*`) owns the second press, the overlay
phase and the paste. `global-dictation.ts` records and asks for a transcript. The composer's mic is a
different path: it keeps the voice model because it shows text while you speak.

## The composer microphone

The microphone beside Send records for the draft of the open chat: an agent's chat, a side thread,
or the open tab of a channel. `createVoiceStore` (`stores/voice-store.ts`) reads the target with
`currentConversationTarget`, the same one that keys the draft, and keeps it while it records
(`voiceAgentId`, `voiceServerId`, `voiceTabId`). So the text goes to the chat or the tab where the
recording started, also when the reader opens another one before it ends.

- **Stop** puts the transcript at the end of that draft. The user then sends it.
- **Send while recording** stops, transcribes, and sends the draft with the transcript through the
  normal send of that chat. In a channel that is the channel `send` command, so the opening mention
  and the routing of the channel apply as for a typed message, and the message goes to the tab of
  the recording.
- **Cancel** discards the recording. The draft stays as it was.

Only an agent's own chat reads the reply aloud (`noteDictatedMessage`). A channel has many speakers,
so a message dictated there gets no spoken reply. The web client (`props.runtime`) has no microphone.
`scripts/channel-voice-input-e2e.ts` checks the channel and the agent composer in the stories.

## The engines

`DictationPreference.engine` is `auto`, `system` or `voice`.

| Engine   | What reads it                        | Needs                            | Live text |
| -------- | ------------------------------------ | -------------------------------- | --------- |
| `system` | macOS Speech / Windows `System.Speech` | a language pack and permission   | no        |
| `voice`  | the model of the Voice settings      | a download or an API key         | yes       |
| `auto`   | `system` when it can run, else `voice` | as above                       | only with `voice` |

`auto` is the default. A person who wants the private, zero-download path chooses `system`; one who
wants the preview while speaking chooses `voice`.

### Why the system engine first

- Nothing to download, and the audio does not leave the computer: macOS recognizes on device only.
- The same key works in every app, which is the point of a global combination.
- It is the only engine that is already installed on both target systems.

The costs are real and are why it is not the only engine: macOS needs **Dictation** on in
System Settings → Keyboard, the first use asks for Speech Recognition, and Windows needs the language
pack of the language. `OsDictationService.status()` reports each of those, the settings row shows it,
and `auto` moves to the model when the system cannot work.

### macOS

`resources/os-speech/darwin/os-speech.swift` is compiled by `scripts/build-os-speech.ts` into a tiny
background application (`LSUIElement`), `.openbot-build/voice/os-speech/darwin/Builders Bot
Dictation.app`, carried by `extraResources`.

It is an application and not a plain binary because the speech permission belongs to a bundle. Main
opens it with `open -g -W -n … --args --language … --file … --out … --err …`; a plain child of
Electron aborts inside TCC even with the app's own `Info.plist` key. The helper requests
`SFSpeechRecognizer` authorization and recognizes **on device only** (`requiresOnDeviceRecognition`).
It never uses the speech server of Apple, so the audio stays on the Mac, as
`NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` say. A language without its
on-device asset answers `language`, and a failed pass answers `recognize`; in both cases `auto` moves
to the voice model. It writes the transcript to the `--out` file, and a
failure to the `--err` file as `code: message` (`permission`, `language`, `empty`, `recognize`); main
maps the category to a catalog key. An app that writes neither file reads as `missing`.

The prompt names "Builders Bot system dictation", the helper's own name, on the first dictation. A
denied permission is reported; `auto` falls back to the model.

### Windows

`os-dictation-windows-script.ts` is a PowerShell text that main passes with `-Command`, after the
`$File` and `$Language` assignments. It lists `SpeechRecognitionEngine.InstalledRecognizers()`, picks
the exact culture, then the two-letter one, and reads the WAV with a `DictationGrammar`. No build step
and no file to package.

Windows has no per-app speech permission. The recognizers come from the installed language packs, so
a language with no pack answers `language`; `-Check` counts them for the status row.

### Linux

No system engine. The status says `error.dictation.system.platform` and `auto` uses the model.

## The provider of the selected model

The Cultura Builder gateway is OpenAI-compatible for chat, but it has **no audio route**: a POST to
`/api/builder-ai/gateway/v1/audio/transcriptions` answers 404, and the chat models do not accept
`input_audio` (the gateway forwards it and the model refuses it). So "transcribe with the selected
model" cannot be the default yet.

When the gateway ships `POST /audio/transcriptions` (multipart `file`, `model`), the provider engine
is a small addition: resolve the preferred provider and model from the setup store, call the
gateway with the same bearer token the Guard already uses, and add `cultura-builder` to the
supported set. Until then the engine choice is about the system and the voice model, and the
provider path belongs beside them rather than in front of them.

## The clipboard and the paste

`DictationService.finish` writes the transcript to the clipboard and, in `paste` mode, sends the
paste keystroke of the platform (AppleScript, `WScript.Shell`, `xdotool`). The previous clipboard
comes back after 600 ms, and only while the text is still ours. `copy` mode stops at the clipboard,
which is the reliable choice when the focused app refuses a synthetic keystroke.

## Rules that are easy to break

- `auto` must never fail a dictation: a system failure falls back to the model. An explicit `system`
  reports the reason.
- The recording stays in the renderer. Main gets a 16 kHz mono PCM WAV.
- The engine is read when the recording starts, so a settings change applies to the next press.
- A model that streams (ElevenLabs) is only used with `engine: "voice"`; `system` and `auto` always
  send a whole recording.
- `DictationPreference` files written before the engine existed must read with `engine: "auto"`,
  not fall back to the default and turn the feature off.
- `bun scripts/build-os-speech.ts` is part of `voice:prepare-runtime`; a package built without it has
  no macOS system engine, and the status says `missing`.
