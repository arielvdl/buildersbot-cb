# The feed page

The feed shows what each run of each agent does, on every server that the app is joined to, as it
happens. The **Feed** button of the page rail opens it (`app.rail.feed`, the Lucide `Activity` mark).
It is a page, not a dialog. It has two parts:

- **The Team**, a list on the left side of the page. It shows each agent, what it does now, and how
  many runs it has in the feed. A click on an agent shows only the runs of that agent; a second click
  shows all runs again. The Team panel (`team-orbits.md`) stays as it is.
- **One timeline**, the newest run at the bottom, as in a conversation. Each run is one card that
  changes in place. A card shows the agent, its project (the sidebar section), the title of the task
  or the channel, the state, the step that it does now, and what it waits for. "Open conversation"
  (or "Open channel") opens the place of the run.

This is step 1 of the feed: read only. A card that needs the person tells what it waits for and opens
the conversation, where the person answers. Approve, deny, answer, resume and reassign on the card
are step 2. The feed of a joined server with the data of its host is step 3.

## The contract

`packages/contracts/src/ipc-feed.ts` holds `FeedItem` version 1, `FeedSnapshot`, `FeedDelta` and
their guards. A new field is always optional. A change that removes a field, makes one required or
changes what one means is version 2, with a new decoder; the version 1 decoder stays.

| State | When |
| --- | --- |
| `working` | A turn runs. |
| `waiting` | Messages wait in the queue of the agent, or the agent waits for something. |
| `needs-you` | An approval or a question waits for the person. |
| `stopped` | A channel task stopped with a reason, a plan limit, the task reviewer, or a turn that was stopped before its end. |
| `done` | The run ended. |
| `failed` | The run ended with an error. |

A card id is stable for its run: `<server>:t:<agent>:<thread>` for a chat or a side thread,
`<server>:task:<task>` for a stopped channel task, `<server>:q:<agent>` for the queue of an agent
that does not run. A new turn of a chat whose card ended starts that card again at the end of the
timeline. A turn that continues the same request (`continues`) keeps the card and its steps.

The IPC group is `feed` (`window.openbot.feed`):

| Endpoint | What it does |
| --- | --- |
| `getSnapshot` | Every card (at most 5,000), in timeline order, with the cursor of the last delta. |
| `setWatching` | The window shows the page, or stops to show it. Main sends deltas only to a window that watches. |
| `delta` (event) | The cards that changed and the ids of the removed cards. The cursor goes up by one at each delta. |

The handlers (`src/main/ipc/feed-handlers.ts`) accept only the main window and the chat windows: the
Dynamic Island and the browser dock overlay share the origin of the app and are refused before the
payload is read. The preload (`src/preload/feed-decoding.ts`) copies each card field by field, drops
a card that is not a version 1 card, refuses a snapshot or a delta of another version, and drops an
invalid delta instead of throwing it into the page.

## The main process

`src/main/feed/feed-aggregator.ts` builds the cards. It is plain TypeScript, with no Electron and no
file access. `src/main/feed/feed-service.ts` adds the batch timer, the windows and the reads of the
load. `forwardAgentEvent` (`src/main/renderer-forwarders.ts`) gives every agent event of every server
to `FeedService.ingest`, before any window check, so the cards stay current while no window is open.

| Source | What it gives the card |
| --- | --- |
| `turn-started`, `turn-progress`, `turn-completed` | The run, its steps (`turn-progress` is a summary already) and its end. A quiet routine run that ends leaves the feed. |
| `approval`, `prompt`, `agent-input-resolved` | "Needs you". An approval shows its kind and the program name of a command (`git`), never the command. A prompt shows its first question, cleaned, redacted and clipped. |
| `error`, `usage-limit-reached`, `queue-changed`, `waits-changed` | A failed run, a plan limit, the queue card of an agent that does not run. |
| `agent-tasks-changed`, `agents-changed`, `sidebar-layout-changed`, `runtime-snapshot` | Task titles, agent names, projects, and the runs and requests of a server when it connects. |
| `WorkControl.overview()` | This computer only, every 5 s while a window watches: the channel and tab of a running channel turn, the task reviewer's "slow" or "stalled", and the stopped channel tasks with their reason. |

The aggregator does not read `conversation`, `conversation-delta`, `conversation-page`,
`agent-task-conversation*` or the browser events: they hold the text of a conversation. It does not
show the request text of a channel task either: the title of a channel card is the channel and tab
name.

