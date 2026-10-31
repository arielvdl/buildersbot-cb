# The task reviewer

The task reviewer ("Revisor" in Portuguese, "Task reviewer" in English) watches the tasks of the
channels. It finds work that is parked for too long and tries to move it, one task at a time. It is
experimental and off by default. In code its name is `task-watch`, so that it does not clash with
the reviewer model of the [Guard](guard.md) or with the [message reviewer](prompt-injection-guard.md).

It is not a second automatic recovery. "Resume by itself" (`AutoRecovery`, see
[Stopped work and its recovery](channels-and-messaging.md#stopped-work-and-its-recovery)) starts
stopped tasks again. The task reviewer covers the work that "Resume by itself" does not see:

- **A run that gives no sign of life.** The task says Working (`running`), but the provider sent no
  event (no text, no tool step, no usage update) for a long time. The run holds one of the limited
  places for agents, so other tasks wait behind it.
- **A request that waits too long.** The task says Requested (`queued`), but it did not start, and
  nothing that the person set holds it: the one-channel-at-a-time lane, the cap on agents, the
  memory hold, a spent plan, or its own agent that works on something else.
- **A start that fails again.** The task failed with "The provider could not start this
  assignment" (`error.backend.channelStartFailed`), it was started again, and it failed again. A
  second try on the same agent does not help, so the reviewer goes to another agent, or stops.

## When it runs

It looks only when both switches are on: "Resume by itself" and "Task reviewer (experimental)". The
timer of `WorkControl` looks every 60 s. The reviewer looks after `AutoRecovery` in the same look,
so it sees what `AutoRecovery` did.

## Local rules first

The local rules use no network. For each watched task they find the last sign of life:

- A run: the newest of the start of its turn and the last provider event of its agent
  (`AgentService.taskWatchSignals`). The provider clock is per agent: an event of another turn of
  the same agent also counts as a sign. When the task has no turn yet, the time when the reviewer
  first saw it in that state counts.
- A request: the time when the reviewer first saw it queued at its current revision. A resume gives
  the task a new revision, so the wait starts again.

With `N` the threshold that the person sets ("consider it stopped after N minutes with no sign"):

| Time with no sign | Class | What happens |
| --- | --- | --- |
| Less than `N` | healthy | Nothing. A long run that gives signs is never touched. |
| `N` to `2 × N` | slow | The model can decide. With no model, the reviewer waits. |
| `2 × N` or more | stalled | The reviewer acts. |

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
- for a request: the lane holds its channel, its agent waits for a free place
  (`slotWaitingAgents`), the cap on agents is reached, or its agent runs another turn. When that
  other turn is stalled, the reviewer acts on the turn, not on the request;
- it acted on the task less than one interval of "Resume by itself" ago, or it gave up on it.

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
| Failed start, not tried | `resume` | | |
| Failed start, tried | `reassign`, when allowed | | it leaves the task and says so |

- The tries are the tries of "Resume by itself": one `RecoveryLedger` for both, with
  `MAX_RESUMES` (2) and `MAX_REASSIGNS` (2) for each task in all. So a task cannot loop between
  the two.
- While the reviewer is on, failed starts are the reviewer's: "Resume by itself" leaves them out.
- A reassign takes an agent of the same channel with the same model, else the same provider, never
  an agent that it tried for that task (`autoReassignee`).
- The command gives a task to the queue. The drain of each agent starts it, so the cap on agents and
  the lane still decide when. The reviewer never starts a turn by itself.
- Immediately before the command applies, it reads the task again. When the state or the revision
  changed, or a run gave a new sign, the command is dropped and counts as no try. A command that
  fails counts as a try, as in "Resume by itself".
- It never throws. A look that fails is logged, and the next look runs as usual.

## What it shows

In the load panel, in the section of "Resume by itself":

- the switch "Task reviewer (experimental)", with a line that says it uses the model of the Guard,
  or that only the local rules decide now;
- the threshold, "consider it stopped after N minutes with no sign";
- its actions in "Lately", beside those of "Resume by itself", the newest first, such as "Task
  reviewer: gave Pagamentos to Writer (no sign for 32 min)". The pointer over a line says whether
  the model or the local rules decided. Each of the two keeps its last 5 actions, and the list shows
  6 (`loadRecentEvents`). A "waited" line comes once for each slow period of a task.

A running row that is slow or stalled shows the minutes with no sign. A stopped row that the
reviewer gave up on shows "Gave up after its tries".

The log (`task-watch`) records the action, the kind of task, who decided (local or model) and the
minutes. It never records the request, the agent's words or the reply of the model.

## A stop by the person

The stored task does not tell a stop by the person from a stall. A Stop sets `paused` with the
reason `error.backend.channelTaskStopped`, and a turn that ends interrupted for another reason sets
the same. So:

- The reviewer never acts on a stopped task with that reason. It acts only on runs, requests, and
  tasks with a failed start.
- `ChannelService.observeCommands` tells `WorkControl` each command before it applies. A `stop`
  that is not from the automatic code (`work-auto:` operation ids) is a stop by a person: the Stop
  of a channel, of the load panel, or of a member of the team. The reviewer then does not touch
  that task or a task below it for the rest of the run of the app, also when "Resume by itself"
  started it again. A `resume` or `reassign` by the person removes the mark.

## Settings

The preference is `openbot-task-watch-v1.json` in the user data folder:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The switch. |
| `quietMinutes` | `15` | `N`, from 5 to 120. |

A file that is missing, damaged, of another version or with a value out of range reads as the
default. The window sets it with `app:set-task-watch`; the answer is the load snapshot, which
carries `taskWatch` (the preference, `active`, `modelReady` and `recent`).

## Known limits

- The records are in memory. A restart forgets the tries, the waits and the stops by the person.
  Turned off and on again, a request in the queue waits anew.
- A turn that ends interrupted for another reason, such as the Stop of the agent's own chat, is not
  a stop by the person for the reviewer. It is `paused`, so the reviewer does not act on it, but
  "Resume by itself" can start it again, and then the reviewer watches it.
- The panel lists at most 50 stopped rows (`LOAD_WORK_LIST_LIMIT`); a failed start past them is
  not seen until the list is shorter.
- The provider clock is per agent, not per turn, and a restart loses it.
- A long command with no output for more than `2 × N` minutes is restarted. Set a larger `N` for
  work like that.
- The reviewer watches channel tasks only, not the chat of an agent.
- "Resume by itself" still starts a task again that the person stopped. That is its own behavior,
  and this change does not alter it.
