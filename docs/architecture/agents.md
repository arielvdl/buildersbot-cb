# Agents

## Local scripts API

`src/main/automation-server.ts` is a loopback HTTP listener through which a local script sends
messages, runs routines, and answers pending questions and approvals for an enabled agent. It also
reads delivery results, changes the agent's model and account, and starts a new chat. [docs/automation.md](../automation.md) has the routes and the
commands. The listener runs only while at least one agent has `allowAutomation`, and binds
`127.0.0.1` on a free port. It writes the URL and a new bearer token to `<userData>/automation/`
(folder `0700`, files `0600`) and deletes them when it stops. It refuses any request with an
`Origin` header or a foreign `Host` before it checks the token, so a web page cannot reach it.

A run is a manual routine run with the payload after the instruction, so no Team API protocol, run
kind or sender changes. The payload is in the run row, and `resumePendingRuns` sends it again after a
crash. The flag is in `agent_json` and needs no migration; a profile without it is off. Only the user
changes it: the general Team API agent parser and the agent profile tools do not accept it, the
general remote IPC update refuses it, and duplication does not copy it. When the flag is
on, the developer instructions name the two file paths, never the token.

An owner or administrator can also change the flag through the existing `agent-host-settings-v1`
routes. Desktop, web and mobile clients use these routes. The general agent update route keeps
refusing it, and hosts without this capability keep the remote control hidden. Remote clients read
the flag from the host settings response because the released agent summary does not carry it.

Permission decision for #1720: the developer explicitly approved extending the existing Local
scripts grant to messages and question/approval responses, including agents that already have it
enabled. There is no new opt-in or capability. This is a specific exception to the routine-only
meaning first shipped in `agent-host-settings-v1`. Older clients can still change the same flag;
their older text can describe routines only. The wire payloads and owner/admin checks stay unchanged.

Messages use `AgentService.sendMessage` and its persisted retry keys. The attention registry gives
each pending object an opaque local handle. Responses match that handle and agent together; an
expired handle cannot answer a later provider request. Pending details are not trimmed to the UI
snapshot budget. The HTTP boundary redacts outgoing values. Browser takeovers and secret questions
are notices only and direct the person to Builders Bot. Messages and routine runs share the rate limit.

## Scheduled routine changes

The agent scheduler reads the due list once per pass. It reads each routine again before it starts
that occurrence, because queueing an earlier run can yield. A paused or deleted routine, a replaced
trigger, or a moved due time leaves the old list without starting work. An edit that keeps the same
trigger and due time uses the current instruction and policies. The run row still commits before
the trigger advances or completes, so restart recovery keeps the same run and mailbox delivery.

## Quiet routine runs

A scheduled, script or webhook run of an agent routine can end without news, in two ways. No person
waits for the answer of such a run (`quietRoutineRun`). The run history stores what started a manual
run in `run_source` (`test`, `script` or `webhook`); a manual run from before migration 35 has none
and is read as a Test run. The agent calls the
`routine_no_update` tool, which the run prompt names, or the user asks in the routine task
for an answer of only `[[no-update]]`. Models often write a short sentence instead of an exact
token, so the tool is the main path. There is no setting. The tool and the marker do not
depend on the language of the answer (`src/backend/agent/routine-quiet-runs.ts`). The tool call is
held in memory until the turn completes; the history import finds it again by the tool name, as
it finds the marker by its text. When a turn that ran only quiet routine runs completes and every
answer is the marker, or the agent called the tool and the turn gave no file, image or question, the
turn drops its markers, thinking and plan from the conversation. Each other text answer stays with the
item type `routine_quiet_answer`. A quiet answer does not count as unread, does not change the agent
preview, and no Team API client gets it; the desktop chat shows it under its run, which starts closed.
The turn puts back the agent preview from
before the run (the run start shows the task there; memory only, so after a restart the task stays),
and its `turn-completed`
event has `quiet: true`, which stops the desktop notification and the completion sound. The run
marker and the run history stay. A marker inside a longer answer is a report and is shown. A Test run
is never quiet.

`quiet` reaches remote clients too, through the optional `quiet-turn-v1` capability
(`packages/contracts/src/team-protocol/quiet-turn-v1.ts`). The host sends a client with the
capability a `quiet-turn-completed` event in place of `turn-completed`. The client transport changes
it back to `turn-completed` with `quiet: true` (`optional-events.ts`). The browser client, the phone,
and a desktop connected to a remote server then show no notification, play no completion sound, and
the Dynamic Island shows no new reply. A client without the capability gets the released
`turn-completed` event and shows the run as finished, as before. A malformed
`quiet-turn-completed` event is an error.

## Failed routine runs

A run's status comes from its queue delivery (`routineStatusForDelivery`), so a completed turn is a
`succeeded` run, also when the task inside it failed. Every run prompt names the
`routine_report_failure` tool, the Test run and a flow handoff too. The agent calls it with a short
`reason` when the task could not be done. The reason is held in memory until the turn completes.
When the turn completes, each routine delivery of the turn ends `completed` with the reason in its
`error` column (redacted as other errors). The agent did answer, so the answer, the chat digest and
the notification are as before. `routineStatusForDelivery` maps a completed delivery with an error to
a `failed` run with that error, so the run goes from `running` to `failed` in one step, and every
later reconcile keeps it failed. No column was added. A failed run is never quiet, also after a call
to `routine_no_update`: that call then answers `shown`, and the history import keeps the answers. A provider error or an interrupt still wins: the delivery then ends `failed`
or `interrupted` with its own error. The run history shows the error of a failed run. A result
destination gets the answer of a failed run whose delivery completed; a provider failure has no
answer and sends nothing. Outside a routine run the tool returns the same error as
`routine_no_update`.

A routine run whose last answer is only the marker, also a Test run that shows it in the chat, does
not put the marker in the preview either. The provider history import
(`src/backend/provider-history-import.ts`) decides from the staged items alone: in a turn that a
routine delivery started, it skips each answer that is only the marker, and when every answer is
the marker it skips the turn's thinking too, so a later import does not bring a quiet turn back.

## Routine sessions

A routine run in an agent's own chat (no task, channel or messaging delivery) does not resume the
chat's provider session. `DrainScheduler.startDelivery` starts a new session for it with
`ThreadLifecycle.startRoutineThread`: the chat's thread parameters, with `ephemeral: true` and
`persistSession: false`. `ConversationRuntime` binds the session to the agent's public thread, so the
run's items show in the chat, and `registerRoutineSession` marks it. The first message reads a short
handoff of the newest chat messages (`renderRoutineHandoff`, 8,000 characters). Interrupt and steer
go to the routine session while it runs. Usage records of the run use the session id
`routine:<external id>`; their origin stays `routine`.

When the turn ends, `TurnLifecycle` closes the session (`closeRoutineThread`). A non-quiet run adds a
short digest of its answer to the chat session's pending handoff (`appendRoutineDigest`: 1,500
characters for each run, 6,000 in total), so the next chat turn reads it. The chat session keeps its
id and its context. A restart during a run marks the run interrupted: the session is not saved.

## Routine calendar feed

`src/main/routine-feed-server.ts` is a loopback HTTP listener that serves the routines of this
computer as an iCalendar feed (`src/main/routine-feed-ics.ts`) for Server Settings > Routines. It
runs only after the user makes a feed URL, and binds `127.0.0.1`. The URL is
`/routines/<token>.ics`, with an optional `?agent=<id>`: a calendar app cannot send a header, so the
token is in the path. `<userData>/openbot-routine-feed-v1.json` keeps the token, encrypted with the
secret storage cipher, and the port, so the URL stays the same after a restart. When the port is not
free, the listener takes a new one and saves it. **New URL** replaces the token, and **Turn off**
deletes the file. A wrong token gets 404. A request with an `Origin` header or a foreign `Host`
gets 403 before the token is checked. Logs never contain the URL.

The feed lists each run of the next 30 days of active routines as one UTC event, placed by the same
schedule code that fires the run, so it needs no RRULE or time zone rules. Nothing leaves the
computer: a calendar service that fetches feeds from its own servers, such as Google Calendar or
iCloud, cannot read it.

## Routine flows

