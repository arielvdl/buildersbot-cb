# Sounds

Every sound of the desktop app is an event of one registry, and plays through one port. The person
finds, changes and silences each sound in Settings › Notifications › Sounds.

## The registry

`packages/contracts/src/ipc-sounds.ts` (`SOUND_EVENTS`) lists each sound event with its group, its
kind, the sounds that can be chosen and its default. The groups are Agents, Approvals and questions,
Guard, Task reviewer, Tasks and routines, Messages, Voice, Interface, System and Remote.

| Event | Kind | When it plays | Default |
| --- | --- | --- | --- |
| `agent.reply-finished` | app | A turn that the person started in the agent's own chat ends (`completion-sound.ts`). | Classic sweep, on |
| `agent.work-finished` | app | A turn ends in a channel, task or side thread, or a teammate started it. This includes the tasks that the task reviewer and Resume by itself start again. | Classic sweep, on |
| `routine.finished` | app | A routine run posts a result. A quiet run plays nothing. | Classic sweep, on |
| `agent.run-failed` | app | A run that the person started fails (`agent-event-sounds.ts`). | Theme cue, off |
| `approval.waiting` | app | A question, an approval or a browser takeover waits. | Theme cue, off |
| `guard.question` | app | A question of the Guard (`approval.guard`) waits. The siren of the Guard is a picture and plays nothing. | Theme cue, off |
| `voice.limit-warning`, `voice.limit-stop` | app | A dictation reaches its time limit (`voice-store.ts`). They also play while the person dictates. | Classic tones, on |
| `interface.controls` | app | The `data-cuelume-*` cues of shared controls: clicks, menus, switches, typing. Theme only. | Off |
| `interface.actions` | app | The result of an action: `actionToast`, attachment import, a message that did not send, a server shortcut. | Off |
| `notification.agent`, `notification.channel-reply`, `notification.workflow`, `notification.usage-limit`, `notification.machine-alert`, `notification.system` | native | A macOS notification (`renderer-forwarders.ts`, the welcome, test and lid-closed notifications). | macOS default sound, on |
| `voice.read-aloud` | speech | A voice reads a reply. The Voice page turns it on or off. | — |
| `task-reviewer.resumed-work`, `remote.phone` | info | No sound of their own. The row says which sound plays, or where to change it. | — |

The defaults are the sounds of the versions before the sound center: the task sound was on with the
classic tone, and the action sounds ("Sound feedback") were off.

## The ports

- Renderer: `src/renderer/src/sound-center.ts`. `playSound(eventId, { who, cue })` reads the event's
  switch, sound and volume, "Mute all", and whether the person dictates or talks with an agent
  (`setSoundsQuietFor`). It plays a classic tone, a cuelume theme cue, the system alert sound (main
  calls `shell.beep()`), or a custom file. Each play, and each sound that it keeps quiet, goes to
  Recent sounds with the agent or server that caused it, never the text of a message.
- Main: `src/main/sound-port.ts`. `appNotification(eventId, ...)` makes each macOS notification, with
  `silent: true` when the event is off or everything is muted, or a named sound of
  `/System/Library/Sounds`. macOS can still keep it quiet (the sound switch of the app in System
  Settings › Notifications, and Focus). The section shows this as "Managed by macOS" with a button
  to that page.

`scripts/sound-port-guard.ts` fails when code in `src/` or `packages/` makes a sound outside the two
ports (`new Audio`, `AudioContext`, `cuelume`, `speechSynthesis`, `afplay`, `say`, `shell.beep`,
`<audio>`, `new Notification`). Its allow list names the files that read the microphone, decode a
recording or read a reply aloud. The `Sound port guard` workflow runs it on each pull request and
push. `tools/sound-port/fixtures/` holds the stray and clean examples that it checks itself with.

## Preference and sync

On desktop, main keeps the preference in `openbot-sound-preference-v1.json` (`SoundPreferenceStore`),
holds Recent sounds in memory (the newest 20), and sends each change to every window
(`notifications.soundsChanged`). A file that a newer version wrote still reads: an event or a sound
that this version does not know is dropped.

When no file is saved yet, the first window moves the choices of the older versions in: the task
sound (`openbot:task-sound`, `openbot:completion-sound-enabled`) becomes the sound of the three
"finished" events, and the action sounds (`openbot:action-sounds-enabled`, `openbot:action-sounds-theme`)
become the theme and the switch of the cue events. Each later change writes those keys again from
"Reply to you finished" and "Control sounds", so an older version keeps the main choices after a
downgrade.

The web client has no main process. It keeps the preference in this browser
(`openbot:sounds:v1`) and Recent sounds in the page, and its Preferences menus write through the same
sound center. It has no system sound and no custom files. The iPhone app keeps its own notification
sound.

## Custom sound files

"Add a sound file…" opens a file dialog in main. Main accepts MP3, WAV, M4A, OGG and AIFF up to 2 MB,
checks that the first bytes match the type, and copies the file to `sounds/<uuid>.<ext>` in the app
folder. The renderer never reads the chosen path: it asks for the bytes of the copy by its id
(`notifications.readCustomSound`), and main reads only ids of its own list. A custom sound is
normalized so that its peak is never louder than the built-in sounds. Main keeps 12 files at most
and removes the oldest one that no event uses. A macOS notification cannot play a custom file.

## Checks

- `bun scripts/sound-port-guard.ts`
- `bun scripts/sound-center-e2e.ts --storybook=<url> [--browser-executable=<path>]` checks the main
  store and port, the custom file rules, and the Sounds section in the `Settings/Sounds` story.
