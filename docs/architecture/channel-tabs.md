# The tabs of a channel

A channel holds several conversations, one per tab, side by side. Every tab carries the same
channel memory, the same members and the same lead; a second channel would not, and that is the
reason for tabs.

## What belongs to a tab

| Kept per tab | Kept per channel |
| --- | --- |
| messages | memory |
| tasks and assignments | members and lead |
| agent session and its thread (`projection_channel_contexts`), and its line of work (tab lane) | instructions, name, title |
| rolling summary (`projection_channel_summaries`) | archived state |
| read cursor (`projection_channel_reads`) | — |

The tab is part of the primary key of the three tables that hold a conversation, so no query can
mix two tabs by accident. Messages and tasks keep their JSON and carry `topicId` inside it; the
store stamps a message or a task that arrives without one into the first tab, which is what an
older event replay and a client without tabs send.

## Where the code is

- `packages/contracts/src/ipc-chat-channels.ts`: `ChannelTopic`, the `topicId` of a message, a task
  and a page, and the `topic-create`, `topic-rename`, `topic-delete` commands. The capability is
  `channel-topics-v1`.
- `src/backend/channel-schema.ts`: the tables, and `CHANNEL_TOPICS_MIGRATION_SQL` (migration 48).
- `src/backend/channel-store.ts`: `topics`, `firstTopic`, `topic`, `addTopic`, `renameTopic`,
  `deleteTopic`, `topicThreads`, `deleteThreads`, the tab in every query that reads a
  conversation, and the per-tab counters of the summary (`#perTopicCounts`, one grouped query each).
- `src/backend/channel-service.ts`: `#topicId`, `#topicOfTask`, `#topicChange`, `#autoNamedTopics`
  with `autoTopicName`, the tab of the parallel limit in `#waitsForWork`, and the tab on the
  `send`, `request` and `read` commands.
- `src/renderer/src/features/channels/ChannelTabs.tsx`: the tab bar in the channel header, with
  the close dialog, the working shimmer, the unread dot and drag or `Alt+Shift+Arrow` reordering.
- `src/renderer/src/features/channels/ChannelTabOverview.tsx`: the list of tabs under the channel
  title, with each tab's age, the running ones first, a search and a pin.
- `src/renderer/src/features/channels/channel-tab-overview-model.ts`: the age of a tab, the filter
  and order of the list, and the pins of this device (`openbot:channel-tab-pins:v1` in local
  storage).
- `src/renderer/src/features/channels/channel-tabs-model.ts`: the order the user gave the tabs on
  this device (`openbot:channel-tab-order:v1` in local storage) and whether closing asks first.
- `src/renderer/src/features/channels/channel-tab-reads.ts`: the open tab's unread count and the
  read marks, kept per channel and tab.
- `src/renderer/src/features/channels/channels-controller.ts`: `setTopic`, `createTopic`,
  `renameTopic`, `deleteTopic`, and the read of the open tab.
- `src/renderer/src/features/channels/channel-conversation.tsx`: the "new messages" bar and
  "Mark as read" of the open tab.
- `packages/ui/src/features/sidebar/SidebarChatTabStrip.tsx` and `stores/tab-strip-store.ts`: the
  tabs under a chat row in the sidebar. A click on the avatar or the bar opens them, never hover;
  `visibleSidebarChatTabs` lists 10 at most and keeps the open tab.

## Rules that are easy to break

- The last tab of a channel cannot be deleted; a channel without a tab cannot be opened.
- The first tab's id is `openbot-topic-<channelId>`, so the migration is idempotent and a channel
  created by the service is written with its first tab in the same command.
- A routine, the Team API and an older client name no tab, so they land in the first one.
- A tab belongs to its channel. `open(channelId, topicId?)` in the channels controller is the one
  way in, from the sidebar, global search, a notification, Back and Forward or Orbits: it opens the
  tab given, else the open tab of the same channel, else the tab last open in that channel on this
  device (`openbot:channel-last-tab:v1`), else the first tab. It never carries a tab id of another
  channel. A read that names a tab which is not in the channel fails (`readTopicId`), as `send`
  does, so the renderer falls back to the first tab, but only when the channel list no longer has
  that tab: a read that fails for another reason keeps the reader on the tab with the error. An empty
  page for a foreign tab would keep the reader on it, and the first message would fail with "This
  tab of the channel no longer exists."
- Each tab keeps its own composer draft: `composerDraftKey` takes the tab (`ConversationTarget.tabId`,
  from `ConversationChannelSource.tabId`). A draft stored before this, under the channel alone, moves
  to the first tab that shows it.
- A send names its tab: `submitMessage` takes the whole target of the open composer, and the channel
  send puts `ConversationTarget.tabId` in the `send` command, else the open tab. A message that
  leaves after the reader opened another tab, such as a dictated one, still goes to its own tab.