A routine flow hands the answer of an agent routine on to other agents. The Routines view of the
sidebar shows one canvas for each agent: every routine whose run reaches it, the agents its links
reach, and the last run of each routine. The host keeps the flows. A joined desktop and the web
client read and change them through the optional `routine-flows-v1` capability (see
[Routine flows](servers.md#routine-flows)); a host without it shows a notice instead of the canvas.
The agent event `routine-flows-changed` names the agent whose canvas changed, on this computer and
on a joined host.

- `src/renderer/src/features/routine-flows/RoutineFlowsCanvas.tsx` is the canvas. It reads no
  application context: it takes a `RoutineFlowsHost` (`routine-flows-port.ts`), the open agent and
  the agent list. `WorkspaceRoutineFlows.tsx` gives it the active server through main, and
  `web-client/web-routine-flows.ts` gives it the connected host over the Team API.

- `src/backend/routine-flows/` owns the three tables of migration 31: links, node positions and steps.
  The rows are written directly, not through `dispatch`, because a step holds the text that one agent
  gave another, and the event log is never deleted from. `hardDeleteAgent` removes the rows of a
  deleted agent; a deleted routine or run takes its rows by foreign key.
- `RoutineFlows` (`routine-flows.ts`) is an Effect service on its own managed runtime. It never
  listens to a provider. On a turn, queue or routine event it sweeps: it records the answer of a run
  that ended, settles each step whose delivery ended, and sends the next messages. Sweeps run one at
  a time, and one more after a sweep runs again for an event that arrived during it. Startup sweeps
  once, so a flow that a restart stopped continues.
- A link belongs to one routine and applies only to runs that started after it. An agent with several
  inputs waits for all of them and gets them in one message. An agent whose inputs all failed is
  skipped, so a failure never leaves a flow waiting.
- A handoff is a mailbox delivery from the routine (`RoutineScheduler.enqueueHandoff`). It names the
  same routine and run, but `reconcileDelivery` finds a run only by its own delivery, so the run status
  does not change. A `routine_report_failure` call in a handoff turn fails only that step, through its
  completed delivery's error, and the agents after it are skipped.
- A canvas shows routines of every trigger kind (`routine-flow-routines.ts`). A webhook routine
  carries its endpoint, event type and filters; the details panel saves them, rotates the secret and
  runs a test through the events API, as the routine settings do. On a joined host only an owner or
  admin has that API (`events-v1`); a member sees no webhook config and cannot change or run a
  webhook routine from the canvas.
- Agents read and change flows with the `openbot` tools `list_routine_flows`, `connect_routine_agents`
  and `disconnect_routine_agents` (`routine-flow-tools.ts`). `RoutineFlows` is built after the agent
  service, so the tool router reads it through a getter. The canvas chat panel sends the user's request
  to the open agent's own conversation and shows the answer of the turn that read it.

## Workflows

A workflow is a graph of steps that the user draws on the canvas of the Workflows page (the
`Waypoints` button of the page rail). It is not part of one agent: a graph can name several agents,
models, conditions, approvals and outputs. The host keeps the workflows. A joined desktop and the
web client use them through the optional `workflows-v1` capability (see
[Workflows](servers.md#workflows)). The agent event `workflows-changed` names the workflow that
changed, on this computer and on a joined host.

- `packages/ui/src/features/workflows/` is the canvas. It reads no application context: it takes
  the document, catalogs, run state and callbacks as props. Edits stay local for fast drags and
  undo, and the canvas gives the new document after each history step.
  `src/renderer/src/features/workflows/` holds `WorkflowsPage.tsx`, `workflows-port.ts` (the port
  over `window.openbot.workflows`) and `workflows-controller.ts`. The controller is the same for the
  page and the stories. It saves the graph 400 ms after the last edit, one save at a time on its
  base revision. A failed save keeps the edit for the next save. A change from another device, a
  conflict or a restore loads the graph again, and undo on the canvas gets the edits back.
- `src/backend/workflows/` owns the tables of migration 46: workflows, nodes, edges, versions,
  triggers, webhook triggers and receipts, runs, steps and output posts. The rows are written
  directly, not through `dispatch`, as for routine flows. `workflow-graph.ts` checks the graph rules
  (branch edges only from a condition, port types, limits). A graph can have loops. A save with an old revision
  answers the current graph as a conflict. The store keeps at most 50 versions: one when the newest
  is older than 5 minutes, one on a restore, and one when a run starts on a graph revision that has
  no version yet.
- `Workflows` (`workflows.ts`) is an Effect service on its own managed runtime. A run copies the
  graph. Each pass ends the steps that ended and starts each node whose inputs are in
  (`workflow-walk.ts`). Passes run one at a time; a pass runs after a turn or queue event, after
  each user action, and at startup. A node runs again when a node before it has a newer step, as
  after a retry. A retry uses the node's current settings, so a fix made after the failure applies;
  it uses the run's copy when the node is gone or is now another kind. An edge back to an earlier node (`workflowLoopEdges` in the contracts) is a loop:
  when its source is done and newer, the earlier node runs again with that answer as one more
  input. A loop has no pass limit. It ends when a condition takes the other branch, a step fails or
  is rejected, or the user stops the run. The canvas marks a loop with no condition as endless.
- An agent step is a routine handoff (`AgentService.enqueueRoutineHandoff`, with the workflow as the
  routine) and ends when its delivery ends. Its tokens count under the agent. A model step and a
  condition run in a process without tools; a condition must answer yes or no, and only the edges of
  that branch stay active. That process (`warm-generations.ts`) stays for 5 idle minutes, so the
  next step does not start the provider again. Each step still starts a new ephemeral thread, so no
  step sees the text of another. The process stops when the provider's main client stops or
  changes, after a failed step, and at shutdown. The tokens of these steps count under one reserved
  usage row, `WORKFLOWS_USAGE_ID`, beside the agents. An
  approval waits for the user; a rejection stops the run. An output shows a desktop notification or
  posts to a messaging place.
- `WorkflowTriggers` (`workflow-triggers.ts`) gives schedule triggers to the routine timer as an
  extra due source. An occurrence is skipped while the workflow has an open run, and missed
  occurrences become one run. A webhook trigger has a route of its own owner kind (`workflow`); see
  [Route lifecycle](events.md#route-lifecycle).
- A restart keeps approvals and agent steps, because their state is in the database and the
  mailbox. The first pass fails a model step that was running, and ends a run that was stopping. An
  agent step fails with `agentMissing` when its agent is deleted. A post that did not start is sent; a
  post that was on its way fails as uncertain, and the user retries the step.
- Image, asset, file output and message trigger nodes are kept in the graph but do not run yet; a
  run that reaches one fails with `nodeUnsupported`.

## Hidden agents

A user hides an agent from its sidebar menu in place of a delete. The agent keeps its thread, files,
memories, settings, pin and section. `AgentSummary.hiddenAt` is in `projection_agents.agent_json`,
so the state needs no SQL migration and a duplicate does not copy it. The host refuses new messages
to a hidden agent with `error.backend.recipientHidden`, on IPC, channels, MCP `send_message`, the
automation server and external messaging. Its routines do not run, and its queued messages wait
behind the drain hold `"hidden"`. A turn that runs at the hide finishes. A hidden agent is not in
`list_agents`, the teammates prompt, the mention picker, the counts or "Needs you". A hidden lead does not
route channel requests, and `ChannelService.releaseAgent` gives the queued and starting channel
assignments of the agent back to their channels.

Restore marks the missed routine runs as skipped before it clears the flag, so the timer does not
run a backlog. Then it arms the routines and drains the queue. IPC `agent:hidden:list` and
`agent:hidden:set` change the state, and the event `hidden-agents-changed` carries the whole list.
A joined desktop, the web client and the mobile app use the optional `agent-hidden-v1` capability
(`packages/contracts/src/team-protocol/agent-hidden-v1.ts`). Any member reads the list; only an
owner or an admin hides or restores an agent on a host.
`/v1/agents` and the released agent codecs do not carry `hiddenAt`.

## Agent avatar

An agent with no picture shows the app mark: a box seen from its corner (`AgentMark` in
`packages/brand/src/agent-mark.tsx`). All three faces have the agent's color. The lid has the color,
and the sides have the same hue with less light; `agent-mark-shades.ts` makes the shades in OKLCH.
The symbol on the lid is white, or a dark ink when the OKLab lightness of the color is more than
0.78, as for lime and yellow. The box of a failed agent is red (`--openbot-danger`). The silhouette
clips the inner edges, so their round ends do not go past the rounded corners. The faces, the edges,
the eyes and the symbols get their colors in their `style`, so a copy of the SVG without the
stylesheet (`createStaticAvatarSvg`) still shows the box at rest. The accent can be a CSS variable,
as on the startup splash; the browser then mixes the shades.

The left face has two eyes (`AgentMarkSide`): a light eye with an outline, a dark pupil with a white
glint, and an eyelid in the color of the left face. The white of the eye clips the pupil and the
eyelid. `agentMarkEyelid` (`agent-mark-eyes.ts`) gives how far the eyelid comes down for each mood,
from 0 (open) to 1 (closed). The pupils look around (`agent-mark-look`) and the eyelids blink
(`agent-mark-blink`). A hash of the avatar seed shifts the start of both, so two agents do not blink
together.

The right face shows the emblem of the agent's role. `avatarMarkRole` (`agent-mark-role.ts`) reads the
title of the agent and looks for English or Portuguese word stems, without accents or case. It gives
one of 12 symbols: research, support, finance, calendar, code, content, deploy, review, design,
social, monitor and personal. The list is in order, and the first role that matches wins, so "Revisor
de código" is review and not code. A stem of three letters or fewer must be the full word. A title
with no match has no emblem. The title only selects an entry of a fixed list: no text of the title
goes into the SVG. There is no stored role field.

The mood (`AvatarMood`) sets the lid symbol, the eyelids and the motion:

| Mood | Lid | Eyelid | Eyes | Other motion |
| --- | --- | --- | --- | --- |
| `idle`, `responded` | Nothing | 0.4 | Look round in 7 s, blink every 5.6 s | A slow laser. Only on hover or focus, as the eyes |
| `working` | Three chevrons | 0.1 | 2.8 s, farther; blink every 3.2 s | A laser, four sparks, a halo, two points in orbit (3.2 s); the emblem moves |
| `live` | Equalizer | 0 | 0.62 s, farther still; blink every 1.1 s | As `working`, 2.5 times faster, with a second laser, two halos, eight sparks, three points in orbit (0.95 s); the box bounces |
| `waiting` | Ring with a dot | 0.25 | 5 s | The lid goes pale and back |
| `failed` | × | Closed | Still | The box is red and shakes one time |
| `asleep` | Nothing | Closed | Still | None |

`live` is `working` in the chat that is open. `avatarMoodInChat`
(`packages/ui/src/features/agents/agent-avatar-mood.ts`) changes `working` to `live` on the sidebar
row and the pinned row of the active agent. The chat header, the activity line of the agent chat and
of a channel, and the open chat panel of a diagram show `live` while their agent works.
`avatarMoodIsBusy` counts `live` as busy.

A group of small faces moves only for the members that work. `ChannelAvatar` takes `working`, a set
of agent ids or `true` for all members, and `open` for the open channel (`channelMemberMood`). In the
sidebar, the channel summary only counts the running tasks, so `channelWorkingMembers` takes the
members whose own mood is `working` while the channel runs a task, and every member when no mood
says so. The channel header uses the workers of the activity line, in `live`. The face stacks of an
agent message marker move for each recipient that still runs the message, in `working`: the
recipients work in their own chats. The faces of the other members stay still.

An avatar box of 28 px or less (the `agent-avatar` size container, in `app-shell.css`) does not draw
the orbit, the sparks, the second laser or the emblem: at that size they are noise. Its laser and halo
are wider, so the work still shows. The eyes and the lid symbol stay. The faces of a sidebar channel
cluster (about 19 px) and of the Dynamic Island (20 px) use this rule; the 32 px activity line does not.

With `followPointer` (the team on the first run screen), the pupils turn toward the pointer while it
is in the window, as far as the look around goes, and the eyelids go up to 0.1.
`avatar-pointer-gaze.ts` shares one pointer listener and one animation frame between these avatars,
and sets `--agent-mark-gaze-x` and `--agent-mark-gaze-y` on the avatar box. The look around comes
back when the pointer leaves. Reduced motion keeps the pupils still.

The desktop startup splash (`StartupSplash`) shows the mark at 96 px, `working`, in the logo color of
the build (`var(--openbot-logo-production)` and the dev and preview colors). The web client shows the
crew of `AppLoadingScreen`. The window has no splash before the renderer loads.

The animated avatar uses no filters. No part of the mark and no avatar box has `filter`, and an
ancestor of an avatar that can move must not have `filter` or `backdrop-filter`. A glow is a second, wider stroke or shape in the tone at a low opacity: the
laser is a wide glow path under a bright core (`AgentMarkLaser`), a point in orbit has a disc under
it, and the lit lid and the sparks have a wide stroke under their fill. A photo's mood glow is a
`box-shadow`. A filter on an animated part makes the compositor give it a layer of its own; in the
transparent desktop window with vibrancy, such a layer can paint a rectangle of the app without the
glass while a pointer is on the avatar. The motion only changes `opacity`, `transform` and
`stroke-dashoffset` of SVG parts.

All motion is CSS in `packages/brand/src/logo.css`, only for `data-animated="true"` and
`prefers-reduced-motion: no-preference`. `avatarAnimates` (`agent-avatar-mood.ts`) decides
`animated` for `AgentAvatar`: a busy mood (`working`, `live`, `connecting`), `motion="always"` and
`followPointer` move all the time. `motion="hover"` and `motion="idle"` move while a pointer or the
keyboard focus is on the avatar's control, but only for an avatar wider than 28 px
(`SMALL_AVATAR_SIZE`, measured when the pointer arrives). `motion="still"` never wakes for a pointer:
the faces of a group use it (`ChannelAvatar` in the sidebar rows, the pinned rows and the channel
header, the face stacks and chips of the agent message markers, the stack of the Dynamic Island). A
pointer on a group would otherwise start the motion of every face at once, and in the transparent
window that is the case that showed a rectangle without the glass. So an idle row of the sidebar at
rest does not move: its pupils look ahead and its eyelids stay at 0.4. With reduced motion, or `animated={false}`, nothing moves: the pupils look
ahead, the eyelids stay where the mood puts them, a working lid stays lit with its orbit in place, and
a waiting lid stays pale. A photo avatar does not show the mark. It keeps the breathing and the glow
on its frame.

## Turn steps in the chat

The steps of a turn are its thoughts, the progress lines of the host and its memory changes
(`createTurnSteps`, `src/renderer/src/features/conversation/turn-steps.ts`). While the turn runs,
they show under the activity line (`AgentActivityBody`). After the turn, a row above the answer
holds them (`AgentStepsDisclosure`, `packages/ui/src/features/conversation/AgentSteps.tsx`): the
count of steps, the failed steps and the time of the turn. That row shows the same facts when it is
closed.

The "Show agent steps" setting (`openbot:show-agent-steps` in local storage, per device and browser)
opens the steps only while the turn runs. The rule is in `agent-steps-open.ts`:

- `stepsOpenAtStart`: steps that show for a turn that runs open with the setting. Steps of a finished
  turn start closed, also with the setting: a chat that loads its history, scrolls back or changes
  agent shows each finished turn as one row above its answer.
- `stepsOpenedBy`: a click of the person wins over the setting. The steps are open by the setting
  only when the person did not choose.
- `shouldAutoCollapse`: when a turn changes from running to finished, the steps that the setting
  opened close. Steps that the person opened, also while the turn ran, stay open. Steps that the
  person opens after the end stay open, because only that change closes them.

The timeline keeps the choice of the person per turn (`rememberStepChoice`, at most 200 turns), so
the choice on the activity line goes to the row above the answer, and a row that the list draws
again keeps it. In the agent chat, the row above the answer shows only when the turn ends, so it
starts closed. A channel runs several turns, and the row of a turn that writes its answer can show
while the turn runs; it closes when the turn ends.

The close takes a short transition (`data-closing` on `.agent-steps-panel`), and none with reduced
motion. When the list starts above the visible part of the chat, it closes at once and the chat
scrolls by its height, so the answer stays in place. The virtualizer of the chat already keeps a
row that is all above the view in place. With a trace, a closed row opens the trace; a step picked
in the trace opens the list.

## Browser profile

Agent settings > Advanced selects the browser profile of an agent: Shared or a named profile
that other agents can also use. For a joined server, an owner or admin sees the select when the host
serves `browser-profiles-v1`; the agent summary does not carry the profile, so the panel reads it
from the host. "Only this agent" shows only for an agent that already uses it. A change closes the agent's open tabs. "Manage" opens
the Browser profiles section of the settings of the agent's server (`ServerBrowserProfilesPanel`), which adds,
renames, changes the color of, clears and deletes the named profiles. It lists Shared first, with
its agent count and no actions. A joined server without the capability has no section. The select, the browser toolbar and the tabs show the color of a named profile. A delete moves
the profile's agents to Shared. The agent has no tool to change its profile, and tool results do not
name it. The phone shows the choice in Agent info > Advanced > Browser profile, with "New profile",
which adds a profile and gives it to the agent, and "Manage profiles". The desktop, the web client and
the phone read the profiles again on `browser-profiles-changed` (`browser-profiles-events-v1`). See [Browser sessions](browser.md#browser-sessions) for the storage and the partitions.

## Agent threads

A side thread (in code and on the wire still a **task**) is a separate execution thread of one agent.
The agent keeps one identity, workspace and provider settings; each side thread has its own provider
thread, conversation, queue, progress and result. The agent's own chat is its main thread and has no
side thread row. `projection_agent_threads` (`src/backend/agent-threads/agent-thread-schema.ts`,
migration 47) holds one row for each side thread, with its title and the source of the title
(`auto`, `agent` or `user`). Migration 47 moved every task of `projection_agent_tasks` (migration 38)
there: a closed task became an archived thread, and the task id stays as `legacy_task_id`. The task id
of a side thread is `legacy_task_id ?? thread_id`, so a stored mailbox message and a released client
that name the task still find it. A mailbox message with a `taskId` belongs to that side thread, and `DrainScheduler` drains each task as its own lane. The main chat
lane does not count toward the task limit. At most `limit` task turns of one agent run at the same
time. `agentTaskLimit` gives the limit: the agent's local `taskLimit` setting (1 to
`AGENT_TASK_LIMIT_MAX`, in `agent_json`), else `AGENT_TASK_LIMIT_DEFAULT` (2). An owner or admin of
a joined server reads and sets it on `agent-task-limit-v1`. A provider whose
descriptor has `concurrentTurns: false` (custom ACP agents) gets 1, and its chat and tasks run one
turn at a time. Other task messages wait with a `hold` reason: `task-limit`, `agent-restarting`,
`usage-limit`, `server-busy`, `agent-busy` or `one-turn`. The server-wide `TurnSlots` limit of a
hosted server is separate.

The chat header shows a tab for the main thread and one for each open side thread, a "+" button and a
menu of all threads with an "Archived" group (`packages/ui/src/features/conversation/threads/`). The
user starts a side thread with "+" (a draft tab that becomes a thread with its first message) or moves
a queued message to one ("Run in new thread"). Which tabs are open, their order and the open tab are
kept per device in `localStorage` (`openbot:thread-tabs:v1`, server id → agent id); closing a tab
does not change the thread. Archive is the task close; opening or sending to an archived thread
restores it. Rename sets a `user` title, which later messages do not change. Delete hides the thread
at once and shows an Undo toast; when the toast ends, `AgentService.deleteTask` cancels the queued
messages and deletes the thread with its conversation, attachments, event history and provider
session. It refuses a thread with a running turn. The main thread has no archive, rename or delete.

### Thread preview and details

So that the person does not lose what a thread is for, also after a rename, each side thread keeps
two texts in `projection_agent_threads`: `first_message`, the message that started it (the person's
first message with text, or the brief of a `start_task` thread), and `preview`, the last message with
text that the person sent. Both are the text as written, with its markers, which the UI shows by
name. `messageExcerpt` cuts a text longer than 2,000 characters to 1,999 and adds "…", so the
details show that it continues. `AgentThreadStore.create` writes the first one,
`AgentTasks.setPreview` (from `AgentService.sendMessage`) moves the second one and fills an empty
first one, and a rename changes neither. A message with no text, such as one with only files, changes
neither. Migration 49 adds the two columns and fills them from the stored messages of each thread, in
ranges of 500 rowids, with the same rules: only `user` rows (and the `agent` brief of an agent
thread), not a routine instruction, not a row with no text, not a row whose JSON is not valid, and
the same cut.

The agent's own chat keeps the same two texts in `agent_json`: `AgentStore.firstMessage`, set once,
and `AgentStore.lastUserMessage`. `AgentStore.preview` is a different text: the row's last line,
which an answer or a routine also moves. `AgentStore.updatePreview` takes the person's text from
`AgentService.sendMessage` and writes all three in one roster write. For a chat from before these
fields, `AgentStore.initialize` reads the first and the last message of the person
(`readPersonMessageText`, with the rules of migration 49) before any message can arrive, so a later
message is not taken as the first one. It reads each chat only once: the read sets
`lastUserMessage`, to "" for a chat in which the person sent no text, such as a chat with only
routines. A failed read or roster write does not stop the start; the log has only a count. The
roster carries both texts on each roster change, so the renderer keeps the one-line form of each first
message by its text and reads the Markdown once. `AgentTask.firstMessage`, `AgentTask.preview`,
`AgentSummary.firstMessage` and `AgentSummary.lastUserMessage` are optional on IPC, so a host without
them gives tabs with no preview.

The pointer over a tab (the agent's name for the main thread, and a thread tab of the side panel)
opens a preview card after the chat preview delay: the title, the first message on up to five lines
and the last one on up to three, as plain text. The last one shows only when it is not the same as
the first one. A sidebar row keeps its card of two lines and three. The card stays closed while the
tab menu, a rename, a drag or the details are open, and it opens again only when the pointer comes
back. A tab with no text has none. The selected tab shows an info button before its title, and its
icon slot (state and close) moves to its end. The button, "Thread details" in the tab menu, or in a
narrow header "Thread details" in the thread menu, opens `ThreadDetailsDialog`: the title, the start
time, and the two messages with their lines, each cut to six lines with "Show more", selectable and
with a copy button. A last message that is the same as the first one shows as a note. The focus goes
back to the control that opened the dialog, or to the tab when that control is gone. The button sits
outside the tab list, over the start of the tab, because a tab list can hold only tabs.

The Team API does not carry the texts: `agent-tasks-v1` is frozen and its decoder drops the two texts
of a side thread, and the agent projection of the Team API (`V1_BOT_KEYS`) has no `firstMessage` or
`lastUserMessage`. So a joined desktop and the web show no preview and no details, also for the tab
of the agent's own chat. Sending them needs a new optional capability."Branch from here" (`AgentService.branchTask`, `AgentTasks.branch`, `AgentThreadStore.branch`) makes a
new side thread of the same agent from the last agent message of a finished turn, in the main thread
or in a side thread. The button and the message menu item are off while the source has a running
turn. One dispatch copies the messages through the end of that turn, with new message ids, and writes
one `thread.branched` snapshot event. It copies no usage rows, deliveries or reactions; a reply link
and an attachment move to the copy, and each file is copied as a generated attachment of the branch.
Migration 50 adds `branch_source_thread_id`, `branch_source_message_id` and
`branch_through_message_id` to `projection_agent_threads`: all three are set, or none. The link stays
when its source is deleted. The title is "{source} #N", or the last user message for a branch of the
main thread. The `requestId` of the client makes a retry answer the same branch. The member has read
the copy through its last message, and the new tab opens with focus. A divider "Branched from
{source}" follows the copied messages and opens the source at that message. The thread menu shows
each branch under its source. The branch has no provider session, so its first turn gets a handoff of
its own transcript, with a note that workspace files were not rolled back. A branch counts toward the
open-thread limit.

The agent starts a side thread with the `start_task` Builders Bot tool, up to 8 open tasks. On desktop and
the web, it opens as a tab of the agent and does not take focus. An agent has at most 50
open tasks (`INPUT_LIMITS.agentTasks`, the size of the task list), so each open task stays visible. A message to a
running task waits in the task, or steers the turn when the agent's busy-message mode is "steer"
and the provider steers natively, as in the main chat. Stop interrupts the task turn; close moves
the task to "Closed" on the phone and to "Archived" on desktop and the web when no message of it waits, starts or runs, and reopen moves it back. Boot recovery registers the task threads and
starts queued tasks again. When a task's provider session ends, the next session gets a handoff of
that task's own transcript, as the main chat does; channel threads still get none.

A joined desktop, the web client and the mobile app reach the tasks of a server through the optional `agent-tasks-v1`
capability (`packages/contracts/src/team-protocol/agent-tasks-v1.ts`, host route
`src/main/team-api/route-agent-tasks.ts`). Its routes are `POST /v1/agent-tasks/{list,read,start,send,stop,close,reopen}`
with the ids in the body. A member who can send a message to the agent can use them; no role is
checked, and the member is the sender of a start and of a message. A hidden agent, or one that the
peer cannot see, answers 404. A start and a message carry text only, and "Run in new thread" stays local.
Files go through `agent-thread-files-v1`, below.
The host sends the task events (`agent-tasks-changed`, `agent-task-conversation`,
`agent-task-conversation-delta`) in their local shape, only to a peer with the capability, and not
for a hidden agent. The optional `agent-threads-v1` capability
(`packages/contracts/src/team-protocol/agent-threads-v1.ts`, host route
`src/main/team-api/route-agent-threads.ts`) adds `POST /v1/agent-threads/{rename,delete}` with the
agent and task ids in the body. They need the `chat` agent level; a hidden agent answers 404. A server
with only `agent-tasks-v1` shows threads with no rename or delete. The optional `agent-thread-reads-v1`
capability (`packages/contracts/src/team-protocol/agent-thread-reads-v1.ts`, host route
`routeAgentThreadReads` in `src/main/team-api/route-agent-threads.ts`) adds `POST /v1/agent-threads/{reads,read}`: the member's read
mark of each open side thread, and a move of one. The marks are rows of `projection_thread_reads`
under the side thread's own `threadId`, so the member's devices share them and no migration was
needed. A desktop marks the open thread read while its window has focus (`markTaskRead` over IPC, or
the route for a joined server); the phone marks it while the thread screen is in front, and shows a
dot on the agent's name for an open thread with unread agent messages. The host sends no event when
a mark moves; a client reads the marks again when `agent-tasks-changed` arrives or a screen that
shows them opens. The optional `agent-thread-files-v1` capability
(`packages/contracts/src/team-protocol/agent-thread-files-v1.ts`, host route `routeAgentThreadFiles` in
`src/main/team-api/route-agent-threads.ts`) adds `POST /v1/agent-threads/{start-with-files,send-with-files}`:
a start or a message with up to 10 attachment drafts that the member uploaded with `POST /v1/attachments`,
and text that can be empty. The answers are the frozen `agent-tasks-v1` task and receipt. The team client
uses these routes only for a message with files, so a message without files still works on an older host.
A joined desktop refuses files for a server without the capability with `error.backend.threadRemoteUnsupported`,
and the phone shows the plus in the thread composer only on a server that has it. The optional
`agent-thread-branches-v1` capability (`packages/contracts/src/team-protocol/agent-thread-branches-v1.ts`, host
route `routeAgentThreadBranches` in `src/main/team-api/route-agent-threads.ts`) adds
`POST /v1/agent-threads/{branch,branches}`. `branch` takes `{agentId, taskId|null, messageId, requestId}`, needs
the `chat` agent level as a start does, and answers the frozen `agent-tasks-v1` task with its `branch` link. The
member is the reader of the copy. A source or message that is not there is 404; a running source or the open-thread
limit is 409. `branches` answers `{branches: [{taskId, sourceTaskId, sourceTitle, sourceMessageId, throughMessageId}]}`,
the links among the listed tasks. `sourceTitle` is null for the agent's own chat and for a deleted source; the
list can leave out an archived source, so the divider takes its title from the link. The `agent-tasks-v1` task and its events stay without the link: a joined desktop and
the web read `branches` after the task list and add the links, and read the list again when an event names a task
that they do not know. A server without the capability does not show "Branch from here", and a joined desktop
refuses a branch with `error.backend.branchRemoteUnsupported`. The phone does not branch. A server without either shows only
the main thread, and a task control there fails with `error.backend.taskRemoteUnsupported`. Prompts, approvals and warnings of a task turn show in the main chat. On desktop and the web, the
approval of a side thread turn also shows in that thread. A provider
error of a task turn goes to the task: `AgentTasks` stores the redacted text in the task's `error`
column, and the next turn of the task clears it. The thread shows it after a restart too.

On desktop and the web, a task opens as a thread in the chat header. The Tasks rail page
(`packages/ui/src/features/tasks/TasksPage.tsx`, `src/renderer/src/features/tasks/`) lists the tasks of all
agents of the active server and opens a task beside the list in `AgentThreadView`, the view of a thread tab.
The panel archives, restores and opens the task in the chat. A read there marks the thread read. A running
task that waits for an approval, a question or a browser takeover goes to Needs you; the chat answers a
question or takeover, so the panel links there. The Tasks page and the phone share the section and title
rules in `@openbot/team-client/agent-tasks`.
On the phone, the server drawer opens the Tasks screen (`apps/mobile/src/app/(app)/server-tasks.tsx`) when
the host serves the capability. A task opens as a full screen (`apps/mobile/src/app/(app)/task/[taskId].tsx`)
with the message list and header of the agent's chat, the task actions in place of the browser
button, and a composer without files. The task events write the cached task lists and conversations
(`apps/mobile/src/features/workspace/model/task-cache.ts`). The phone answers the questions of a task turn (`POST /v1/prompts/respond`, which finds the question
by its request on any thread); it does not show task attachments. The turn, question, approval and
takeover events of a task carry the task's thread, so the phone keeps them out of the activity row of
the agent's chat (`withoutTaskTurns`). The chat shows a row for each open task under the agent's activity
instead, as on desktop: a finished task stays with its result until the person closes it, and a tap
opens the task.

Shared writes: each task thread owns its own browser tabs and tab queue. Computer Use is an MCP
server that the provider starts, so Builders Bot cannot queue its calls; `ThreadLifecycle` starts a task
session without it, and the instructions send desktop work to the agent's own chat. Tasks share the
workspace, and Builders Bot does not lock files; the `start_task` guidance warns the agent about this.

A provider, account or custom-agent change that a user or an agent asks for while a turn, a task or
a queued message waits is stored on the agent as `pendingRuntime`. The running work keeps its
sessions. When the drain is about to start the next message and no work has started,
`AgentService` applies the queued runtime first (the `next-turn` move), then retires the provider
sessions of the chat and of each task thread, so each one gets a handoff on the new provider. A
queued change that fails on an idle agent, such as for a provider that is now off, is removed. An
update that also changes other fields, a move to a backup model, a Team API request (its released
protocol has no `pendingRuntime`), and the automatic usage-limit, provider-error and endpoint moves
still wait for idle work (`error.agent.waitForTasksBeforeProviderChange` /
`error.agent.waitBeforeProviderChange`). A Team API model or effort change keeps the queued
change, because the remote client cannot see it. The channel threads of the agent
(`ChannelStore.contextThreadsForAgent`) are retired too, and their work steps are saved. A channel
turn also carries its own self-contained context packet. The instance transfer file keeps `taskLimit`.

## Forced queued messages

Each row of the queue above the composer has "Force now" (bolt icon) beside steer, "Run in new thread",
delete and edit. Steer adds the message to the running turn. Force stops the running turn and starts the
message in a new one. `AgentService.forceQueuedMessage` calls `QueueControls.force`, and
`QueueForce` (`src/backend/agent/queue-force.ts`) owns the order of the steps:

1. It refuses a message that does not wait in the agent's own queue, a message that another editor
   holds, and channel, messaging and task work (`QueueForceRefused`, with a sentence for the person).
2. `MailboxStore.moveToQueueHead` puts the message first among the person's messages, also before a
   message that another editor holds. Channel, messaging and task work keeps the head: it reserved the
   agent before. Every client of the host gets the new queue (`queue-changed`).
3. `DrainScheduler.startAlone` marks the message, so its turn starts without the person's later queued
   messages. They stay queued and start after it, in queue order.
4. It finds the turn that holds the agent's own chat: of the chat itself, or of a channel or messaging
   thread of the same agent. It never stops a turn of another agent. With no turn, the drain starts
   the message now (`started`). It stops the turn as the Stop button does, so the partial work stays in
   the conversation, and the drain that the end of that turn schedules starts the message
   (`interrupted`).

The request names the chat turn that the person saw (`expectedTurnId`), or null. A chat turn that the
person did not see, such as the turn of the next queued message that started in between, is not
stopped: the message waits at the head (`next`). A channel or messaging turn shows in the chat only as
a hold, with no turn id, so a request with null stops it; the channel task then pauses with
`error.backend.channelTaskStopped`, and the load panel can resume it. When the turn ends between the
click and the Stop, no stop is sent and the drain starts the message once. When the Stop fails, the
queue gets its order back and the person sees `error.backend.forceStopFailed`; the message stays
queued. A second force of the same message waits for the first one and gets its answer, and a later
one sends no second Stop while the stopped turn ends. The start-alone mark is in memory only.

The composer asks first, with "Don't ask me about this again". That choice is stored for each device
and browser (`src/renderer/src/force-send-preference.ts`), and "Ask before forcing a message" in
Settings › General, and in the web client's Preferences, turns the question on again. A joined server
forces through `queue-force-v1` (see [servers](servers.md#queue-force)). A host without it keeps the
button, turned off, with a tooltip that says to update the server.

## Agent communication policy

The shared developer instructions keep routine teammate exchanges internal by default. Agents
should start or resume work without narrating setup, context loading, discovery, or readiness.
Progress updates focus on meaningful outcomes, completed work, material changes, blockers, failures,
and required user input or approval. Delegated work still needs an explicit reply to the requesting
teammate; acknowledgements must not become loops. Relevant findings belong in the task result, and
the user can ask for a detailed coordination report.

An agent does not refuse a task, or say that it has no access to a service, before it tries each
path. When the task is outside its profile, or names a service that a teammate may own, it calls
`openbot.list_agents` first and delegates to a teammate whose name, title or description covers
the work. In a channel task it delegates only to a channel member. MCP servers are host-global, so
a specialist teammate differs only by its profile, skills and memories. Otherwise the agent uses its
connected MCP servers, its skills, the embedded browser and Computer Use.

A sign-in page does not stop it: it calls `openbot_browser.request_takeover`. The request shows in
the agent's conversation, and in the dynamic island when the agent's notifications are on, also for
delegated work. A routine run reports the sign-in instead, because nobody may answer; a requester in
a routine run says so in the delegated message. The tool returns only after the user answers, which
can take minutes. The end of the turn cancels the request, so the agent keeps waiting for the result,
also when the provider returns control while the call runs. In the smoke runs, Codex `exec` did this
about every 30 seconds. After an error or a cancel, the agent does not point to a takeover window.
When the agent reaches a service in the browser and the plugin for it is not in its tools, the answer
ends with a fixed sentence: install the plugin in Marketplace, on the Apps tab, or enable it in MCP
servers. The sentence names both actions because `read_agent` and the agent's tools show only enabled
servers, so an agent cannot tell a disabled plugin from a missing one.

When the user asks for it, an agent adds, changes, turns on or off, tests and removes MCP servers with
the MCP server tools (`src/backend/agent/mcp-tools.ts`, issue #2673). Each change waits for the
approval of `AttentionRegistry.awaitToolApproval`, which states that every agent on the server gets
the tools. Full access answers it, as for other built-in tool approvals. `save_mcp_server` connects
before it saves (`inspectMcpServer`, the silent Test): a server that does not answer is not saved; a
server that needs an OAuth sign-in or a key is saved. The tools never take or return a header or
environment value, and show an address without its query: the user enters a key in Server settings,
MCP. An edit keeps the row's headers and environment, and an edit that would send them to another
transport, origin, command, arguments or folder is refused. The approval masks known secrets in the command line and names
the folder a stdio server starts in. A sign-in shows an `mcp-sign-in:<id>` card in
the conversation. Its Sign in opens Server settings, MCP, and starts the row's normal sign-in, so a
joined server signs in through its relay or live page. Continue sends a message that tells the agent
to test again. A saved change reaches the agents from their next turn.

When its own tools fail, the agent checks its teammates. When a teammate reports that it is blocked
or waits for the user, the requester does not repeat that work or send the same request again; it
gives the user the blocker and the unblock action. A blocked task reply adds a fourth line,
`Unblock:`, after Status, Result and Evidence. The delivery text of that reply
(`src/backend/agent/delivery-content.ts`) repeats the report rules, because the requester reads it
at the moment it answers. An earlier failure does not stop the agent from asking that teammate for
a new request. It never sends a task back to the teammate that gave it. The answer that gives a
delegated result starts with the teammate's name, and the agent does not say that a service was
checked unless a tool result or a reply shows it. When nothing works, the agent says what was tried
and the one action that unblocks it; for a service with a plugin, that action is to install or
enable the plugin. It can offer to create a specialist teammate, but it creates one only after the user agrees.

An agent that delegates work can follow and stop it. `openbot.list_agents` reports each agent's
description to 300 characters (`read_agent` returns all of it), its
`status` (a starting delivery and a context compaction count as `working`), `queuedMessages`
(channel work excluded), `turnStartedAt`, and `lastActivityAt`. The last two come from the provider
notifications that `TurnLifecycle` sees; they are in memory only, so after a restart
`lastActivityAt` falls back to the newest message for the agent. Builders Bot does not record which
files a turn changed. `openbot.interrupt_agent` (`src/backend/agent/agent-interrupt-tool.ts`)
refuses the caller itself, a channel turn, and a turn that any delivery other than the caller's
started, so an agent cannot stop work from the user, a routine, or another agent. It cancels the
caller's queued requests to the target before it sends `turn/interrupt`, because the interrupted
turn drains the queue as it completes. It keeps the caller's answers, because the target can hold
them (see below). Then it queues a notice from the caller with `expectsReply` false. The notice
starts one short turn on an idle target, so the provider thread records why the work stopped.

An answer to a request that went to two or more teammates waits in the requester's queue while
another teammate's copy of that request is queued, starting or running (`MailboxStore.nextQueued`).
When the last copy ends, the waiting answers start in one turn, and the prompt names each teammate
whose copy ended with no answer. A message from the person does not wait: it starts at once and
takes the answers that are already in. Each end of a copy schedules a drain for the requester.

A message from another agent follows the recipient's busy-message mode, as a message from the
person does. When the mode is "steer", the provider steers natively and the recipient runs a chat
turn, `send_message` and the result relay take the message into that turn
(`AgentService.#steerAgentMessage`). Channel, messaging and task work, and each answer to a request
that went to two or more teammates, stay queued (`MailboxStore.steersChatTurn`), so those answers
still start together. A message from an agent that cannot steer gets no fallback reason on its row.
The person can steer any queued answer into the running turn from the waiting block on desktop, the
web and mobile; it has no other queue action. That is the person's choice, so it can take one answer
of a group before the others.

This policy lives in `src/backend/agent/developer-instructions.ts` and is supplied on both thread
start and resume. Codex receives `developerInstructions`; Claude and Pi append them to the system
prompt; Grok and the other ACP agents receive them as a tagged instruction block in normal turn
input; Muse puts them first in the turn input. ACP and Muse send them only when the session lacks
them: on the first turn of a new or reopened session, after a change, after a compaction or a failed
turn, and, for an ACP agent that reports no context size, every 10 turns. There is no model-specific
verbosity setting or response filter. Delivery is tested, but compliance depends on the provider,
model, and existing conversation context; Grok's input block is not a dedicated system message.
Restarting the app reapplies the current policy without deleting conversation history. The policy
does not hide mailbox records, tool activity, approvals, or failures in desktop or mobile clients.

### Model evaluation scenarios

Run these scenarios in an isolated test profile with two agents, separately for Codex, Claude, and
Grok. Record provider/model versions, prompts, and observed responses. Repeat collaboration after
an app restart using the same conversation, including one with earlier verbose coordination.
These are manual model evaluations, separate from the fake-provider lifecycle regression tests.

| Scenario | Expected behavior |
| --- | --- |
| On a new conversation, ask an agent to research a topic with one teammate. | Work begins without a setup, discovery, or readiness monologue. |
| Exchange routine scope clarifications and acknowledgements during that task. | No user-facing message-by-message recap or acknowledgement loop. |
| Have the teammate finish its research and send findings back. | The requesting agent receives the result; the user receives a concise useful synthesis. |
| Have the teammate report a failed step, a blocker, or a finding that changes the recommendation. | The user sees the consequence and any required decision. |
| Include a step that requires approval or clarification. | The existing approval/question flow remains visible and the agent waits for the answer. |
| Restart the app, then ask the agent to continue the same task. | Work continues with the same policy and no context-loading recap. |
| Ask explicitly for a detailed account of teammate coordination. | The agent provides the requested detail. |
| Make a teammate whose description owns Notion, then ask a general agent about a Notion page. | The general agent delegates to the Notion teammate. Its answer starts with the teammate's name. |
| Ask the same question with no Notion plugin installed. | The Notion teammate opens Notion in the browser and requests a takeover for sign-in. When sign-in fails, the answer says what was tried and to install the Notion plugin. |

## Prompt-driven agent profiles

Users create and edit agent profiles by asking an agent in the normal desktop or mobile
conversation. `openbot.create_agent` creates a persistent teammate with instructions and a first
task; `openbot.update_profile` changes an existing agent's name, title, instructions, generated
or custom avatar, provider, model, reasoning effort, account, backup models, access, Computer Use, or notifications. `avatarPath` accepts a local PNG, JPEG, or WebP file up to 512 KB, with relative
paths resolved from the calling agent’s workspace. The agent uses its available tools to resize or
compress a copy when needed. Builders Bot validates the prepared file before profile changes and copies
it into managed avatar storage. Generated avatar settings remove the custom image. Both run through
the existing agent service and validate arguments before changing state.
`openbot.create_agent` also accepts an optional `provider`, `model` and `reasoningEffort`. The
read-only `openbot.list_models` returns the models of each provider that the model picker shows, with
their reasoning efforts and the default model for a request that names only a provider. With no
`query`, a provider lists its default model, the models that local agents use as their model or as a
backup model, then its first catalog models up to 8 models in total; `omittedModels` counts the
others. A `query` searches all models by the words of their id or name and returns 20 at
most. `create_agent` and `update_profile` still accept each catalog model, and an unknown model
error names the same short list. A provider
that can hold more than one account also lists its accounts, with the provider's own sign-in
(`default`) first: the id, the name the user gave it (or null), and the state. It never lists the
account email, credentials or account folders. `update_profile` takes the
agent's `providerAccountId` and its `backupModels` (`automatic` and an `order` of provider, model
and account), the same choices that the settings page offers. Builders Bot checks each backup model and
account against the lists before it writes, and the agent service checks the primary account; an
account change, like a provider change, waits until the agent is idle. These changes apply at once,
as the other profile fields do. `read_agent` and the `update_profile` result return the account,
the backup models and `usageLimitReturn`, the model that the agent left for a usage limit or a provider error (`cause: "provider-error"`). An unknown
model or an unsupported effort is an error that names the valid values; Builders Bot checks them before
it creates the agent. Without a provider and a model, the new agent starts on the calling agent's
provider, model and reasoning effort, so a team that one agent creates runs where that agent runs.
When the caller's provider no longer lists its model, the new agent starts on the user's default.
Creation stays this small. The calling agent then configures the new agent, or any other local
agent, with the same tools that act on itself. `openbot.read_agent` returns one agent's setup:
profile, runtime, access, Computer Use, notifications, auto-approve, installed skills, routines,
and the names and transports of the MCP servers it gets. It does not return MCP commands,
environment values, URLs, or headers, because they can hold secrets. `install_local_skill`,
`set_skill_enabled`, `uninstall_skill`, and the routine tools take an optional `agentId`; without
it they act on the caller. `uninstall_skill` never removes skill files that the user changed.
`openbot.update_agents` gives several agents the same provider, model, reasoning effort, access,
Computer Use, or notifications setting in one call. Each agent gets the checks of `update_profile`
and its own `updateAgent` write, in order. A failure for one agent does not stop or undo the others,
and the result reports `ok` with the new settings, or the error, for each agent id. A provider or
model that is not listed fails the whole call before any write.
An agent can only restrict access and Computer Use, for itself or a teammate. The router writes
only a restriction, so a user change between its check and the write is never undone. Only the
user widens them again, and only the user moves an agent between Ask first and Full access, and changes local script runs. An agent changes MCP servers only with the MCP server tools, after the user's request and approval. A new agent gets
the access and Computer Use limits of the agent that creates it, so a Workspace-only agent cannot
get around its sandbox through a teammate. There is no creation step for skills or routines in
the UI.
The other providers receive the dynamic tool definitions; Claude exposes the same operations through
its SDK MCP bridge. `src/backend/openbot-tools.ts` owns the tool names, descriptions, and Zod
argument shapes used by both declarations. It reuses the profile, section, and routine schemas.
Claude uses the SDK’s `AskUserQuestion` flow instead of the `ask_user` MCP tool.
There is no separate prompt-generation button or review dialog.

Agents can organize teammates into flat sidebar sections through `list_sections`, `create_section`,
`rename_section`, `delete_section`, and `assign_agent_section`. Assignment accepts a null section
to ungroup an agent; deleting a section also ungroups its agents without deleting them. These tools
use the same `SidebarLayoutStore` as manual sidebar edits, including persistence, validation,
and change events delivered to desktop and connected clients.

A custom section can have a box color: `SidebarSection.color`, a `#rrggbb` value in lower case.
No field means no color. The section menu sets it with the `set-section-color` action of
`mutateSidebarLayout` (presets, or a custom color from the system picker). The parser, the store
and `isSidebarLayoutSnapshot` refuse any other value. The layout file keeps version 2, so an older
build still reads it. A color in the file that is not valid is dropped, and the section stays.
Delete removes the color with the section; Duplicate gives the copy the same color. The color is
local only: the frozen Team API codecs drop it from each section and refuse the action, so a remote
client does not see it and the desktop shows the menu item only for the local server. The renderer
draws the color as a light tint (`sidebar-section-color.css`); a section with no color has no new
attribute or style.

A custom section can also have a rail icon: `SidebarSection.icon` is one or two characters, a glyph
name of a fixed table (`SIDEBAR_SECTION_GLYPHS` in `ipc-sidebar-section-glyphs.ts`), one emoji, or a
PNG or WebP `data:` URL of at most 40 KB and 96 × 96 pixels (`ipc-sidebar-section-icon.ts`). No field
means the first letter of the name. The section menu and the menu of the rail item open the icon
editor, which saves the `set-section-icon` action. Its tabs are Letters, Icon, Emoji and Image.

The Icon tab is a library of 434 `lucide-solid` icons, which the app already has. The table keeps
the 24 glyphs of the first editor first, and their names; each other name is the Lucide name. A name
in the table stays: a removed name makes each saved icon with it invalid. The rail draws the 24 first
glyphs at once; the other drawings (`packages/ui/src/section-icon-library.ts`, in the primitive layer
because only that layer imports `lucide-solid`) and their English and Portuguese names
and keywords (`section-icon-library-data.ts`) load with `import()` the first time the editor or a rail
mark needs them. The Emoji tab lists 1,906 emoji of Emoji 16.0 and before in nine categories, drawn in
the system emoji font. Its names and keywords in English and Portuguese come from emojibase-data 17.0.0
(MIT), which takes them from the Unicode CLDR annotations; `section-emoji-data.ts` holds a compact copy
and also loads with `import()`. Both tabs search the names and keywords of both languages, in lowercase
and without accents (`section-icon-search.ts`), show the recent choices, and draw a listbox grid of
eight columns that renders the first rows and adds more while it scrolls. The emoji tab has a skin tone
choice: the tone goes after each person or hand of the sequence, and the data marks an emoji as toned
only where that rule gives the five Unicode sequences. The recents and the tone are a convenience of
the browser profile, so they stay in `localStorage` and each read checks each value
(`section-icon-recents.ts`).

`isSidebarSectionEmoji` takes an emoji icon only when it is one grapheme (`Intl.Segmenter`) of at most
32 UTF-16 code units that is one emoji sequence: a flag, a keycap, or `Extended_Pictographic` code
points joined by ZWJ, each with an optional variation selector and skin tone. Text, two emoji and markup
are refused. The layout stores the emoji as text and the rail draws it as text, so no markup reaches
the page.

The editor takes a file from "Choose image…", a file dropped on the dialog, or a pasted image (the first image
only). It reads a PNG, JPEG, GIF or WebP file of at most 10 MB, or an SVG file of at most 512 KB, from
this computer. The crop editor (`SidebarSectionIconCrop.tsx`, geometry in `section-icon-crop.ts`) moves
and zooms the image in a 200 px frame, from Fit to 4× (more for a long image, to Fill), with an
optional light or dark fill. Save draws the frame on a canvas of 96 px, as WebP or PNG; when the result
is larger than 40 KB, it tries 80, 64 and 48 px and asks for a second Save. The app's Content Security
Policy allows `data:` images and refuses `blob:` images, so the editor makes no object URL for an
image: it decodes a PNG, JPEG, GIF or WebP file with `createImageBitmap` and shows a copy of at most
1,024 px as a `data:` URL (without `createImageBitmap`, it reads the file as a `data:` URL). An SVG
file is only an input: the editor refuses it when it is not an SVG document, has a script, a
`foreignObject` or a `javascript:` address, or links to a web address, and loads it in an `<img>` from
a `data:image/svg+xml` URL (no markup goes into the page). Each failure has its own message (format,
size, damaged file, SVG with a script, SVG with a link), with the browser error below it. The stored icon is never an SVG, and no icon
is a URL to fetch. The parser, the store and `isSidebarLayoutSnapshot` check the kind, the characters,
the image type (PNG or WebP only), the bytes and the pixel size. An icon in the file that is not
valid is dropped, and the section stays. Duplicate copies the
icon. As the color, the icon is local only: the frozen Team API codecs drop it and refuse the action,
so a remote peer shows the letter.

The section rail (`SidebarSectionRail.tsx`) is the column at the left of the sidebar: "All", one item
for each custom section in the layout order, "Unassigned" while it holds a chat, and a plus button.
The plus button, Rename in the menu of an item, and each "New section" item while the rail shows open
one name dialog (`SidebarSectionNameDialog.tsx`); the rail selects a new section. The menu of a custom
section item has "Change icon…" and "Change color…" where the server keeps them, then Rename and
Delete (`sidebarSectionRailMenuItems`). "Change color…" is the color submenu of the section menu: each
color applies at once, so the tile shows it while the menu stays open. The tile shows the color as a
tint and a line; an image tile takes the color on its line. Each item shows one
badge: a wait for the user, the unread messages, or work in flight. It reads the agent states, channel
waits and channel counts that the rows read. The rail keeps its item list while no badge, count or
section changes (`sameSidebarSectionRailItems`), so a change of an agent state does not run the rail
or the list filters again.

On the local server (as for the color and the icon), a section item of the rail drags up or down to
reorder the sections: the native drag starts after the pointer moves, so a click still selects. The
dragged item shows as a lifted copy, the items between slide by one place, a rail that scrolls
scrolls near its ends, and Escape cancels. Alt+Arrow moves the focused section by one place, and a
polite live region says the new position. "All", "Unassigned" and the plus button do not drag and take
no drop. The drop sends the `move` action of the section list (`sidebarSectionRailMove`), so the rail
and the list keep one order. With reduced motion, the items do not slide.

The rail shows only on the Agents page (Agents and Routines), Workflows and Schedule
(`sectionRailShowsOn`); another page has no rail column. The selection is the same on the four pages.
A selected section filters the pinned strip, Needs you, the sections and Hidden to the chats of that
section. Global search shows a switch at the top while a section is selected on a page with the rail:
"This section", the default at each open, keeps the agents, channels, routines (by the agent that runs
them), messages and files of that section; "All sections" finds every chat. Messages and files come in
pages for every agent, so the search filters each page in the client, counts only the results that
show (not the total of the source), and loads more pages while too few results show
(`global-search-scope.ts`). ⌘S (Ctrl+S) in the search field moves focus to the switch. From the
Routines view, search opens on its Routines tab. The selected section is always open, also when the user
collapsed it under "All", and its header does not collapse it; "All" shows the saved collapse state
again. Routines lists the agents of the section. Schedule keeps the routines whose owner, the agent or
the channel, is in the section. A workflow has no owner, so Workflows keeps the workflows with an agent
step of an agent in the section (`workflow-sections.ts` reads the graph of each workflow while a section
is selected); a workflow with no agent step shows only with "All". This computer keeps the selection
for each server (`openbot:sidebar-section-rail:v1`), and a section that is gone reads as "All".
Settings > General > Left column (`openbot:left-column`) shows the sections, the default, or the
server rail. With the sections, the menu on the server name lists the servers, Add server and the
server actions.

A pinned tile (`SidebarPinnedGroup`) shows the avatar and the name in the middle of the tile, with the
same space on each side (`--pinned-tile-pad-x` and `--pinned-tile-pad-y` in `app-shell.css`). The tile
keeps its size in every state, so the highlight does not move the strip. It has no title chip: the
full name, the title and what the chat waits for show in an app tooltip on hover and on keyboard
focus, and the label of the tile reads the name and the title. Three tiles fit in a row of the default
sidebar width.

The activity filter (the button beside the search field, `sidebar-activity-filter.ts`) keeps one kind
of chat: the channels with work in flight, the agents with work in flight, or the agents and channels
that finished recently. The three choices exclude each other. "Finished recently" has a window of 24
hours (`SIDEBAR_RECENT_WINDOW_MS`) and reads data that the list already has: for an agent, no work in
flight and the newest message of its own chat (`updatedAt`) in the window; for a channel, no task in
flight, no wait, and a newest message (`lastMessage`) in the window that is a complete agent reply. A
host without channel-attention-v1 sends no author and no status, so for it the newest message counts
whoever wrote it. The open chat stays listed under a filter that lists its kind. While a filter is on,
the button has a dot, and a notice sticks to the bottom of the list: the filter, how many chats it
hides in the selected section, and "Show all", which turns the filter off. The notice is a polite live
region. The search field opens the global search and does not filter the list, so "Show all" has no
search to clear.

In the Routines view, the same button shows the routine filter (`sidebar-routine-filter.ts`) in place
of the activity filter: Active routines, Paused routines, Created recently and Edited recently. The
choices exclude each other. "Recently" is 7 days (`SIDEBAR_ROUTINE_RECENT_WINDOW_MS`); "Edited
recently" needs an `updatedAt` after `createdAt`, so a new routine counts only as created. The list
keeps the agents of the selected section with at least one routine that matches, and the open agent.
There is no "Finished recently" choice: a routine has no time of its last run, and the client has no
cheap source for it. Each view keeps its own filter, and the sidebar applies only the filter of the
view that it shows (`sidebarActivityMenu`), so a filter cannot stay on where its menu cannot turn it
off. The routine lists come from the turns domain (`routinesByConversation`): the filter loads every
agent once when it turns on or when the Routines view opens with it on, then only the agents that join
the list; a `routines-changed` event keeps each list current. A client that does not set the routine
filter (the web client) keeps the activity filter in the Routines view.

A marker is a thin line with a short text in a section of the list (`SidebarMarker`,
`SidebarMarkerRow.tsx`). "+" > New marker adds one at the top of the section that the rail selects;
with "All", at the top of the first custom section, or with the chats with no section when there is
none. Its editor opens at once. The editor sets the text (at most 40 characters, with the suggestions
Done, Soon and Waiting) and the style of the chats below it, up to the next marker: normal, dimmed,
black and white, or a tint of a preset color (`#rrggbb`). The open chat, a row under the pointer and
a row with the focus keep their full strength. A marker drags as a chat does. A section can have 12
markers. An activity filter hides the markers, and the compact list shows a line with no text.

Only the local layout keeps markers. The layout has `markers` and `itemOrder`, which holds the chats
and the markers in one sequence; `agentOrder` is that sequence without the markers, so a reader of
`agentOrder` gets the same chat order. The four actions (`create-marker`, `update-marker`,
`delete-marker`, `move-marker`) and the order rules are in `@openbot/contracts/sidebar-markers`, which
the store, the preview mock and the stories share. In a layout with markers, `move-agent` can drop a
chat before a marker. The parser, the store and `isSidebarLayoutSnapshot` check each field; a marker in
the file that is not valid is dropped, and the sections and chats stay. Deleting a section deletes its
markers. The frozen Team API codecs drop `markers` and `itemOrder` and refuse the marker actions, so a
remote peer sees the chats in their order and no marker. An older version reads the file and drops the
markers at its next save. Instance transfer copies the section names and assignments only, so it
does not copy the markers.

`html_render` publishes a visual reply: an HTML page that shows above the agent's reply. The router
stores the page as a generated `text/html` attachment and adds an assistant message with the item
type `visual-reply:<height>` and the page title as its text (`@openbot/contracts/chat-visual`). A
client that does not know the item type shows the title and the file. A visual message is not
readable: unread counts, latest-message previews and mobile read state skip it. The desktop serves
the page on `openbot-visual:` (`openbot-remote-visual:` for a remote host) with
`Content-Security-Policy: sandbox allow-scripts allow-forms` and the frame script, and the frame has
the same sandbox without `allow-same-origin`. The page runs its scripts and can load files from the
network, but it has an opaque origin, gets no permission, and talks to the app only with the checked
messages of `parseChatVisualMessage`: its height, its theme, its display mode, a link, a message, its
context, an image and an app shortcut. The frame script gives the page `window.openbotPage`
(`sendMessage`, `setContext`, `requestFullscreen`, `exitFullscreen`, `displayMode`) over the MCP Apps
methods `ui/message`, `ui/update-model-context` and `ui/request-display-mode`. A link, a message, the
context, an image, full screen and a shortcut need the frame to have the focus and the user's
activation, so a page acts only after a click or a key in it. A message goes at the end of the draft,
and the user sends it. The context is a quote tag of the visual message
at the start of the draft, so it shows as a quote chip and is saved and sent with the draft; the
page's next context replaces it. Full screen puts the frame's
box in the top layer with the Popover API, so the frame does not load again; it exits before the app
opens a dialog for the page. Only the renderer's allowlist of shortcuts (`chat-visual-shortcuts.ts`)
leaves the page, as a key event on the frame element. Mobile runs the
page in its own react-native-webview `WebView` (`html-page-view.native.tsx`), in the chat at the agent's
height with no touches, and on the preview screen. It gets the base styles and the app theme from
`chatVisualDocument` with `bootstrap: false`, from a string at `about:blank`, and a
`form-action 'none'` policy. The view has no `onMessage` and injects no script, so
react-native-webview adds no message handler or JavaScript interface, and the page cannot reach the
app; never run a page in an Expo DOM component, which has a bridge to the app. A
tapped web link opens in the browser, and the page goes to no other address. A link opens only
within a second of a touch: Android WebView asks the app only about main-frame GET loads and gives
no cause, and WebKit calls a script `click()` on a link a click. iOS keeps the page storage in memory (`incognito`); Android turns off DOM storage
and third-party cookies, because its `incognito` clears every web view of the app. An Android build
without the native module shows the page with no scripts. `html_preview` lets the agent look at a page before it publishes it: the main
process draws it in a hidden window with its own in-memory session (`ChatVisualPreviewer`)
and returns a PNG, the content height and the console lines. The file preview shows an HTML file in
the same frame. On desktop, a shared or workspace HTML file preview gives the client a temporary
`openbot-visual://preview/<token>` page URL beside its bytes. `FilePreviewPages` keeps only local HTML
that already passed the existing file-access checks, in a bounded in-memory registry. The page
protocol accepts only an opaque token, never a file path, and uses the same sandbox response as
HTML attachments. The server-owned preview state releases its page on replacement, close or
disposal; stale preview responses release their unused pages. Main clears the registry before an
application-controlled renderer load, after a main-frame document navigation commits, when the renderer
exits, or when its web contents are destroyed. Cancelled navigations retain the live renderer's pages and
deep-link readiness. A generation captured before file resolution prevents old requests from registering
pages after a clear. Accepted
addresses remain valid until release or clear, including when the user switches to source and back. At
most eight pages can be held. A full registry or a page above the existing 8 MB limit falls back
to source. Only local file previews use this HTML MIME override; attachment imports keep their
existing MIME types. Downloaded remote files keep their existing preview path and are not registered here.
`FilePreview` is local IPC data; this optional field does not cross the Team API or change its frozen adapters.

Codex fixes dynamic tools at provider-session creation; resume does not update them. A local
`provider-toolsets` manifest records the tool fingerprint for each new Codex session. Sessions with
missing or outdated fingerprints are replaced before the next turn, using the existing history
handoff while retaining the public thread, agent identity, workspace, and stored conversation.
Unchanged fingerprints resume the existing session. Pending history handoffs are written before
the replacement is bound, reloaded after restart, and removed after a turn accepts the handoff.

The same handoff carries a chat to another provider after a provider switch. It holds the user and
assistant messages after the last context-reset marker, with attachment names only. Builders Bot stores
no tool steps, so the work log comes from the providers. At the switch, before the old sessions are
retired, `ThreadLifecycle.readWorkSteps` reads each active session with the provider history read
through the client that holds it, with a 10-second limit. The switch then checks again that no turn started.
Only after the switch is stored, `saveWorkSteps` writes the rendered steps of the 60 newest turns to
`provider-work-steps/v2/<sha256(session id)>` (mode 0600), or `{}` for a session with none. The sessions
are retired before the write, so a turn that starts during it keeps its new session and reads the
provider instead. The file is
deleted and reconciled with the other session files, and a file that does not parse counts as no
capture. The handoff does not read a provider. A session without a capture, such as one that no
client held, gives no steps. `readCapturedSteps` (`src/backend/agent/handoff-tool-steps.ts`) renders
the work log: commands with exit code and output tail, changed file paths, tool
calls, searches and progress notes. The handoff adds the steps of each turn that matches a
transcript message. Each field is redacted before it is cut, and each turn has a
size limit. Reasoning, diffs, images and other provider-private state stay with the provider that
made them. A failed capture leaves that session's steps out. Codex returns tool steps from
its stored rollout. Claude returns only notes. An ACP agent keeps only the text and thinking of its
turns, so it also gives only notes, and only while its process holds the session.

The optional `agent-profile-generation` Team API endpoints remain available. They use a separate
provider client with tools restricted and validate drafts before returning them. Their save path
retains its recovery and retry guarantees:

A profile-creation marker is written before its workspace or agent row. Startup removes
uncommitted creations before mailbox initialization and queue draining, while a committed
retry receipt preserves the agent and its introduction. The existing sidebar reconciliation
removes assignments for recovered incomplete agents.

Reviewed instructions use the existing profile description. Profile saves coordinate
SQLite with the separately stored sidebar layout, rolling back section assignment
on failure. Updating an existing profile and its retry receipt shares a SQLite
transaction. Creation follows the existing workspace/initial-message flow with
cleanup on failure. Receipts make retries after a lost response return the saved
agent. This does not introduce a schema migration or alter released protocol codecs.

## Agent instruction file

An agent keeps its standing rules (persona, style, steps) in one file at the root of its workspace:
`AGENTS.md`, or `CLAUDE.md` when only that file exists. The profile description is a short summary
for teammates and the Team API; it keeps its meaning and its 2,000-character limit.

- `src/backend/agent/workspace-instructions.ts` finds, reads and saves the file. A link that goes
  outside the workspace is refused. A save writes the first file that exists, else it creates
  `AGENTS.md` with mode 0600. An existing file keeps its mode; a hard link to it is replaced by a
  new file. A save never deletes the file.
- The editor sends the text that the edit started from. When the agent changed the file after
  that, main refuses the save. The editor keeps the user's text, says that the agent changed the
  file, and a second Save replaces the agent's version.
- The agent settings show the file as "Instructions" for a local agent only
  (`agentInstructions` IPC group). The row in the Knows group opens a page
  (`AgentInstructionsView`): a bar with the file name, its folder, Show in Finder and Edit, then
  the file as Markdown. Edit puts the whole file in a field on the page that saves only on Save.
  Show in Finder sends only the agent id; main finds the file, or the workspace when it has none.
  The Team API does not carry the file.
- `InstructionsChanges` (`src/backend/agent/instructions-changes.ts`) reads the file when the first
  turn of an agent starts and again when a turn ends. When the text changed, the turn ends with an
  `instructions-change` system line, "Updated its instructions". The baseline is one per agent, so
  two turns at the same time show the change once. A save in the editor moves the baseline, so
  the user's own edit does not show as the agent's. A turn that a restart settles shows no line.
- The line carries `instructionsChange` (`before`, `after`) when both texts fit the editor limit.
  The message stays in `projection_thread_messages.message_json`, so no migration is needed. The
  Team API projections do not copy the field: a remote client sees the text only. View opens the
  Instructions page, and does not show in a channel; Undo saves `before` with `after` as the expected text, so main refuses it after a later
  change. A save on the page or an Undo updates the page and each line of the same agent. The
  unread counts skip the line.
- The developer instructions name the file and tell the agent to keep its rules there.
  `workspaceInstructionFiles` in the provider descriptor lists the files that each CLI reads by
  itself from its working directory. `ThreadLifecycle` adds the text of the file, at most 32,000
  characters, only when the CLI does not read that file. Claude in workspace-only mode reads user
  settings only, so it gets the text.
- The text is redacted, and a `</agent_instructions>` tag in it is escaped.
- Codex keeps the instructions of a loaded session: the developer instructions, and the
  `AGENTS.md` that it read when the session started. The Codex tool fingerprint therefore includes
  the file name when it is not `AGENTS.md`, and the file text. A change to the file starts a new
  Codex session. Other providers read the file again when they start or resume a session.

## Agent import

Server Settings > Import moves agents from a `.zip` export into the local host, or into a remote host
that serves `agent-import-v1` (see [Agent import from a joined server](servers.md#agent-import-from-a-joined-server)).
The format is `openbot-import.json` plus `agents/<key>/`
folders. `resources/agent-import/grok-bot/SKILL.md` writes it and `src/main/agent-import-manifest.ts`
reads it; both are a product contract, so add only optional fields and raise `version` for a change
of meaning. The renderer never names a path: `agent-import:choose` opens the dialog in main, and
`AgentImportService` keeps the checked export and its SHA-256 under a single-use token; `apply`
refuses a file that changed. `stage` measures entries without inflating them and rejects paths that
`isUnsafeArchivePath` in `skill-package.ts` refuses or that name a Windows drive. `apply` checks all
skills of an agent, creates it through `AgentService` and publishes skills through the local skill
library; an agent whose step fails is deleted with the skill revisions it published, and the others
continue. An optional `channels` list carries Grok Bot group chats. After the agents, each selected
channel is created through `ChannelService.command` as the local user (`host.channelActor()`), with
the members and lead mapped to the new agent ids; a channel needs one imported member, and one whose
memory step fails is deleted. Step 1 offers two ways to add the export agent: its Grok Bot link, or the skill set up by hand.
`agent-import:read-skill` and `agent-import:save-skill` give that skill from the app's resources
(`extraResources` in `electron-builder.yml`); main opens the save dialog, so the renderer names no path. No schema change is needed.

## Instance transfer

Server settings > Transfer moves a server's agents and server settings to another Builders Bot server with
one `.zip` file. It is a separate format from the Grok Bot agent import. The first screen offers "Export
from this server" and "Import into this server". The section shows for this computer's server, and for a
joined server with `instance-transfer-v1` when the user is an owner or admin (see
[Instance transfer with a joined server](servers.md#instance-transfer-with-a-joined-server)). The web
client and mobile do not show it. App preferences, the default model and the providers that are off
belong to the app, not to a server, so they are not in the file.

The file has `openbot-transfer.json` at its root, `agents/<key>/` folders (`avatar.<ext>`,
`skills/<slug>/` and `workspace/`), and `shared/` for `~/Builders Bot/Shared`. The manifest is
`{ format: "openbot-instance-transfer", version: 1, source, agents, settings, shared, signedIn }`.
`src/main/instance-transfer-manifest.ts` writes and reads it with Effect `Schema`; it is a contract
between app versions, so add only optional fields and raise `version` for a change of meaning. A file
with a higher `version` is refused. An invalid agent is left out with a warning and the others are
offered; invalid settings are left out the same way.

Each agent carries its profile (name, title, instructions, avatar seed and image), provider, model
and reasoning effort, notifications and busy-message mode, its routines (schedule, limit and missed
policies; one-time routines are in the optional `oneTimeRoutines` field, so an older app skips them and
keeps the agent), its memories (with the essential or searchable choice the user made) and the skill folders
in `.agents/skills` and `.claude/skills` that Builders Bot does not manage. Workspace files are optional
and leave out `.openbot/`, the skill folders, links, and every path `isUnsafeArchivePath` refuses
(`.git`, `node_modules`, `.env*`, private keys, nested archives). Server settings are optional: MCP servers,
custom model providers, custom ACP agents (as a warning, see below), sidebar sections and routine flows
between exported agents. A custom provider model keeps its optional `contextWindow`; an app that
does not know the field ignores it.

No secret is in the file: MCP variable and header values are empty, custom providers have no key or
headers, custom agents keep only the names of their variables, and `signedIn` lists provider ids,
never tokens. Arguments and URLs can hold a token too, so the export empties the value of a flag or
`name=value` argument whose name says it is a secret, and removes the user, password, query and
fragment of a URL, also of a URL in an argument such as a connection string. An MCP address keeps only
its origin, because some services keep the access key in the path; `cleared` names each item it changed, and the import asks for those values again. Chat history, messaging connections, connectors, team and account sessions, browser
data, approval automation and the per-agent access, Computer Use and automation settings are not
exported, so an imported agent gets the defaults of a new agent on the new computer. Shared tables
(`Shared/Data/agent-data.db`) are left out because their owners are agent ids.

`InstanceTransferService` (`src/main/instance-transfer-service.ts`) writes the archive one file at a
time, stored and not compressed, to `<name>.zip.part`, and renames it when it is complete. Import uses
the same checks as the agent import (`src/main/agent-archive.ts`): the file stays under a single-use
token with its SHA-256, under 2 GB and 50,000 files. `apply` first adds the custom providers that are missing. It never saves a custom ACP agent:
a saved custom agent starts its command to list its models, so a warning names the agent and its command,
and the user adds it again after checking it. The models of an added provider are not listed yet: a save does not wait for
model discovery, and the provider has no key until the user enters it. So an agent on such a model starts
on the default model, and a warning asks the user to choose it again when the provider is ready. Then it creates each selected agent through
`AgentService` and the local skill library. Files go to the workspace root, and a name that is already
there is saved beside it. Like the export, the import never writes `.openbot/` or the skill folders. An agent whose step fails is deleted with the skill revisions it published,
and the others continue. A model that this computer does not offer, or whose provider is off, leaves
the agent on the default model with a warning. Last, it adds MCP servers whose name is new, turned off, because a file can name any command, creates
missing sidebar sections by name and assigns the new agents, connects routine flows with the new
routine ids, and copies Shared files that are not already there. The result lists the providers that
were signed in on the other computer and are not signed in here, each with a sign-in button.

## Agent templates

An agent template is a link-only copy of one local agent: the name, title and instructions, the
avatar, the routines, marketplace skills as references to approved versions, and local skills as
their `SKILL.md` text. It has no workspace files and no memories. The Publish button in the chat
header opens `PublishAgentDialog`; `src/main/agent-template-service.ts` builds the snapshot, stops
when a text field looks like a secret, and posts it to the Account Worker. The Worker keeps one row
per account and local agent in D1 `agent_templates`, so a second publish updates the same link.
Unpublish clears the row's content and images and sets `unpublished_at`, but keeps the row, so the
same agent published again gets the same link. An account can have up to 5 published agents; the
Worker checks this in the statement that writes the row, so a client or two requests at once cannot
pass it, and unpublished rows do not count.
There is no review and no marketplace listing. Before a publish, the renderer draws a 1200×630 share
card (`agent-template-card.tsx`) with the agent's avatar and text. It draws it there because the
avatar and its fonts are there, and it uses a `data:` URL because the Content Security Policy
refuses `blob:` images. The Worker accepts only a PNG of that size, stores it in R2, and serves it
as the page's `og:image`, so a post on X shows the agent. `openbot.run/agents/<id>` is a public
card page, tinted with the avatar colour. The Bloub library uses browser-only APIs when its module
loads, so the page loads the avatar and its colour in the browser after hydration. Its button opens
`openbot://agents/<id>`, the third renderer link kind in
`src/main/deep-link-router.ts`. The app then shows the template in `AgentTemplateInstallDialog`;
like a plugin link, the link itself installs nothing. The page's fallback line also links
`/app?agent=<id>`, where the browser client shows the same preview. In the same way, the invitation
page links `/app` with the four invitation fields, and a plugin page links `/app?plugin=<slug>`. The
browser client removes these fields after it reads them and opens the join dialog or the marketplace
listing. It never joins or installs without a press.
