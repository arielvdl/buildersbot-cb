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
  `deleteTopic`, `topicThreads`, `deleteThreads`, and the tab in every query that reads a
  conversation.
- `src/backend/channel-service.ts`: `#topicId`, `#topicOfTask`, `#topicChange`, and the tab on the
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

## Upstream

This is a local feature. The daily core update merges upstream into `builders-bot`, so a conflict in
any file above keeps the tab side of it. A new upstream migration takes the next version number
after 48, never 48 itself, and `openbot-database-schema-history.json` keeps its record for 48.
