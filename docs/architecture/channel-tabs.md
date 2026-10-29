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
- `src/renderer/src/features/channels/ChannelTabs.tsx`: the tab bar in the channel header.
- `src/renderer/src/features/channels/channels-controller.ts`: `setTopic`, `createTopic`,
  `renameTopic`, `deleteTopic`.

## Rules that are easy to break

- The last tab of a channel cannot be deleted; a channel without a tab cannot be opened.
- The first tab's id is `openbot-topic-<channelId>`, so the migration is idempotent and a channel
  created by the service is written with its first tab in the same command.
- A routine, the Team API and an older client name no tab, so they land in the first one.
- Deleting a tab interrupts its running turns before its sessions and threads go.
- The parallel limit (`CHANNEL_PARALLEL_LIMIT`) is counted per tab, through the task of each
  assignment. One turn per agent stays channel-wide: it is what keeps one agent from opening two
  sessions in the same directory.
- A tab that was never renamed and has no message takes its name from the first message a person
  writes in it, in the same commit: first line, spaces collapsed, 32 code points and an ellipsis.
  The first tab and a renamed tab keep their name.
- The summary counters of a tab (`unreadCount`, `activeTasks`, `openTasks`, `messageCount`) are for
  the sidebar only; the channel totals above them keep summing every tab.

## Upstream

This is a local feature. The daily core update merges upstream into `builders-bot`, so a conflict in
any file above keeps the tab side of it. A new upstream migration takes the next version number
after 48, never 48 itself, and `openbot-database-schema-history.json` keeps its record for 48.
