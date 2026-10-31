# The Team panel ("Equipe")

The Team panel shows all agents that work now, as small solar systems. The **Team** button of the
page rail, below **Agents**, opens it. It is an overlay on the right side of the window, not a column
of the layout: the window has no space for a column. It is a modal dialog, so Escape, the close
button and a click on the dimmed window close it. The approved design is the mockup `v10-orbitas`.

## What the panel shows

- **A system** is a channel with work. Its lead is the sun, and its members orbit it. A system name
  opens its channel and closes the panel. An agent that is in no channel goes to the system of its
  sidebar section, while it is active. The name of such a system selects the section in the section
  rail and opens the chat of its sun.
- **An agent** shows its mark (`AgentAvatar`) and, at its lower right, the mark of its model family.
  A click or Enter opens a card: the name, the model, one line of work, the time or the wait, and
  one button that names the channel of the work and opens it (or opens the chat of the agent). The
  card closes when its agent leaves the panel, and it does not open again when the agent comes back.
- **The model marks** at the top show the families that generate now, in a fixed order: Opus,
  Sonnet, Haiku, Fable, then the other families by name. Each mark counts the agents of its family
  that generate now. A tap keeps the agents of that family at full strength and dims the others in
  their place, and a second tap clears the filter. The mark of the filter stays while the filter is
  on, also at 0. When no agent of that family shows any more, the filter clears.
- **The top line** counts the agents that generate now. "Needs you" and "Stopped" show only when
  their count is not zero; a click scrolls to the first such agent and opens its card. The marks and
  the top line share one line at 440 px; a narrower panel or a longer language wraps the count.
- **Bubbles** show only for the two agents that need attention most and have text: the question
  that an agent asks, then the message that an agent writes now. A system has one bubble at most,
  because the bubble takes the top of the system: the next bubble goes to an agent of another system.
- **Links** are faint lines between two agents when a message from one waits in the queue of the
  other. A pointer or the focus on one end shows the line.
- **Colours.** A channel takes the hue of its lead, so the channels of one coloured section look
  different. A section takes its own colour, else the hue of its first agent. A system with no
  colour takes a tone from its key, so it keeps its colour while other systems come and go. The
  halos mix less of the colour on the light theme.

## Where the data comes from

The panel reads the same signals as the sidebar. It adds no IPC endpoint, no Team API route and no
capability, so a joined server sends the data on the path that it uses for the sidebar.

| Signal | Source | Use |
| --- | --- | --- |
| Agents, hidden agents | `useAgents()` | who shows, name, avatar, provider and model |
| Running turns | `createAgentWorkingTurns()` (shared with `WorkspaceSidebar`) | working |
| Queues | `useTurns().queues` | working (`isAgentWorking`), starting turns, the channel of channel work (`hold`), links |
| Waits | `sidebarAgentWaits` over every thread of an agent | waiting for the person, plan limit |
| Failed turns | `useTurns().failedTurns` | failed |
| Recent and unread replies | `useConversation()` | done |
| Steps | `useTurns().turnProgress` | the line of work when the load has no request |
| Channels | `useChannels()` | systems, leads, members, the message that is written now |
| Sidebar layout | `useSidebar().sidebarLayout()` | order of systems, sections, section colours |
| Load | the load controller of the page rail | request, start time, channel and tab of running work; stopped channel tasks; agents that wait under the agent cap |

The load is the load of this computer. The page rail reads it only for the local server, so on a
joined server the panel has no request text, no running time and no stopped channel task. The other
states are the same. While the panel is open, the load controller reads every 3 seconds, as when the
load panel is open.

## States

`orbitsView` in `packages/ui/src/features/orbits/orbits-view.ts` sets one state for each agent. The
first rule that matches wins.

| State | Rule | Look |
| --- | --- | --- |
| waiting (for you) | a question, an approval or a browser takeover in any thread | full strength, a pulse in the warning colour, the question in a bubble |
| speaking | the last message of a channel streams, and the agent writes it | a soft pulse, the text in a bubble |
| thinking | a turn starts now and nothing of it runs yet, or the lead routes a request (the channel runs a task and no member works) | the mark breathes |
| working | `isAgentWorking`, or the load lists running work | a fast orbit on the inner ring, a racing arc, sparks and two trail dots |
| stalled | the load lists a stopped channel task of the agent | a red ring that flickers, the danger face |
| waiting | a plan limit, a place under the agent cap, or a queued routine run | dim, a slow swing on the outer ring |
| failed | the last turn failed | a still dot in the danger colour at the right edge (a still red ring for a sun) |
| done | a recent or unread reply | a small dot with a check at the right edge |
| idle | none of these | a small dot at the right edge |

A failed turn is not a stall. The host keeps the mark of a failed turn until the next turn of the
agent or until the person sees it in the Dynamic Island, so the mark can be old. So a failed agent
holds still, is not in the motion budget, is not in the "Stopped" count, and shows only beside the
active agents of its system: a workspace where nothing runs shows the empty panel, also with old
failures. This is the same as the sidebar, which shows a failed turn only for a routine.

The model family, the first rule that matches:

| Model id or provider | Family | Mark |
| --- | --- | --- |
| names `opus`, `sonnet`, `haiku` or `fable`, wherever it runs | the Claude tier | a diamond, a ring with a dot, a triangle, a spark |
| starts with `gpt-` or `o<digit>`, or has it after a `/` | ChatGPT (`codex`) | the provider logo |
| `grok-`, `deepseek` | Grok, DeepSeek | the provider logo |
| `gemini-` | Gemini (`antigravity`) | the provider logo |
| `kimi` | Kimi | a moon |
| `glm`, `chatglm` | GLM | a hexagon |
| `qwen`, `qwq` | Qwen | a pentagon |
| none of these, a provider that this build knows | the provider | the provider logo |
| none of these, a provider that this build does not know | other | a plain ring |

So a model that a router (OpenCode, OpenRouter, Cultura Builder) runs shows its maker, and the
filter can tell it from the router.

## Limits of the data on this base

- **No progress percent.** No signal gives the progress of a turn, so the working ring has a racing
  arc and no fill. The card shows the running time instead, where the load reports it.
- **No minutes for a stalled or failed agent.** `StoppedWork` and the failed turns have no time.
  The host has the time of the last event of a turn (`TurnLifecycle.lastEventAt`); a new, additive
  field of the local load can carry it later. The quiet minutes of the task reviewer (branch
  `wave2/task-reviewer`) are not on this base either.
- **No dotted tether to what an agent waits on.** No signal names the agent that another agent waits
  for. The task dependencies of a channel load only for the open channel. The links of queued
  messages show who asked whom.
- **A stopped task names its agent by name.** `StoppedWork` has `agentName` and no agent id, so the
  panel finds the member of that channel with that name.

## Motion and its cost

A continuous animation costs CPU on each frame; the performance review measured it. So:

- Solid draws the structure once. `orbits-engine.ts` owns one `requestAnimationFrame` loop for the
  whole panel. Only a node on an orbit or a drift moves on each frame; a still node is placed once.
  A frame writes a `transform`, a `z-index` or the path of a link only when it changed. It reads no
  layout: the place of each system is read once, at the start of the first frame after a layout,
  before the frame writes.
- The loop asks for the next frame only while a node orbits, drifts or glides. A layout, a new node
  or a closed card wakes it. So a panel where nothing orbits or drifts runs no frames.
- The racing arc of a working agent turns the whole progress SVG, which gets its own layer, so the
  turn does not repaint on each frame. CSS loops animate only `transform` and `opacity`.
- A bubble starts a layout only when its height changes (a `ResizeObserver` on the bubble), not on
  each streamed word.
- The panel is mounted only while it is open. When it closes, the loop and every CSS animation stop.
- The loop stops and the CSS loops pause while the window is hidden (`createTaskListPlayState`, the
  visibility hook that the task list uses), and with reduced motion. Reduced motion also removes the
  CSS loops.
- `orbitMotionIds` gives at most 60 animated elements to the agents that need attention most. A
  working agent costs five (its node, two trail dots, the sparks, the racing arc). A failed, done or
  idle agent costs none. Other agents keep their place and their colours.
- A change of state glides a node to its new place in 0.7 seconds.
- The ring of working agents is at least 52 px high from its middle, so a working planet passes over
  and under a working sun without touching it.

## Where the code is

| File | Content |
| --- | --- |
| `packages/ui/src/features/orbits/orbits-view.ts` | the pure model: states, families, grouping, attention, filter, counts, motion budget |
| `packages/ui/src/features/orbits/orbits-geometry.ts` | the rings and the place of each agent, pure |
| `packages/ui/src/features/orbits/orbits-engine.ts` | the frame loop: transforms of nodes, trails and links |
| `packages/ui/src/features/orbits/OrbitsPanel.tsx` | the dialog, the model marks, the top line, the systems |
| `packages/ui/src/features/orbits/OrbitSystem.tsx` | one system, its agents and the card |
| `packages/ui/src/features/orbits/orbits.css` | the styles, with palette tokens |
| `src/renderer/src/features/orbits/WorkspaceOrbits.tsx` | the desktop container: signals in, jumps out |
| `src/renderer/src/features/window/WorkspacePageRail.tsx` | the Team button, the open state, the shared load |
| `src/renderer/stories/TeamOrbits.stories.tsx` | the story, with fixtures in `team-orbits-fixtures.ts` |
| `scripts/team-orbits-smoke.ts` | the browser check |

The web client does not pass `onTeam` to the page rail, so it has no Team button.

## Checks

`bun scripts/team-orbits-smoke.ts` serves the real panel with the app stylesheet on `127.0.0.1`,
feeds it the story fixtures through `orbitsView`, and drives it in a headless Chromium. The page holds
the signals in a Solid signal, so the smoke changes them while the panel is open. It checks the
states and families of the agents, the grouping, the colours, the counts, the bubbles (one in each
system), the model marks and the filter, the card, the jumps, an agent that finishes, a system that
leaves with its card open, a filter on a family that leaves, the rings on a full lap, the motion
budget, the frame loop that stops, the pause in a hidden window, reduced motion, a joined server,
the empty panel with old failures, and the Portuguese text. It writes
`.openbot-build/team-orbits/report.json` and screenshots of the panel at 440 and 360 pixels wide,
dark and light.

The smoke does not drive the desktop app: the page rail, `WorkspaceOrbits` and the jumps of the
desktop container (open a channel on the tab of the work, select a section, the focus after a jump)
need a check in the running app (`bun run dev:automation`).
