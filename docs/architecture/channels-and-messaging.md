# Channels, messaging, and mobile

## iPhone Live Activity updates

The phone and a host build the same Live Activity view with `@openbot/team-client`:
`dynamic-island-coordinator.ts` gives the state, and `live-activity-props.ts` turns it into the props
that the widget shows. While the app runs, `use-live-activity.ts` publishes them itself.

iOS stops the app and its connections in the background. So the phone registers the push token of
its activity with the active host (`live-activity-push-v1`, `POST /v1/live-activity/registration`),
with `away: true` when it leaves the foreground. `LiveActivityPushService` in `src/main` keeps the
registration in memory for that session. While the phone is away, each agent event (at most once a
second) reads the runtime snapshot of the agents the member can see and the member's read state,
builds the props, and sends a change. A change of state has priority 10; a change inside a state
waits 5 seconds and has priority 5. An unchanged state is sent again every 10 minutes, so its stale
date moves on; a host that sleeps stops this, and the view then shows that it is out of date. An idle
state ends the activity.

`live-activity-seal.ts` seals the props with keys derived from a secret that the phone makes for
that host (an HMAC of the phone secret and the server ID). The
host sends the sealed text to `POST /v2/remote/hosts/:hostId/live-activity` with its machine
credential. The Worker checks the credential and a per-host rate limit, makes the APNs payload and
provider token itself, and forwards the request. It stores and logs nothing. The widget cannot load a
library, so the phone composes its layout with the two widget keys and the App Group folder, and
`live-activity-open.ts` opens the sealed props with its own SHA-256. Button links that change host
state carry an HMAC signature, which the app checks with the key of the host that the action goes
to, so one host cannot sign an action for another.

## iPhone notifications

A host sends an iOS notification when an agent finishes a turn, stops with an error, cannot start a
message or a routine run (`error` with the code `delivery_start_failed`), or waits for input, an
approval, or a step in the browser (`browser-takeover-requested`, also for a password or a code).
The desktop and the web client notify about the same events (`agentEventCanNotify`), and all three
decide as one: `notificationForAgentEvent` in `@openbot/team-client` applies the level of the server
(`all`, or `needs-me` for the events that wait for the user), the switch of the agent, and the quiet
routine runs. The desktop and the web client close the notification of a request when an
`agent-input-resolved` or `browser-takeover-resolved` event comes, also for an answer from another
device. The title is the agent name. When the phone shows previews, the text is the
preview of a desktop notification: the start of the answer of that turn, the question, or the action
to approve, with secrets redacted. Otherwise it is the fixed desktop text, such as "Finished working.".