- The microphone of the composer works in a channel as in an agent's chat (see
  [voice input](voice-input.md#the-composer-microphone)). The recording keeps its tab
  (`voiceTabId`), so its live text, its transcript and a send while recording go to that tab, also
  when the reader opens another tab before it ends.
- Deleting a tab interrupts its running turns before its sessions and threads go.
- The parallel limit (`CHANNEL_PARALLEL_LIMIT`) is counted per tab, through the task of each
  assignment. An agent has at most one active assignment per tab; its tabs run beside each other up
  to its tab limit (see [Tab lanes](#tab-lanes)).
- A tab that was never renamed and has no message takes a placeholder name from the first message
  a person writes in it, in the same commit: first line, spaces collapsed, 32 code points and an
  ellipsis. Beside the turn that starts, the channel model then writes the real name over it: two
  or three words in the language of the request, on the model of the member that took the request
  (else the lead's, else a member's). A rename made while the model runs wins, and a failed or
  empty answer keeps the placeholder. The first tab and a renamed tab keep their name.
- The summary counters of a tab (`unreadCount`, `activeTasks`, `openTasks`, `messageCount`) are for
  the sidebar only; the channel totals above them keep summing every tab. `updatedAt` is the newest
  message of the tab, or its creation while nobody wrote in it, and it is what the tab list ages.
- The tab list under the title is a menu: the name opens it, Escape or a click outside closes it, a
  card opens that tab. A pinned tab is always first and marked, whatever the sort is; like the tab
  order, the pins are a device preference.
- Message sequences are the channel's, not the tab's. A read mark kept per channel would skip a tab
  whose last message is older than another tab's, so the renderer keeps it per channel and tab, and
  every `read` command names its tab.
- Closing a tab with work or messages asks first; only a tab known to be empty and idle closes at
  once. The order on screen is a device preference: a routine still lands in the oldest tab.
- With the `routing` optimization off, a follow-up ("continue", "also", ...) and the routing prompt
  read the open tasks of the whole channel, and any change to the channel makes a routing answer
  stale. With it on, both read the tab of the message, and only a change to that tab (2 times at
  most) or to the channel settings makes the lead route again. See
  [the routing optimization](channels-and-messaging.md#the-routing-optimization).

## Tab lanes

Each tab of a channel is its own line of work for each agent (a tab lane). A message waits only for
the earlier messages of its own tab, never for work of another tab, while the agent has a free place.

| Rule | Where |
| --- | --- |
| One active assignment per agent and tab; the next request of the tab waits for it (`tab`) | `ChannelService.#laneWait` |
| At most `tabsPerAgent` tabs of one agent run a turn at the same time (`agent-tabs`); 1 for a provider with `concurrentTurns: false` | `#laneWait`, `#tabLimit`, hook `tabLimit` |
| With a limit above 1, a tab whose turn waits for the person (question, approval, browser takeover) takes no place | hook `waitsOnPerson`, `AttentionRegistry.waitsOnPerson` |
| With a limit above 1, a tab whose task waits for its next start try (`startRetry`) takes no place; its retry marker and its fallback hold are read for its own lane only | `#laneWait`, `MailboxStore.queuedStartRetry(agentId, taskId, tab)`, `DrainScheduler.#waitsForStartFallback` |
| The breaker of the agent's model holds every lane of the agent until the agent moves to the backup or the wait ends: the agent has one model, and a move waits until no turn of the agent runs | `StartBreakers.waits`, `AgentService.#usageLimitMove` |
| A tab whose task waits for other members has no assignment, so it takes no place | `ChannelService.complete` |
| While memory is low, an agent that works opens no second tab (`memory`); its first one waits in the drain as before | hook `memoryLow`, `MemoryHold.memoryReturned` |
| A free place goes to the tab of the agent that waited longest, in any channel | `#olderTabWaiter`, `#queuePlaces` |
| A message of the agent's own chat that came before a request holds new tabs (`agent-chat`); a later one does not | hook `busy(agentId, since)` |
| Each tab lane is a drain lane, keyed by `channelTabLane(channelId, topicId)` | `channel-tab-lane.ts`, `MailboxStore.#tabOf`, `DrainScheduler` |
| A tab lane waits while the agent's own chat or messaging work runs a turn (`agent-chat`); the main lane waits for channel work (`channel`) | `DrainScheduler.#heldBy` |
| A tab compacts only its own thread, and a compaction holds only its lane | `DrainScheduler.#compactionHolds` |
| A started turn takes only the starting delivery of its own tab | `TurnLifecycle.#tabForThread`, `MailboxStore.startingDeliveriesForAgent` |
| The rows of a turn go to the assignment of the thread's tab, and the read cursor is the tab's | `ChannelService.capture`, `#tabAssignment`, `ChannelStore.acceptContext` |

`tabsPerAgent` is part of the agent limit preference (`AgentLimitPreference`, Settings > Load and the
load panel): 1 to 4, 2 by default, and it applies whether the cap on agents is on or off. With 1 an
agent works in one tab at a time, as before tab lanes. A changed limit wakes every channel.

`ChannelService.page` gives each queued task the reason it waits (`ChannelTask.wait`), and the
channel shows it as a quiet line (`ChannelTaskWaitNotice`). The IPC and the Team API read pages
there. The agent's own queue names the tab and the count of tabs that hold the agent
(`QueueHold.topicName`, `QueueHold.tabs`). Both fields are optional, so an older client ignores them.

The task reviewer reads a request that waits for its tab or for a place as `owner-busy` (shown as
`agent-busy`), so it does not stop or move the work of one tab because of another. Its clock of a
running turn is per tab, and the running list names the task of each turn.

Two tabs of one agent can change the same files of its workspace at the same time. Builders Bot does
not lock files, as for the agent's side threads. Declared `workspace:<path>` resources still run one
after the other. Wait cycles through dependencies are refused when the agent makes them
(`channel_assign`), and the waits above wait only for work that runs or for the person, so they make
no cycle. `scripts/channel-tab-lanes-e2e.ts` checks the rules with the real services and a fake Codex.

## Upstream

This is a local feature. The daily core update merges upstream into `builders-bot`, so a conflict in
any file above keeps the tab side of it. A new upstream migration takes the next version number
after 48, never 48 itself, and `openbot-database-schema-history.json` keeps its record for 48.
