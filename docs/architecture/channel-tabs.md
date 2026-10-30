# The tabs of a channel

A channel holds several conversations, one per tab, side by side. Every tab carries the same
channel memory, the same members and the same lead; a second channel would not, and that is the
reason for tabs.

## What belongs to a tab

| Kept per tab | Kept per channel |
| --- | --- |
| messages | memory |
| tasks and assignments | members and lead |
| agent session and its thread (`projection_channel_contexts`) | instructions, name, title |
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

## Rules that are easy to break

- The last tab of a channel cannot be deleted; a channel without a tab cannot be opened.
- The first tab's id is `openbot-topic-<channelId>`, so the migration is idempotent and a channel
  created by the service is written with its first tab in the same command.
- A routine, the Team API and an older client name no tab, so they land in the first one.
- A tab belongs to its channel. A channel that the reader creates or opens starts on its first tab:
  the renderer clears `topicId` on both paths. A read that names a tab which is not in the channel
  fails (`readTopicId`), as `send` does, so the renderer falls back to the first tab. An empty page
  for a foreign tab would keep the reader on it, and the first message would fail with "This tab of
  the channel no longer exists."
- Deleting a tab interrupts its running turns before its sessions and threads go.
- The parallel limit (`CHANNEL_PARALLEL_LIMIT`) is counted per tab, through the task of each
  assignment. One turn per agent stays channel-wide: it is what keeps one agent from opening two
  sessions in the same directory.
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

## Upstream

This is a local feature. The daily core update merges upstream into `builders-bot`, so a conflict in
any file above keeps the tab side of it. A new upstream migration takes the next version number
after 48, never 48 itself, and `openbot-database-schema-history.json` keeps its record for 48.