Channels are an exception. The desktop and the web client notify an agent reply in a channel from
the channel list (`channelReplyNotifications`), because the channel service consumes the
`turn-completed` event of a channel thread. On a host with `channel-attention-v1`, each summary names
the author and status of its newest message, the thread of each member, and `openTasks`: its
queued, waiting and running tasks. The released `activeTasks` counts only running tasks, so it is 0
while a task waits for the tasks it passed on. A reply notifies once, when the work of the channel
ends (its newest message is an agent's and stopped streaming, and `openTasks` is 0), while the
channel has unread messages. Work that writes many messages, asks a question on the way, or passes
parts to other agents thus notifies once, at its end. The desktop reads the agent list for a
notification only when a reply is new, and it reads no channel list for a server whose replies
cannot notify. The title of a prompt, an approval or
a takeover on a channel thread names the agent and the channel (`notification.channelTitle`), and a
click opens the channel. The phone gets no channel reply notification. For a phone that sends
`channel-attention-v1`, the host names the channel in the title of a prompt, an approval or a
takeover on a channel thread (`PushNotificationService` reads `HostService.channelForThread`), and a
tap opens the channel. An older phone gets the agent name as the title, as before.

The phone registers with every connected server that supports `push-notifications-v1`
(`POST /v1/push-notifications/registration`): the APNs token of the app, the secret of that host (the
same one as for the Live Activity), the language, the level, a mute end, the preview switch, the sound
(`none` when Play sound is off), the start of its Live Activity of that host, and `away`. One sound is for notifications and the Live Activity. With
notifications off, Live Activities on and Play sound on, it registers with no token: the host then
sends no notification, and uses the registration only to make the Live Activity play the sound. It
tells each host again after each connection and when a choice changes, and removes the registration
when nothing is left for that host or the user signs out. A level of
"Nothing" and a mute with no end remove it too. `PushNotificationService` in `src/main` keeps the
registrations in `openbot-push-notifications-v1.json` in the user data folder, readable only by the
user, so a phone that does not connect after the host restarts still gets notifications. It sends
only while the phone is away or its connection is closed. No event goes while the member uses a
desktop app, which shows the event and asks for input, an approval, or a browser step itself: that
computer had input in the last 30 seconds (`powerMonitor.getSystemIdleState`), and
the window of the host's own desktop app has focus or shows the event as a desktop notification, for
the owner (`desktopShowsAgentEvent`: desktop notifications on, and the mute and the level of this
computer's server let the event through); or the member sent, answered, or typed from another session in the last 30
seconds (`TeamApiServer.lastMemberUseElsewhere`, kept in memory). The time is short because a task
can end at any time after the member leaves the computer. While the phone shows a Live Activity of
this host that iOS still updates (8 hours from its start, which the phone gives because a host that
restarted does not know it), the host sends no notification
(`LiveActivityPushService.showsEvent`). With a sound (Settings > Notifications > Sound), the next
update of the activity alerts at once, so iOS lights up the screen, shows the activity, and plays
that sound; with Play sound off, the activity updates silently. iOS does not tell the host when
the user removes the activity, so until the app runs again such an event shows nowhere.

`push-notification-seal.ts` seals the notification with keys of their own, made from the host secret.
The host sends it to `POST /v2/remote/hosts/:hostId/notification` with its machine credential and the
account session of the phone. The Worker checks the credential and a per-host rate limit, and sends
nothing for a session that has ended, a revoked membership, or a signed-out device, because the host
does not learn about these. It makes the APNs alert itself, with "OpenBot" as the only text,
`mutable-content`, the sound, and the sealed bytes. It stores and logs nothing. A `410` answer, from
the Worker or Apple, removes the registration.

The Notification Service Extension of the app (`apps/mobile/plugins/with-notification-service.js`,
`NotificationService.swift`) opens the seal with the keys that the app writes into the App Group
file `push-notifications.json`, and shows the agent name and the text. It refuses content that names
another server than the one whose keys open it. A notification that it cannot open keeps the app
name only. A tap opens the chat of the agent.

## Android notifications

An Android phone gets the same notifications in the same conditions, through Firebase Cloud
Messaging. Android has no Live Activity, so the host does not check one. The phone registers with
every connected server that supports `push-notifications-android-v1`
(`POST /v1/push-notifications/android-registration`): the Firebase token of the app, the secret of
that host, the language, the level, a mute end, the preview switch, and the sound. A registration
always has a token. `PushNotificationService` keeps it in the same file, as an entry with
`platform: "android"`; a host from before this capability drops such an entry when it reads the file.

The host sends the sealed notification to `POST /v2/remote/hosts/:hostId/android-notification`. The
Worker checks the credential, the notification limit of the host and the session, as for an iPhone.
It signs an OAuth token with the Firebase service account key (`FCM_SERVICE_ACCOUNT`) and sends a
high-priority data message with `sealed` and, unless the notification is silent, `sound`. It stores
and logs nothing. Firebase answers `UNREGISTERED` or `SENDER_ID_MISMATCH` for a token that no longer
reaches the app, and the Worker answers `410`, which removes the registration.

`OpenBotMessagingService.kt` (`apps/mobile/modules/android-notifications`) gets the message, also
while the app does not run. It opens the seal with the keys that the app writes into
`push-notifications.json` in its files folder, and gives the notification to `expo-notifications`,
so a tap reaches the app as on iOS. Android plays the sound of the notification channel, so the app
makes one channel for each sound (`android-notification-channels.ts`), and the service picks the
channel of the sound in the message.

Notifications only inform; they have no buttons on either platform. An answer from a button would
have to reach the computer over the WebRTC connection of the app, which Android does not let a
closed or frozen app build: React Native stops its timers and its view updates in the background,
and the web view that holds the connection does not connect again after Android froze the app.

## Shared channel chats

Channels are separate from sidebar sections. A channel has one host, a purpose, participating agents,
a selected lead, and linked agent conversations. Agent membership selects who can receive work.
It does not restrict human access: each authenticated server member can read and use its channels.
The Electron app provides the channel interface. A creation dialog provides member search and optional
coordination settings. The chat shows each author and keeps settings in a side panel. Channels use the sidebar
context menu for management and have no Pause or Resume controls. The mobile app has its own channel
interface (see below).

`ChannelStore` stores the canonical transcript, channel configuration, tasks, assignments, summaries,
execution threads, and human read positions in SQLite. Migration 18 adds these projections without
changing existing agent data. Channel commands use the orchestration log and command receipts.
Messages have stable IDs and per-channel sequences. A channel projection can be rebuilt from its events.
Archiving stops channel work and retains its records. Restore makes the chat available for new messages again. Neither action removes agents or linked conversations. The sidebar calls archiving "Delete". On desktop and web, the row menu in Deleted channels restores a channel; it shows to the people who can delete one.

Each channel-agent pair has a separate execution thread in `projection_threads`. The normal agent
thread is never replaced. Provider sessions, turns, questions, approvals, attachments, compaction,
and restart recovery use the explicit execution thread. These internal execution records do not
create extra navigation entries. The per-agent drain scheduler remains the authority for work.

`ChannelService` selects one owner. A selected recipient has priority, followed by the task attached
to a reply, a reply to a member message that has no task, a clear follow-up to the sole open task,
and a channel with one available member. These selections use no model. Other requests use the
lead's provider, model, and reasoning setting in a separate session with no work tools. The request
supplies the accepted result schema and the channel summary in place of the transcript. Invalid or
stale routing cannot broadcast a request. Routing can select an existing task, ask a question, or
indicate that no work is needed. A selected owner or existing task adds one channel message from the
lead, so the selection is visible and the user can correct it. Deterministic selection adds no
message. A request that needs routing in a channel with no lead stops with the reason
`channelLeadRequired`. A save that sets a new lead queues these requests again, and the lead routes
them. A lead change does not move a task that already has an owner. The member packet names the lead
(`leadAgentId`).

Channel tools retrieve history, assign a child task, transfer ownership, and report results. The
runtime supplies channel and caller identity. A child keeps its parent owner; a transfer changes it.
Only assignments and awaited results start turns. Completed child results are combined before the
owner returns. The limit is eight automatic assignments per root request and two active assignments
per channel (`CHANNEL_PARALLEL_LIMIT`).

A member can also change its channel when a person asks: `channel_add_member`,
`channel_remove_member`, `channel_set_instructions`, and `channel_list_routines`,
`channel_create_routine`, `channel_update_routine`, `channel_delete_routine` for the schedule
routines. They act only on the channel of the running task (`channel-management.ts`). The request
message of the root task must have a person as author. A routine run (author id `routine:<id>`)
and a request that only an agent wrote are refused, so untrusted run input cannot change the
channel. A member change is a `save` through the command queue, with the draft read from the stored
channel when its turn comes. The caller cannot remove itself or an owner of a task above its own,
and removing the lead clears the lead. An agent that a person adds must be one that person can chat
with, and one they remove must be one they can see: main answers `personAgentLevel` with the level
their own Team API save has (`HostService.channelPersonAgentLevel`). For a team member's request,
the routine tools do not list, make or change a one-time routine, which the Team API does not carry
(`HostService.channelPersonIsRemote`). A retried call finds the
receipt of its change and changes nothing again. Each change
writes a `channel-change` note in the same commit, with the agent as author and a source text that
names the agent, the change and the person. Clients show it as an activity row, and it is not
unread and not in the model packet.

Channel work holds only the agent that does it. An agent runs one main-lane turn at a time: its chat,
a channel delivery or a messaging delivery. While the agent has an active assignment,
`ChannelService.mayDrain` holds its other main-lane requests. The work of other agents does not hold
it. The tasks of the agent run beside the channel turn within the agent task limit, and a channel
turn takes no task slot. When the provider of the agent runs one turn at a time (`concurrentTurns:
false`), its task turns count as busy. Only declared `browser` and `workspace:<path>` resources are
serialized: the same browser, or two workspaces where one path contains the other. An empty list,
`none`, and `host` (from an earlier version) reserve nothing. An assignment keeps the resources it
started with until it ends, and a task with an active assignment starts no second owner. An update
still waits for channel work on all of the host (`hasActiveWork`). These controls do not restrict
provider process privileges.

A channel turn can use `ask_ui`, the plan card (`acknowledge_request`) and `html_render`. The
question, the card and the visual reply are copied into the channel, so each member who reads the
channel sees them and can answer. Screen capture in a channel turn always asks, also with Full
access, and the reason names the channel (`status.agent.screenCaptureChannel`). Messaging links
still refuse these tools. `history_search`, `history_read` and `start_task` stay refused in a
channel turn; `channel_history` gives the channel history.

A hidden lead does not route. When the user hides an agent, `ChannelService.releaseAgent` gives its
queued and starting assignments back to the channel. The task keeps its owner and gets a new
revision, so the work continues after restore or after a reassign. When an agent that owns waiting
channel work (`ownsWaitingWork`) reaches its usage limit, the agent moves to its backup model as for
its own chat. The model-switch marker shows in the agent chat and in each affected channel.

A one-time routine of a channel stays on this computer. The released Team API channel codec does
not accept its schedule, so desktop IPC allows it only on the local host.

Each turn receives bounded channel context: purpose, responsibilities, the current request, source
messages and replies, shared decisions, recent messages, and attachment references. A versioned
summary covers older messages, with a sequence and source IDs. Full messages remain retrievable.
The provider acceptance cursor records context delivery. Context packets remain self-contained so
provider replacement or compaction does not remove shared decisions. Unrelated server conversations
are available through paginated retrieval and are not inserted automatically. Agent memories keep
their existing meaning.

Task revisions prevent an old assignment from completing a corrected request. The stored request
keeps its own text and files: only its first dispatch converts the attachment drafts, and a later
dispatch of the same request sends the stored copies again. Stop pauses a task and its descendants
and interrupts active work. Reassign waits for the old assignment to finish stopping. Restart
recovery checks accepted provider work before retrying. Unknown outcomes require attention.
Command, assignment, and result IDs prevent duplicate dispatch and visible results; external side
effects do not have an exactly-once guarantee.

Desktop IPC and remote desktop transports expose `channel-chats-v1` as an optional capability with
separate payload codecs. Released Team API adapters keep their existing meaning. A host advertises
the capability only when its channel service is connected. When a host does not advertise
`channel-chats-v1`, the renderer hides the channel controls in the sidebar, search and schedule. The account API and Signal service add no channel storage or routing.

Mobile shows channels only on a host that advertises `channel-chats-v1`, and Delete and Restore only
with `channel-delete-v1`. It uses the same host channel IDs and commands. The host database stores
channel settings, members, messages, memories, routines, and read positions. Mobile keeps only an
in-memory view. Reconnect loads the host list again. `channels-changed` events refresh the list and
open channel history, with one request sequence per host and one pending refresh for an event burst.
Closing a channel retains a short message window (up to 50 messages), as single chats do,
and releases larger windows. Only open channels refresh their history. Server removal discards its cached channels and late
responses. The mobile chat list and message history use virtualized lists. Channel member selection
uses static avatar thumbnails without activity subscriptions or animation timers. Channels appear
next to agents in the same list, with up to four static member avatars that fade when the host
is offline. Channel pins share the existing pinned grid and 16-chat limit; local preferences
preserve agent pins and channel pins separately. Hide removes a channel from the home list and
unpins it; the shared Hidden chats sheet restores it. Channel and agent pinning use the same
measured overlay movement, with static folder artwork for channels. Agent and channel screens
use the same mobile `ChatView`, header, message list, reply gestures, composer, camera, and keyboard
motion. Their data adapters provide history, sending, and read positions; channels also provide
author labels and task actions. Channel send retries keep their operation ID and uploaded files.
A channel message shows plan cards and `ask_ui` questions as an agent chat does; it has no reactions,
because the reaction route is an agent route. A channel send is done when the host accepts its
operation: the host stores a repeated operation once. The send then reads the history of an open
channel, so the host's row replaces the phone's own; a failed read is not a failed send, and a closed
channel reads its history when it opens. A channel message that an app before channels came back
kept aside in `messages.unreadable-<time>.json` stays there.

On a host with `channel-attention-v1`, each channel summary names the threads of its members. The
channel then shows the approvals and browser steps of those threads, and the agent's own chat does
not. An older host gives no threads: the channel shows the approvals of the members that run one of
its tasks, as before. A member with a request in the channel shows as waiting there, with the reason
of the request. The agent's own chat does not show a turn of another thread (the activity keeps the
`threadId` of its events); for a channel thread, a card under the chat names the channel and opens it. Its home row says that it waits
in that channel in place of its last message (`useWaitingChannel`).
The channel header always has the browser button. It opens the browser of the member that asks for
a browser step, else of the lead, else of the first member. In a channel with more than one member,
the agent in the browser header is a glass button with a menu that switches to the browser of any
member. The Deleted channels sheet restores a channel (`restore`) for the people who
can delete one. The phone has no local notifications of channel replies: a host sends a notification
only while the phone is away (see iPhone notifications). A tap on a notification whose thread is a
channel thread opens the channel, when the phone has the channel list of that server.

Mobile channel settings use one native sheet with a nested stack for memories and routines. The
memory and routine editors share their controls with agent settings and use channel API operations.
Channel settings have no provider or model controls because each member retains its own runtime.
No account API, Signal, IPC contract, or database migration changes are required for mobile channels.

## One channel at a time

When this mode is on, only one channel starts work, so the agents of many channels do not use memory
together. The other channels wait. When no channel works, the next one starts: first in the order
that the user chose, then the channel that waited longest. The mode is off by default. The lane
controls only the channel pump (`ChannelService.wake`). A direct chat with an agent does not wait for
it.

- A channel is busy when its pump runs or it has an active assignment. The service calculates this
  each time and does not store it, so a restart loses no work. The wait order, the Run now choices
  and the stall marks are only in memory.
- Work that runs is never stopped. A busy channel is always admitted, because its next task needs its
  pump. A change of the mode or the order changes only which channel starts next. When the mode goes
  off, all waiting channels start.
- A queued task that its owner, a spent plan or a dependency holds back does not count, so a channel
  that cannot start does not hold the lane.
- A channel whose pump starts nothing is not offered again for 30 s (`LANE_STALL_MS`). A new command
  in that channel, Run now, or a change of the mode removes the mark.
- Run now (`runChannelNow`) starts one waiting channel beside the one that works, until it stops
  working. It is the way out when the channel that works waits for the user.
- The load ring in the page rail shows the number of agents that run now: distinct agents, so an
  agent with turns in its chat and in a channel counts one time (`runningAgentCount`). The number can
  be more than ten. The arc is that count of ten (`loadAgentArc`), and it stays full above ten. The
  memory is the colour of the ring (`loadRingTone`): what macOS says when it is read, else the share
  of the memory of the computer that the app and its provider processes use. The tooltip and the panel
  give the memory, from the last sample, up to 60 s old (`SAMPLE_INTERVAL_MS`). Only the local host
  shows the ring. A click opens it, never hover. The window reads the load every 15 s, and every 3 s
  while the panel is open.
- The count, the rows of "Running now" and the labels come from one read of
  `AgentService.runningTurns()`, the running turns of `TurnLifecycle`. Do not count `turn-started`
  events: `AgentService.#emit` gives a turn event to the channel, the side thread or the messaging
  thread first, and does not pass it to the listeners when one of them takes it. A count of those
  events read 0 while agents worked in channels. The record of the lifecycle also drops a turn that a
  client stop ended, so no turn counts after it ends.
- The agent limit caps the agents that run at the same time. It is off by default (no limit). On,
  with `max` from 1 to 64 (10 is suggested), a new turn waits in its queue while `max` agents run,
  and starts by itself when an agent ends. Work that runs is never stopped. The limit is a clause of
  the one turn slot gate of the queue drain (`TurnSlots`, `src/backend/agent/turn-slots.ts`), beside
  the memory turn limit (`MacMemory.turnLimit()`, 64 on a desktop, or the server limit): a lane starts
  only when both have room, so the one that is reached first holds it. An agent that runs a turn
  already can start another lane, because it is still one agent; the memory limit counts each turn.
  The waiting lanes go by the head of their queue, a message from a person first, as for the memory
  limit. A change of the limit tries each queue again (`AgentService.agentLimitChanged`).
- With the limit on, the ring arc is the agents of `max` instead of ten, the tooltip says "3 of 10",
  and the panel lists the agents that wait for a place (`AgentService.slotWaitingAgents`) with the
  reason "Limit of N agents reached". The switch and the number are in the panel, beside "One channel
  at a time" and "Resume by itself".

The code:

- `src/backend/channel-lane.ts`: `nextLaneChannel` and `admittedChannels`. They only decide and hold
  no state.
- `src/backend/channel-service.ts`: `wake` with `#laneAdmitted`, `#laneBusy`, `#laneRunnable`,
  `#laneAdvance`, `laneSnapshot`, `runChannelNow` and `laneChanged`.
- `src/main/channel-lane-preference-store.ts`: the mode and the order, in
  `openbot-channel-lane-v1.json` in the user data folder. A missing file, bad JSON or another shape
  reads as off.
- `src/main/agent-limit-preference-store.ts`: the agent limit, in `openbot-agent-limit-v1.json` in
  the user data folder. A missing file, bad JSON, another shape or a value out of range reads as off.
- `packages/contracts/src/ipc-load.ts` and `ipc-endpoints.ts`: `getLoad`, `setLoadLane`,
  `runChannelNow`, `getAgentLimit` and `setAgentLimit`. Main refuses a `max` that is not a whole
  number from 1 to 64 (`parseAgentLimitPreference`), and the preload decodes the answer. `src/main/ipc/app-handlers.ts` answers them with `buildLoadSnapshot`
  (`src/main/load-snapshot.ts`), `ResourceMonitor.loadReading` for the memory, and
  `WorkControl.overview` for the count and the work.
- `packages/ui/src/features/window/LoadRing.tsx`, `load-view.ts` and `page-rail.css`: the ring and
  its panel. `src/renderer/src/features/load/load-controller.ts` reads the load, and
  `WorkspacePageRail.tsx` gives the ring only on the local host.

Rules that are easy to break:

- `createApplicationServices` reads the result of one `Promise.all` by position (`[8]`). Add a new
  `load()` at the end of that list, never before index 8.
- `wake()` must not start the pump of a channel that the lane does not admit. Start a pump only
  through `wake()`.
- `#laneAdvance` wakes a channel only when no channel is busy, and only a runnable one (not busy, not
  stalled). The end of a pump marks a channel that is not busy as stalled before it calls
  `#laneAdvance`. These two checks stop a loop; keep both.

## Stopped work and its recovery

The load panel lists the work that runs and the work that stopped. The person can stop a run, start
stopped work again, or give it to another agent. `WorkControl` (`src/main/work-control.ts`) owns
this. It reads the channels at each request and keeps no copy of them. Each list has at most 50 rows
(`LOAD_WORK_LIST_LIMIT`).

- Work that runs: each agent turn that runs now, from `AgentService.runningTurns()` at each request.
  A turn on the execution thread of a channel shows the channel and the task of the active assignment
  (`starting` or `running`) of that agent. A turn in the chat of an agent shows no channel.
- Work that stopped: each channel task that is `paused` or `failed` and has an error, which is the
  reason. There is one row for each run: the root task when the root stopped, else the task that
  stopped (`buildStoppedWork`). This is the rule of the Continue button of a channel. Archived
  channels are not listed. The ring shows the count of these rows as a red mark.

Each row of both lists names the tab of its task (`topicName`): the name of the tab that
`ChannelTask.topicId` points to, from `ChannelStore.topic`. It is null for a chat turn, a task with no
tab, or a tab that is gone. The lookup runs only for the rows that the panel lists. The request is
clipped to 1,000 characters (`TITLE_LIMIT`) and the reason to 200.

The panel (`packages/ui/src/features/window/LoadRing.tsx`) shows each row as a short list item, with
thin lines between the items:

- The channel name. At its right, a stopped task has one state icon: red for `failed`, amber for
  `paused`. The reason is the tooltip and the accessible name of that icon, not text in the item.
  A run has its minutes there.
- The tab name, smaller and muted. A chat turn shows "In its chat".
- One line of the request. A click on the line, or the chevron (`aria-expanded`), shows all of it,
  with a scroll after eight lines. `requestText` (`load-view.ts`) removes the attachment marks
  (`@[name](attachment:id)`), also a mark that the clip cut; a request with only attachments reads
  "Attached file". The open requests are kept in the panel and close with it.
- Who had the task, and what the automatic recovery does with it.
- Resume and a Reassign menu (the agents with the same model first, marked), or Stop.

The reason is stored as English. The panel translates it with `sourceText` (`useText`): a stored
reason that is the English of a source key, such as `error.backend.channelStartFailed` or
`error.backend.channelTurnUnconfirmed`, shows in the reader's language; any other reason shows as it
is stored.

The actions (`app:stop-work`, `app:resume-stopped-work`, `app:reassign-stopped-work`; handlers in
`src/main/ipc/app-handlers.ts`):

- `stopWork`: for a channel turn, sends the `stop` command to the top active task of its run
  (`topActiveTask`), because a channel stops its run and not one turn. When the task is not active,
  nothing is sent. A chat turn goes to `AgentService.interrupt`.
- `resumeStopped`: sends the `resume` command for each row, from `{ all: true }` or a list of ids.
- `reassignStopped`: sends the `reassign` command to one task.

Each of `resumeStopped` and `reassignStopped` checks the ids against the work that is stopped now.
An id that is not stopped is ignored, so a forged or old id starts nothing. A reassign also needs an
agent that the panel offered for that task; the channel service then checks that the agent is an
available member.

Candidates (`reassignCandidates` in `src/main/auto-recovery.ts`):

- Only available members of the channel: the agent exists, is not hidden, and no spent plan holds
  it. Never the owner of the task. At most 8.
- The same model first, then the same provider, then the rest. Each group is in name order.
- The automatic recovery takes only an agent with the same model or the same provider
  (`autoReassignee`), and never an agent that it tried for that task.

The automatic recovery (`AutoRecovery`, same file):

- It is off by default. The panel turns it on and sets the interval: 5 to 1440 minutes, 30
  suggested. A second switch lets it give a task to another agent; that switch is also off by
  default.
- `AutoRecoveryPreferenceStore` keeps the preference in `openbot-auto-recovery-v1.json` in the user
  data folder. A missing or damaged file, another shape, or a value out of range reads as the
  default.
- A timer looks every 60 s. One look does not overlap the one before it.
- A task waits the whole interval from the first time a look saw it stopped, and again after each
  action.
- Each task gets `MAX_RESUMES` (2) resumes, then, when the switch allows it, `MAX_REASSIGNS` (2)
  reassigns. Then the recovery gives up. A failed request counts as a try.
- One look acts on at most 3 tasks. A give-up counts as one.
- A record stays for 6 hours after the last look that saw its task stopped. So a task that runs and
  stops again keeps its count.
- The records are in memory only. A restart resets the counts and the wait.
- While the recovery is on, each stopped row shows that it waits, or that the recovery gave up. The
  panel also lists the last 5 actions.

Rules that are easy to break:

- `resume` puts the whole run below the task in the queue again and stops the turns in it. A
  `resume` of a task that runs stops its turn. So each action touches only tasks that are stopped
  now. Keep the check against the stopped rows.
- `resume` puts the task in the queue and calls `wake()`. The one-channel-at-a-time lane still
  decides when a resumed channel starts. Do not start a pump from `WorkControl`.
- Tasks of older versions keep their reason in the database. Keep the English of a source key that
  a task stores as its reason byte for byte, or the panel and the channel show those reasons in
  English again.
- `LoadRing` draws the panel in a `Popover.Portal`, and the panel has `-webkit-app-region:
  no-drag`. The rail is a drag region (`-webkit-app-region: drag`) and clips its children. Inside
  the rail, a click did not open the panel.
- Teardown stops the recovery timer before the agent service (`TEARDOWN_ORDER.workControl`), so no
  look starts work while the service stops.

## Resume after a restart

When the app stops while work runs (a forced quit, a crash, or a quit), boot recovery stops that
work and never starts it again. After the restart, the main window asks which work must continue:
all, some channels, or some agents. Nothing continues until the user clicks. Not now drops the
offer for this run.

What boot recovery leaves in the database:

- An agent turn. `BootRecovery.recoverPersistedTurns` (before providers start) clears the
  `activeTurnId` of the thread and marks its streaming messages `interrupted`. When providers are
  ready, `reconcileUnresolvedDeliveries` reads the provider history. Each delivery that was
  `starting` or `running` becomes `completed` or `failed` when the history shows it; otherwise it
  becomes `interrupted`. A queued delivery stays queued and starts as usual.
- A channel task. After that reconcile, `ChannelService.recover` ends each active assignment whose
  delivery is not live: `completed` when the delivery completed, else `interrupted`, with the task
  `paused` and the error "The previous turn has no confirmed result. Check its work before you
  resume." The channel shows the task above the composer (`stoppedChannelTasks`).

How the offer works:

- `startedDeliveries` reads `MailboxStore.unresolvedDeliveries()` right after the mailbox loads,
  before recovery. It keeps ids only: an agent's own chat when the user sent the message, a channel
  task, or other work (agent tasks, external conversations, routines, teammates), which the offer
  leaves out.
- `ResumeOffer` (`src/main/resume-offer.ts`) follows the `queue-changed` and `channels-changed`
  events until each started delivery is settled and its channel assignment is not active. It then
  keeps the agents whose delivery is `interrupted`, and the channels that have a stopped run. A
  deleted or hidden agent and a deleted or archived channel drop out. It holds names and counts
  only, in memory.
- `getResumeOffer` waits until that point. `resumeInterruptedWork` takes `{ all: true }` or lists of
  ids; an id that the offer does not hold does nothing. The work that the user did not choose drops
  out, and the work whose request failed stays in the offer. One choice runs at a time, so a second
  click sends nothing again.
- An agent gets a user message in its own chat (`AgentService.sendMessage`), with the English prompt
  `RESUME_CONTINUE_TEXT`. A channel gets the `resume` command on the entry of each stopped run, as
  its Continue button sends it. The task goes into the queue, so the one-channel-at-a-time lane
  decides when it starts. A task that runs again before the click is not sent: `resume` would stop
  its turn. The ids of both requests make a retry idempotent.
- `ResumeOfferHost` (`src/renderer/src/features/resume/`) reads the offer once, in the main window
  only. The preview mock has no offer.

## Messaging connections

The agents of a computer can answer in an external chat platform: Slack, Discord (see **Discord**
below) and Telegram. [messaging.md](../messaging.md) has the setup, the limits and how to add a
platform. Every workspace
installs the one OpenBot Slack app (`apps/slack-app`), and the workspace is linked to the host that
connected it. People mention @OpenBot or send it a direct message. The workspace's Slack Orchestrator,
an agent that the connect dialog adds, receives each new conversation, asks its teammates and posts
the answer. Every answer comes from OpenBot.

- **Install.** The desktop asks `POST /v2/slack/authorize` for Slack's install URL, with a one-use host
  key. The Worker exchanges the code at `/v2/slack/callback`, because the app's client secret lives
  there. It links the workspace to the host in D1 (`slack_workspace_routes`: team, host, account; no
  token) and seals the bot token to the host key (`@openbot/contracts/slack-workspace-grant`). The
  page `/slack/connect` opens `openbot://slack-workspace`. Only the account that linked a workspace
  can move it to another of its hosts; another account gets `slack_workspace_taken`.
- **Events.** Slack posts every workspace's events and button presses to one URL,
  `https://signal.openbot.run/v1/slack/events`. Signal checks Slack's signature with the app's
  signing secret, answers `url_verification`, and reads only the app ID and the workspace ID. Each
  signing secret is bound to its app, and a route is one app in one workspace, so the production and
  development apps can share a workspace. It passes the exact body to the `ingress` socket (`SignalIngress` in main, a plain `ws` client: no WebRTC, so no hidden
  window) that holds a route ticket for that workspace, and returns the host's answer within 2.5 s,
  or 503 so that Slack sends it again. The route ticket is an ES256 JWT that `apps/auth-api` signs
  with its own key for a host that proves its machine token. It names only the workspaces that D1
  links to that host, expires after 5 minutes, and the host asks for a new one each time the socket
  connects. Each workspace in the ticket carries the time D1 linked it. When a workspace is unlinked
  or moved, the Worker sends Signal `slack-route-revoked` through the signed auth-event outbox:
  Signal drops the route and refuses tickets with that link or an older one, so a host that lost the
  workspace cannot keep it with the ticket it holds. Signal keeps these revocations in memory, so for
  one ticket lifetime after it starts it asks the Worker (`/v2/remote/slack-route/validate`, signed
  like `/v2/remote/resume/validate`) which links of each ticket D1 still has. The host trusts a delivery because Signal checked the signature; no host has the
  signing secret.

Telegram uses the same socket with one difference: one OpenBot bot serves every user, so its token
must not reach any host. Only Signal has it (`TELEGRAM_BOT_TOKENS`), and the contract is
`@openbot/contracts/signal-protocol/telegram-route`.

- **Link.** A connection is one chat. The desktop asks `POST /v2/remote/hosts/<id>/telegram-link`
  (machine token) for a one-use code, and opens `t.me/<bot>?startgroup=<code>` or `?start=<code>`.
  Telegram sends `/start <code>` in the chat that adds the bot. Signal asks the Worker
  (`/v2/remote/telegram-route/link`, signed) to link the chat to the host of the code
  (`telegram_chat_routes`, `telegram_link_codes`: hashes only, no chat name), routes the chat to that
  host's socket at once, and passes the update on with `linked: true`; the host makes the
  connection only on that flag, because anyone in a routed chat can send a `/start` with any code.
  The open code holds the host's socket until the link or its expiry, as no connection may hold it. Another
  account's host gets `telegram_chat_taken`.
- **Updates.** Telegram posts to `https://signal.openbot.run/v1/telegram/updates/<bot ID>` with a
  secret header that Signal derives for each bot. Signal reads only the chat ID, a link code and a
  callback query ID, and sends `telegram-delivery` to the socket that holds the chat. It always
  answers 200: Telegram would hold back the bot's other chats behind one offline host. The Telegram
  route ticket (`telegramRoute` in the hello, audience `openbot-telegram-route`, the Slack route key)
  and `telegram-route-revoked` work as the Slack ones do.
- **Calls.** The host sends `telegram-call` only to a Signal whose `ready` names the `telegram`
  capability, because Signal closes a socket on a frame it does not know. Signal accepts only the
  methods and parameters of `TelegramCallParams`, as strict objects, only for a chat routed to that
  socket, and `answerCallbackQuery` only for a press it delivered to it. It returns only message IDs
  and tokens. `getFile` and `sendDocument` give signed one-use tokens for
  `GET /v1/telegram/files/<token>` and `POST /v1/telegram/uploads/<token>` (20 MB).
- **Conversations.** In a supergroup, each reply chain is one conversation: Telegram gives it a
  `message_thread_id`, the ID of its first message. A forum topic is one conversation, a direct chat
  is one, and a basic group finds the chain in an in-memory reply map, which a restart forgets. A
  mention starts or continues a conversation; a reply without a mention continues only a linked one.
  Telegram has no history API, so `TelegramChatState` keeps the names and last messages it saw, in
  memory. One Telegram Orchestrator (`telegram-orchestrator.ts`) answers every chat.

The code has two halves. `MessagingThreads` (`src/backend/messaging/`) is built by `AgentService`
beside `ChannelService` and knows no platform. `MessagingService` is built in the main process and
owns the live connections, through one `MessagingDriver` per platform: an adapter for its API and a
transport for its events. `messaging-types.ts` is the seam; the core never reads a platform payload.

- **Storage.** Migration 25 adds `projection_messaging_connections` (one per workspace, with its
  orchestrator agent) and `projection_messaging_threads` (one per external conversation, with the
  agent that answers it).
  Tokens are not in the database: `MessagingCredentialStore` keeps the bot token encrypted by
  `safeStorage`, keyed by connection, and only its state crosses IPC. Migration 36 adds
  `projection_messaging_memories`, the facts of each connection (`MessagingMemoryStore`, the same
  `MemoryStore` as agent and channel memories, with a connection for an owner). No code deletes a
  connection, so the table has no cascade: disconnect keeps the facts.
- **Orchestrator.** A message in a thread that has a link goes to the link's agent. A new conversation
  goes to the workspace's orchestrator; without one, Slack is told that no agent answers. The
  orchestrator is a normal agent (`slack-orchestrator.ts`): its description is its standing remit, and
  it starts with five memories, which are facts only, because the model reads memories as data. It
  gives work to one teammate with `send_message`; the request carries `messagingReturn`, so the
  teammate's answer runs as a follow-up turn in the same Slack thread. A turn that only asked a
  teammate posts "A teammate is working on it" (`MessagingThreads.awaitsTeammate`). It goes in the
  sidebar's Integrations section, which `MessagingService` creates the first time; the renderer shows
  that section collapsed. A disconnect deletes the orchestrator that no other connected place uses
  (`AgentService.deleteAgent`, which also removes its links), and then the section when no agent is
  assigned to it. It checks first that the agent can be deleted, so a busy orchestrator stops the
  disconnect before the token is revoked or the place unlinked.
- **Execution threads.** Each Slack thread is a link with its own execution thread in
  `projection_threads`, as a channel-agent pair is. A direct message is answered in a thread under
  it, so each one is its own conversation. `MessagingThreads.event` takes that thread's conversation
  and turn events, so the public chat, the renderer and Team peers never see them. Approvals still
  reach the host.
- **Deliveries.** An external message is a mailbox message from `user` with a `messaging` origin
  (link, author, platform message). No new sender kind, so the frozen Team protocol codecs are
  unchanged. The queue and the public chat hide it like channel work. A request the agent sends from
  a Slack turn carries `messagingReturn`, the origin of that turn; `MailboxStore.enqueue` gives the
  answer to it that origin as `messaging`, so the answer runs in the same execution thread, and its
  turn posts to Slack as a follow-up. `DrainScheduler` asks `MessagingThreads.prepare` for the thread
  and the prompt, which frames the text as external input and adds earlier messages of the thread
  and the connection's facts, rebuilt each turn, so a new fact needs no provider-thread reload.
  `MessagingService.#receive` names each user mention (`InboundMessage.mentionedUserIds`) with the
  adapter's name cache; the adapters do the same for context messages.
- **Tools.** `messaging_remember`, `messaging_forget_memory` and `messaging_history` are deferred
  `openbot` tools. `OpenBotToolRouter` finds the link from the calling turn's execution thread and
  refuses a call from any other thread; no argument names a connection or a channel. The history
  tool calls the adapter's `recent` through `MessagingThreads.setHistorySource`. A fact is not saved
  from a direct message. The two outbound tools, `messaging_list_places` and `messaging_post`, are
  the exception: the router passes them to `MessagingThreads.outboundTool` from any thread, their
  arguments name an enabled connection and a place, and `MessagingService` answers them through
  `MessagingThreads.setOutbound` with the adapter's `places` and `postAnswer`, after `redactText`.
- **Order.** The one-turn-per-agent rule is unchanged, so Slack requests wait behind the agent's own
  work and behind channel work that holds the host. The Slack thread shows a waiting post.
- **Replies.** `MessagingThreads` reports each turn start and end. `MessagingService` posts a status
  with a Stop button, replaces it with the answer, uploads the files the agent attached, and sets
  reactions. It serializes the posts of one conversation, so a fast turn cannot race its status. No
  post names the agent.
- **Approvals and stop.** An approval of a messaging thread is also posted with buttons. Only the
  Slack user whose message started the turn can answer or stop it; the host can always answer. The
  button value is a random token that exists only in memory.
- **Channels.** When a connection starts, OpenBot joins every public channel it is not in
  (`conversations.list`, `conversations.join`, scope `channels:join`), so people can mention it with
  no invitation. It joins each new public channel on `channel_created`. A private channel needs
  `/invite`.
- **Deduplication.** An in-memory set drops a redelivered event at once; the mailbox idempotency key
  covers a restart, and a kept event that Signal sends again. Events that arrive while no socket is
  open are lost after Slack's retries, except for a hosted server that starts.
- **Screen.** **Marketplace → Apps → Slack** on the computer that runs the agents shows
  each workspace and its orchestrator, and a two-step dialog connects the workspace and adds the
  orchestrator on the model the user picks (`messaging:*`). A remote server shows no Slack page,
  because the install returns to the host's own browser. A live connection does not count as use:
  a hosted server sleeps, and Signal starts it for the next message that addresses OpenBot and keeps
  that message, sealed to the host, until the host connects
  ([Connector events](../hosted-servers.md#connector-events)). **Apps → Discord** is the same page for Discord
  (`SlackIntegrationPanel` with `platform="discord"`). **Apps → Telegram** has its own page
  (`TelegramIntegrationPanel`), with one row per chat and one orchestrator for all chats.

**Discord.** Every guild installs the one OpenBot Discord app (`apps/discord-app`), and a guild is a
connection with its own Discord Orchestrator (`discord-orchestrator.ts`). Discord pushes a bot's
messages only over its Gateway WebSocket, and the bot token cannot go to each host, so Signal holds
the token and does the platform work for the hosts:

- **Install.** As for Slack: `POST /v2/discord/authorize`, `/v2/discord/callback` (scope `bot`, the
  Worker exchanges the code, revokes the user token it gets, and links the guild in D1
  `discord_guild_routes`), the page `/discord/connect` and `openbot://discord-guild`. The sealed grant
  (`@openbot/contracts/discord-guild-grant`, on `host-grant.ts`) names the guild and holds no token.
  Another account gets `discord_guild_taken`.
- **Events.** Signal keeps one Gateway connection (`@discordjs/ws`) with the guilds, guild messages
  and direct messages intents, and no privileged intent. It passes on only a guild message that
  mentions the bot, and a press of an OpenBot button, which it acknowledges to Discord at once. It
  normalizes each into `DiscordDelivery` (`@openbot/contracts/signal-protocol/discord-api`), takes the
  bot's own mention out, and sends a `discord-delivery` frame to the `ingress` socket that holds a
  Discord route ticket for the guild. The ticket mirrors the Slack one (audience
  `openbot-discord-route`, `/v2/remote/hosts/:id/discord-route`, `discord-route-revoked`,
  `/v2/remote/discord-route/validate`). The socket asks for a route only for the platforms whose
  connections hold it.
- **Removal.** When the bot leaves a guild, Signal drops its route and asks the account service to
  unlink it (`/v2/remote/discord-route/removed`, signed), so an offline host does not keep it. After
  the Gateway lists every guild of the bot, and every 30 minutes, Signal sends those guild IDs
  (`/v2/remote/discord-route/reconcile`), and the account service unlinks each link of another guild
  that is older than five minutes. It sends nothing while a Gateway shard is closed, because the list
  can miss a guild that installed the bot meanwhile. A route ticket that still names a guild the bot is not in is not
  routed. The `discord-session` frame lists the guilds
  routed to the socket; a host connection whose guild is not listed stops, and **Reconnect** starts
  the install again.
- **Calls.** After `ready`, Signal sends the socket a `discord-session` token. The host's adapter
  (`discord-driver.ts`) sends typed operations (`DiscordApiRequest`: post, edit, delete, react, list
  messages, names, a private reply to a button press, upload) to `POST /v1/discord/api` with that
  bearer. Signal accepts an operation only for a guild routed to that socket, and only for a channel
  of that guild, and makes the call with `@discordjs/rest`. Every post has no allowed mention, so it
  pings nobody. Attachments are signed CDN addresses, which the host downloads directly.
- **Conversations.** A conversation is a reply chain, keyed by its first message. Every OpenBot post
  replies to that message, so a reply to an OpenBot post names the conversation through the replied
  post's own reference. A direct message has no guild, so Signal answers it once with a fixed line.

## Mobile chat queue

Mobile reads the host queue, applies `queue-changed` snapshots, and refreshes active queue
queries on `queue-invalidated` events. Both events cancel earlier reads before they update the cache. It does not
run a second delivery loop. Queued and cancelled deliveries stay outside the chat transcript.
The panel uses a bounded virtualized list and one glass surface with a bottom-anchored
transition that respects reduced motion. Its fixed list viewport stays mounted, and the
composer inset changes once per toggle. Streaming does not change the panel's inputs.

The optional `queue-edit-v1` capability and desktop edit IPC provide the same host edit hold.
Held deliveries remain in public queue snapshots with an editing marker. The private edit
identity is not exposed. Only the matching editor can change the held message.
Desktop and mobile write the edit identity before requesting the hold. Each client enables
saving only after confirmation. A failed attachment-retention request keeps the desktop edit
identity and backup available for retry. The mailbox stores
the hold in the existing delivery JSON. The first held delivery blocks automatic queue dispatch;
steer and an update without that edit identity are rejected. Saving commits the replacement
message and releases the hold in one mailbox transaction. Cancel restores normal dispatch without
changing the message. Delete cancels the delivery, finishes its edit, and releases attachment
ownership in the same mailbox transaction. Released edit drafts survive restart until sent or
discarded, so a lost cancellation response cannot destroy a saved composer backup. Ordinary
unretained drafts still expire at host startup. A finished edit identity records the action that
finished it, so a repeat of that same action stays safe after a lost response, while a save that
follows a completed cancel is rejected instead of reporting success for text the host never took. Holds and locally saved edit drafts survive host restart and client navigation; they have
no timeout that could send a message while someone is still editing it. Older hosts retain queue
view, steer, delete and reorder, but mobile disables editing without the capability.

The mobile queue is a route, not a panel. Each chat publishes its live queue controller under its
own identity, and the sheet reads the identity it was opened with, so a chat that the native stack
keeps mounted cannot answer for another chat's open sheet. Queued files are listed as rows: an
image shows its own thumbnail, every other file shows the file icon, and the message options open
a file in the share sheet. The thumbnail reads the attachment through the query key the chat uses,
so a file already read in a message is not fetched again. The editor changes the text, removes the
files the message already has, and adds new ones.