### Secrets

Every text goes through one function before it gets into a card: the internal citations are removed,
the control and format characters become spaces, the text is redacted, and then it is clipped (200
characters for a step or a reason, 140 for a title, 120 for a label). The redaction is
`redactMcpValues` with the secret values of the MCP servers of this computer, and `redactText` of
`@openbot/logging`, which masks the registered secrets and the token patterns (`sk-`, `ghp_`, `xox`,
`AKIA`, JWT and the others there). The text is redacted before it is clipped, so a clip cannot cut a
secret into a piece that the patterns do not find.

### Batches, memory and cost

- A change marks its card. A delta goes out at most every 100 ms: at most 10 deltas each second, each
  card at most once in a delta, at most 200 cards in a delta. The rest go in the next delta.
- While no window watches, the aggregator keeps its cards and sends nothing. A window that starts to
  watch reads the snapshot.
- At most 5,000 cards. Over the limit, the oldest ended card (`done`, `failed`) goes first, then the
  oldest card of any state. An ended run leaves after 24 hours. A card keeps its last 20 steps.
- Nothing is written to disk. After a restart, the feed starts from the runs and requests that each
  server reports (`runtime-snapshot`) and from the load of this computer; the ended runs and the steps
  before the restart are gone.

`scripts/feed-aggregator-e2e.ts` measures it with the real agent service and a stand-in Claude CLI.
Its report is `.openbot-build/feed-aggregator-e2e/report.json`.

## The window

The page is a host pane of `usage-context` (`view: "feed"`), so it covers the conversation as the
Schedule and Workflows pages do (`windowPageKind` is `titled`). The shared components are in
`packages/ui/src/features/feed/`, with props only:

| File | Part |
| --- | --- |
| `FeedPage.tsx` | The page: the Team, the filters, the jump bar and the timeline. |
| `FeedTeamList.tsx` | The Team as a list. |
| `FeedFilters.tsx` | Search (`/` goes to it), project, agent, state, and the grouping: timeline, by project, by agent. |
| `FeedJumpBar.tsx` | Live or paused, and the counters "Needs you", "Stopped", "Working": each click goes to the next such card. |
| `FeedTimeline.tsx` | The timeline, on `createChatVirtualizer`: only the cards on screen are in the DOM. |
| `FeedItemCard.tsx` | One card. |
| `feed-view.ts` | The DOM-free projection: filters, rows, counters, Team. |

The adapter is `src/renderer/src/features/feed/`: `stores/feed-store.ts` keeps one record of cards
by id and the ids in timeline order, applies the deltas in cursor order, and reads the snapshot again
after a gap. It stops watching while the window is hidden. `WorkspaceFeed.tsx` builds the Team from
the same signals as the Team panel (`orbits/orbits-view-source.ts`) and adds every other agent that
has a card, such as an agent of another server. `feed-open.ts` opens a card: its channel, or the chat
of its agent on the tab of its side thread. A card of another server switches to that server first.

Scrolling up pauses the timeline: new cards are counted ("3 new") and do not move the reader. The
button at the bottom goes back to the newest card. The timeline is an ARIA `feed`: each card is an
`article` with `aria-posinset` and `aria-setsize`; the arrow keys, Page Up, Page Down, Home and End
move between the cards. A polite live region says when more runs need the person, not each step.

`src/renderer/stories/Feed.stories.tsx` shows the page with the preview mock
(`src/renderer/src/preview/mock-feed.ts`): empty, a normal day, 5,000 cards, and new runs on a timer,
on both palettes. `scripts/feed-ui-e2e.ts` checks them in a headless browser.

## Joined servers

The feed of a joined server is made only from the agent events that this app gets from that server
today, on the path that the sidebar and the Dynamic Island use. The host decides which events a
member gets, so the feed shows no run that the member cannot already see, and no new data leaves the
host. No Team API route or capability is added. The stopped channel tasks, the waits and the task
reviewer are local only, so a joined server shows none of them. A feed with the data of the host
(`feed-v1`, filtered by the role of the member) is step 3 and is off.

## Known limits

- The title of a chat is "Chat with <agent>": `turn-started` has no title, and the feed does not read
  the conversation. Side threads take the title of their task.
- There is no cost for each run: no event carries it.
- The Team list shows the live state of the agents of the active server; an agent of another server
  shows the state of its newest card.
- A delta sends the whole card, with its last 20 steps. In the E2E burst, a card was about 1.8 KB.
