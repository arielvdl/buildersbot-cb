# The task reviewer

The task reviewer ("Fiscal" in Portuguese, "Task reviewer" in English) watches the tasks of the
channels. It finds work that is parked for too long and tries to move it, one task at a time. It is
experimental and off by default. In code its name is `task-watch`, so that it does not clash with
the reviewer model of the [Guard](guard.md) or with the [message reviewer](prompt-injection-guard.md).

It is not a second automatic recovery. "Resume by itself" (`AutoRecovery`, see
[Stopped work and its recovery](channels-and-messaging.md#stopped-work-and-its-recovery)) starts
stopped tasks again. The task reviewer covers the work that "Resume by itself" does not see:

- **A run that gives no sign of life.** The task says Working (`running`), but the provider sent no
  event (no text, no tool step, no usage update) for a long time. The run holds one of the limited
  places for agents, so other tasks wait behind it.
- **A request that waits too long.** The task says Requested (`queued`), the drain of its channel
  would start it now, but it did not start. A request that waits for a reason is not parked: see
  the list of holds below. `ChannelService.queuedHolds` gives the reason of the drain for each
  request, with the same checks as the drain.
- **A start that fails again.** The task failed with "The provider could not start this
  assignment" (`error.backend.channelStartFailed`). The app already tried it again by itself and on
  a backup model ([start retry](agents.md#start-retry)), so the reviewer follows the task until it
  starts: a resume, then a reassign and a resume by turns, with a cap.

## When it runs

It looks only when both switches are on: "Resume by itself" and "Task reviewer (experimental)". The
timer of `WorkControl` looks every 60 s. The reviewer looks after `AutoRecovery` in the same look,
so it sees what `AutoRecovery` did.

Its log is `logs/task-reviewer/task-reviewer.log` in the user data folder (`startTaskReviewerLog`,
1 MB with one rotated copy). It has the lines of the loggers `task-watch`, `auto-recovery` and
`mac-memory`:

- "The task reviewer looks." or "... does not look.", once at each change, with the two switches;
- each decision, with the action, the kind of task, the reason, who decided and the minutes;
- for a look that decides nothing, "The task reviewer waits.", with the count of tasks in each state,
  the holds (such as `memory:2,attention:1`) and the minutes until the next one is due. It goes to the
  log when it changes, and again every 10 minutes, so at most one line each look;
- the actions of "Resume by itself" and the commands of both that failed;
- each change of the memory level of the Mac, which holds new turns and requests.

No line has a name of a channel, a request or the words of an agent. Before 1 November 2026 these
loggers wrote to stdout only, which an app started from the Dock does not keep, so nothing on the
computer showed whether the reviewer looked or acted.

## Local rules first

The local rules use no network. For each watched task they find the last sign of life:

- A run: the newest of the start of its turn and the last provider event of its agent
  (`AgentService.taskWatchSignals`). The provider clock is per agent: an event of another turn of
  the same agent also counts as a sign. When the task has no turn yet, the time when the reviewer
  first saw it in that state counts.
- A request: the time when the reviewer first saw it queued at its current revision. A resume gives
  the task a new revision, so the wait starts again. When the drain gives the request an
  assignment, the clock of that assignment starts.
- A hold stops the clock. A look that finds a hold counts as a sign, so the time with no sign counts
  from the last look that found a hold. A request that a full cap held for an hour is not stalled
  when the place frees and the drain starts its turn.

With `N` the threshold that the person sets ("consider it stopped after N minutes with no sign"):

| Time with no sign | Class | What happens |
| --- | --- | --- |
| Less than `N` | healthy | Nothing. A long run that gives signs is never touched. |
| `N` to `2 × N` | slow | The model can decide. With no model, the reviewer waits. |
| `2 × N` or more | stalled | The reviewer acts. |

Two cases change the table:

- A run whose agent has a work step that started and did not end (`TurnLifecycle.hasOpenWorkStep`,
  `src/backend/agent/open-work-steps.ts`): a command, a tool call, a file change or a compaction. A
  long build or test run sends no event while it runs. Such a run is slow from `N` to `4 × N`
  (`OPEN_STEP_STALL_FACTOR`), and stalled only from `4 × N`. Text (a message or a reasoning) is not
  a work step: a stream of text that stops is a stall.
- A request whose start is under way: the drain gave it its own assignment, and the turn did not
  start yet (`ChannelQueueHold` `starting`). It has no slow band: it is stalled only from `2 × N` on
  the clock of that assignment. A turn that waits for a place under the cap is held (`slot`).

`N` is 15 minutes by default, from 5 to 120. A provider sends events every few seconds while a
turn works. A long command with no output, such as an install, a build or a test run, is the usual
cause of a quiet run; 15 minutes covers most of them, and the reviewer acts only at 30. Less than 5
minutes would catch ordinary long commands. More than 120 minutes lets a dead run hold a place for
hours, and the reviewer then does not help.

A task is never touched when:

- the person stopped it on purpose (see [A stop by the person](#a-stop-by-the-person));
- its agent waits for the person: a question, an approval or a browser takeover
  (`AttentionRegistry.hasAttentionFor`);
- the memory of the Mac is `critical`. For a request, also when it is `low`: new turns wait then,
  and so does the reviewer. A run is left alone only at `critical`, because a memory that is often
  low would stop the reviewer;
- a task below it works (`queued`, `running` or `waiting`): a resume would start that work again;
- its agent has a spent plan;
- for a request: the lane runs another channel, or another channel is next in the lane; its agent
  waits for a free place (`slotWaitingAgents`); the cap on agents is reached; its agent runs another
  turn or has a queue (`agent-busy`). When that other turn is stalled, the reviewer acts on the
  turn, not on the request;
- for a request, any other reason of the drain (`waits-for-work`): a dependency that is not
  complete (`channel_assign` with dependencies), a tab with `CHANNEL_PARALLEL_LIMIT` (2) runs, a
  browser or workspace that another run holds, an older request that waits for the same resource,
  an assignment of its owner in another place, a root task that stopped, or a lead or owner that is
  hidden;
- it acted on the task less than one interval of "Resume by itself" ago, or it gave up on it.

## Sleep of the computer

While the computer sleeps, no provider sends an event, so at the wake every run seems quiet for as
long as the sleep lasted. Before, the first look after an hour with the lid closed found each run
stalled and acted on one of them at once, while the network and the providers were not back yet.

With the advanced optimization `fiscal-resume-grace` on (Settings › General › Advanced
optimizations (beta), off by default; see [optimizations.md](optimizations.md)), a sleep holds every
watched task for two looks (`SLEEP_GRACE_LOOKS`):

- A sleep is the `resume` event of Electron's `powerMonitor` (`WorkControl` gives it to
  `TaskWatch.noteResume`), or more than 3 minutes between two looks (`SLEEP_GAP_MS`, three looks of
  60 s), so a timer that slept shows a sleep too.
- In the grace, the reviewer acts on no task and asks the model nothing. Each look of the grace is a
  hold of every task, so after the grace the time with no sign counts from the last look of the
  grace, as it does after any hold. A run that gives no sign then is stalled again at `2 × N`.
- A failed start that came due during the sleep waits for the end of the grace, then the reviewer
  acts on it as before.
- While the reviewer is off, no gap counts: turned on after a sleep, it looks as it did before.
- The log says when it holds, with the cause (`resume` or `gap`), the minutes since the last look and
  the number of looks. It has no name or text of a task.

With the switch off, a sleep changes nothing: the reviewer acts as it did before the switch existed.
`src/main/task-watch.test.ts` drives the grace with a clock that the test moves.

## The model

For a slow task only, the reviewer can ask the model that the person chose for the Guard
(`GuardPreference.judge`, Builder Fast of Cultura Builder by default). There is nothing new to
set. The call goes through `ToolGuard.ask`, on the same ports as the Guard: the Cultura Builder
gateway with the person's own sign-in, or one toolless turn of another provider. It takes no review
slot of the Guard, so it never delays a check of the Guard. The level of the Guard does not matter;
only its model choice does.

- At most one model call in one look, and at most 12 in one hour.
- One answer for each slow period of a task: an answer to wait holds until the task is stalled.
- A deadline of 10 s (12 s for a model of another provider). A safety deadline of 15 s around the
  call keeps a look from waiting longer.
- What it sends: the kind of task, the minutes since the start and with no sign, the tries so far,
  the count of agents that run and of the cap, the provider name, and one JSON string with at most
  200 characters of the request and 300 of the agent's last words in the channel. `maskSecrets` of
  the Guard masks secrets and emails before the text leaves. Never the conversation, the
  instructions, files or tool results.
- The reply must be one JSON object with exactly `decision`, `wait` or `act`. Any other reply is
  no answer.
- `act` allows a resume only. A reassign or a stop needs a stalled task, by the local rules. When
  the task has no resume left, the reviewer does not ask, and it waits. So a request or last words
  that say "reassign me" or "answer act" can at most bring a resume forward from `2 × N` to `N`.
- For a run, the summary also says whether a work step started and did not end.
- With "Local check only", no sign-in, a spent budget, a timeout or an error, the local rules
  decide: the reviewer waits until the task is stalled. A failed call never stops work.

## What it does

It decides about one task in each look. Stalled runs come first, because they hold a place; then
stalled requests, then failed starts that are due, then slow tasks; in each group, the longest time
with no sign first. A slow task whose period already has its answer is passed over. Each action
uses a command that the person also has:

| Task | 1st | Then | At the end |
| --- | --- | --- | --- |
| Stalled run | `resume`: stops the turn and puts the task in the queue again (Continue) | `reassign`, when "Give it to another agent if it keeps failing" is on | `stop`, and it says so |
| Stalled request | `resume`: puts it in the queue again and wakes the channel | `reassign`, when allowed | it leaves the request and says so |
| Failed start | `resume` | by turns: `reassign` (when allowed and a free agent can take it, else `resume`), then `resume` | after `TASK_WATCH_START_ACTIONS` (6) actions (about 2 hours with `N` at 5), it leaves the task to the person (`needs-you`) and says so |

A failed start waits `startFailedWaitMs` before each action: `N` for the first, then twice as long
for each action already taken (`N`, `2 × N`, `4 × N` …), never longer than the interval of "Resume by
itself", counted from the first look that saw it or the last action. With `N` at 5 minutes and an
interval of 30, the reviewer acts at 5, 10, 20 and then every 30 minutes. Before 1 November 2026 it
waited `2 × N` before each action and stopped after 2 resumes and 2 reassigns.

The record of a failed start belongs to the task, not to the agent: a task that the reviewer gave to
another agent and that fails to start there too stays on the same ladder. The reviewer follows it
until it starts; then a run or a request is watched as any other one, and a task that completes loses
its record. The times of its actions are in `LedgerRecord.startActions` (times only).

While the app tries a start again (`ChannelQueueHold` `retrying`, `TaskWatchHold` `retrying`), the
task is a request held by `retrying`: the clock of the reviewer stops, and "Resume by itself" does not
see it, because the task is `queued`. Only a start that failed after all its tries and its backup
model comes to the reviewer.

- The tries of a run or a request are the tries of "Resume by itself": one `RecoveryLedger` for both, with
  `MAX_RESUMES` (2) and `MAX_REASSIGNS` (2) for each task in all. A failed start has its own cap (above). So a task cannot loop between
  the two. The reviewer writes a record when it acts, and for each failed start. It does not renew
  the record of a task that works well, so the record is forgotten `RECORD_RETENTION_MS` (6 hours)
  after the last action or stop, and a task that completed loses its record at once.
- When the reviewer gives up on a request, the mark is its own, for that task and revision. The
  shared ledger does not get it, so when the task runs and stops later, "Resume by itself" still
  tries it, and the stopped row does not say that it gave up.
- While the reviewer is on, failed starts are the reviewer's: "Resume by itself" leaves them out.
- A reassign takes a free agent of the same channel with the same model, else the same provider,
  never an agent that it tried for that task (`autoReassignee`). A free agent runs no turn, waits
  for no place, holds no channel assignment and has no queue. With no free agent, a run is stopped
  at the end of its tries and a request is left; it is never moved to an agent that is busy.
- The command gives a task to the queue. The drain of each agent starts it, so the cap on agents and
  the lane still decide when. The reviewer never starts a turn by itself.
- Immediately before the command applies, it reads the task again. When the state or the revision
  changed, or a run gave a new sign, the command is dropped and counts as no try. A command that
  fails counts as a try, as in "Resume by itself".
- It never throws. A look that fails is logged, and the next look runs as usual.

## What it shows

The reviewer has two places in the window. Both read and change the same preference through the same
calls (`app:get-load`, `app:set-task-watch`, `app:set-auto-recovery`), from one store: `LoadProvider`
(`src/renderer/src/features/load/load-context.tsx`) holds the one load controller of the window, which
the ring of the rail, the Team view and Settings share. A change in one place shows in the other at
once. The rail shows the ring only while this computer's server is active; the Settings page asks the
store to read the load while the page is on screen, also when a joined server is active. When the ring
comes back to the rail, such as on a switch back from a joined server, the store reads at once.

### Settings, Task reviewer

Settings has a page of its own, "Task reviewer" ("Fiscal" in Portuguese), after the Guard
(`SettingsTaskReviewerTab.tsx`). The settings search finds it by "Fiscal", "Revisor", "Task
reviewer" and related words, in the interface language and in English. The page shows:

- the switch, and the state now: off, on but waiting for "Resume by itself", or active. When it
  waits, a button turns "Resume by itself" on. The page says that "Resume by itself" also starts
  again the tasks that the person stopped (see [A stop by the person](#a-stop-by-the-person)): the
  reviewer does not touch them, "Resume by itself" does;
- the threshold, "consider it stopped after N minutes", as a list of values from 5 to 120. A value
  that the load page set and the list does not have is added to the list;
- the model: the review model of the Guard, by name, and whether it can run now (`judgeReady` of the
  Guard state, the same reading as the name), with a button to the Guard page;
- the two switches of the load page that it follows, "Resume by itself" and "Give it to another
  agent if it keeps failing", with the interval of "Resume by itself", and a button that opens the
  load page of Settings;
- "Why it waits": each task that it watches now (at most 20, `TASK_WATCH_WAIT_LIMIT`), by channel
  and kind, with when it can act ("Acts in 8 min if no sign comes", "Tries again in 4 min", "Acted
  lately; can act again in 22 min"), the hold that keeps it waiting ("Waits: the agent waits for
  you", "the Mac is low on memory", "another channel goes first"), or that it gave up. It comes from
  the last look (`TaskWatch.waits`, `watchOutlook`), by the local rules. A slow task can get a resume
  sooner from the model; that is not shown;
- "What it did": its last 20 actions (`TASK_WATCH_RECENT_LIMIT`), with the time and who decided (the
  model or the local rules). They stay after a restart, in `openbot-task-watch-history-v1.json`;
- what it does and what it does not do, in plain words.

The Guard page links to this page, and this page links to the Guard page. The load page has a
button "Task reviewer settings" under the reviewer's switch. The ring of the rail opens the load page,
and takes the focus back when Settings closes.

### Load page

On the load page of Settings, in the section of "Resume by itself":

- the switch "Task reviewer (experimental)", also while "Resume by itself" is off, with its hint
  that it acts only while "Resume by itself" is on. While it is on, a line says it uses the model of
  the Guard, or that only the local rules decide now;
- the threshold, "consider it stopped after N minutes with no sign";
- its actions in "Lately", beside those of "Resume by itself", the newest first, such as "Task
  reviewer: gave Pagamentos to Writer (no sign for 32 min)". The pointer over a line says whether
  the model or the local rules decided. "Resume by itself" keeps its last 5 actions and the reviewer
  its last 20, and the list shows 6 (`loadRecentEvents`). A "waited" line comes once for each slow period of a task.

A running row that is slow or stalled shows the minutes with no sign. Each stopped row of the load
page says what the app does next and when (`StoppedWork.plan`): for a failed start while the reviewer
looks, the reviewer ("The task reviewer resumes it in 6 min", "... gives it to another agent ...",
"The task reviewer waits: the agent waits for you", "The task reviewer gave up after 3 tries"); for
other rows, "Resume by itself" (see [Stopped work and its
recovery](channels-and-messaging.md#stopped-work-and-its-recovery)), and "Needs you" for a task that
a resume cannot fix and no agent can take.

The log (`task-watch`) records the action, the kind of task, who decided (local or model) and the
minutes. It never records the request, the agent's words or the reply of the model.

## A stop by the person

The stored task does not tell a stop by the person from a stall. A Stop sets `paused` with the
reason `error.backend.channelTaskStopped`, and a turn that ends interrupted for another reason sets
the same. So:

- The reviewer never acts on a stopped task with that reason. It acts only on runs, requests, and
  tasks with a failed start.
- `ChannelService.observeCommands` tells `WorkControl` each command before it applies. A `stop`
  that `WorkControl` did not send itself is a stop by a person: the Stop of a channel, of the load
  panel, or of a member of the team. `WorkControl` keeps the operation id of each of its own
  commands until the command applies. The `work-auto:` start of those ids only makes the logs easy
  to read: a client can send any operation id, so it proves nothing. The reviewer then does not
  touch that task or a task below it for the rest of the run of the app, also when "Resume by
  itself" started it again. A `resume` or `reassign` by the person removes the mark.

## Settings

The preference is `openbot-task-watch-v1.json` in the user data folder:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The switch. |
| `quietMinutes` | `15` | `N`, from 5 to 120. |

A file that is missing, damaged, of another version or with a value out of range reads as the
default. Its last actions are in `openbot-task-watch-history-v1.json` (`createTaskWatchHistoryStore`):
at most 20 events with the time, the channel name, the action, the reason, the agent name, the
minutes and who decided. Never the request or the words of an agent. A damaged file reads as no
action, and an event that does not decode is left out. The window sets it with `app:set-task-watch`; the answer is the load snapshot, which
carries `taskWatch` (the preference, `active`, `modelReady` and `recent`).

## Known limits

- The tries, the waits and the stops by the person are in memory. A restart forgets them; only the
  list of the last actions stays. Turned off and on again, a request in the queue waits anew.
- A turn that ends interrupted for another reason, such as the Stop of the agent's own chat, is not
  a stop by the person for the reviewer. It is `paused`, so the reviewer does not act on it, but
  "Resume by itself" can start it again, and then the reviewer watches it.
- The memory hold stays as it is: at `low`, a request waits, because the drain holds new turns
  then, and a resume or a reassign only puts it in another queue that waits too. A run and a failed
  start are held only at `critical`. "Why it waits" shows the hold.
- The provider clock is per agent, not per turn, and a restart loses it.
- A long command with no output for more than `4 × N` minutes is restarted. Set a larger `N` for
  work like that.
- When the provider does not answer the interrupt of a resume, the old turn can stay in the
  running turns while its task is queued again. Its task then waits behind it (`agent-busy`), and
  no running task points to that turn, so the reviewer does not see it. The Stop of the running row
  in the panel ends it.
- The reviewer watches channel tasks only, not the chat of an agent.
- "Resume by itself" has no grace after a sleep: it acts on stopped work at its own interval, which
  a sleep does not change. The grace of `fiscal-resume-grace` is the reviewer's only.
- The reviewer runs in the host process of each server. The window sets the reviewer of this computer
  only. A joined server, or a second server on this computer, has its own reviewer and its own file,
  and no Team API route reads or sets them. While the window shows such a server, the Settings page
  says that it changes this computer only, and the General section of that server's settings says
  that this app cannot change its reviewer yet. Setting it from a client needs a new admin capability
  of the Team API (such as `task-watch-v1`), which is not decided.
- "Resume by itself" still starts a task again that the person stopped. That is its own behavior,
  and this change does not alter it.
