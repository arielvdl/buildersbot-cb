# Very large text in the chat

This page records how the chat handles very large text, from the message box to the database, what
was measured, and what is still open. It compares each layer with what Claude Code does.

## How to measure

- `scripts/chat-large-text-perf-e2e.ts` drives the `Conversation/Conversation/Very Long Reply`
  story in a running Storybook. The story URL sets the reply size and kind (`longReply`,
  `longReplyBytes`), the history (`historyCount`, `historyBytes`) and a stream (`streamSteps`,
  `streamGapMs`). The script measures the time to show the reply, long tasks, frame gaps, heap,
  DOM nodes, main-thread time per streamed step (CDP `TaskDuration`, `ScriptDuration`,
  `RecalcStyleDuration`), a paste of each size into the message box and typing after a 90 KB draft.
  A paste must lose no text, and the whole reply must be in the page.
- Start Storybook with `OPENBOT_STORYBOOK_SOLID_RELEASE=1 bun run storybook --no-open`. Without it,
  Storybook serves the development build of Solid, whose performance tracks and untracked-read
  warnings take most of the time (18,000 warnings for one 100 KB reply), and a 1 MB reply crashed the
  page.
- `scripts/chat-large-text-db-bench.ts` times the main-process work of one streamed flush on the
  real database of a temporary profile.

Storybook still runs the rest of the app as a development build, and the computer was under load,
so compare times only with other runs of the same script on the same computer.

## Measured (Solid release build, Storybook, 2026-11-01)

| Case | 10 KB | 100 KB | 1 MB | Main cost |
| --- | --- | --- | --- | --- |
| Open a Markdown reply | 0.3 s | 1.9 s | 20 s, 64k nodes, 767 MB heap | script, then style |
| Open a code block | 0.2 s | 2.3 s | 18 s, 194k nodes | style and paint of every line |
| Open a table | 0.4 s | 1.2 s | 12 s, 1.2 GB heap | script: every cell is Markdown |
| Main thread per streamed step, Markdown | 21 ms | 61 ms | 731 ms | style recalc of the whole document |
| Main thread per streamed step, code | 24 ms | 73 ms | 767 ms | style recalc of the whole document |
| Main thread per streamed step, table | 20 ms | 76 ms | 794 ms | script and style |

| Case | Result |
| --- | --- |
| History of 5,000 short messages | opens in 0.8 s, 13k nodes: the list draws only the rows near the screen |
| History of 500 messages of 10 KB | opens in 1.2 s |
| Typing after a 90 KB draft | 4.4 ms per key (2 ms in an empty box) |
| Paste of 1 MB, before the fix | the box kept 100,000 characters and dropped the rest with no message |

Database, per streamed flush of 8 KiB (`persistStreamingMessage`): 0.5 ms at 10 KB, 1 ms at
100 KB, 4.6 ms at 1 MB, 35 ms at 5 MB. A reply that grows to 5 MB costs about 21 s of synchronous
main-process work in total, because each flush writes the whole message twice (row and event).

## What exists and works

- Deltas from the provider are coalesced (100 ms or 8 KiB) and carry only the new text
  (`src/backend/agent/delta-buffer.ts`).
- History loads in pages of 50 to 100 messages with a cursor, and the list virtualizes above 100
  rows (`createChatVirtualizer.ts`).
- A streamed reply is lexed again only from its last finished block
  (`lexStreamingTokens` in `MarkdownMessageText.tsx`), and a streamed code block highlights only
  from its last restart point (`CodeBlock.tsx`).
- The text reveal is paced and catches up in about 400 ms, so a burst of text does not render word
  by word.
- The composer draft is written 300 ms after the last change, and only its text.
- Tool output is not stored or sent to the renderer. Each provider is a CLI that keeps its own tool
  output limits, as Claude Code does. OpenBot's own tools cap their results: browser snapshot
  128 KB, history tools 8,000 to 16,000 characters with `nextOffset`, Hub connections 30,000
  characters per page.

## Fixed here

- A paste that would make the message longer than 100,000 characters becomes a text file
  attachment (`pasted-text.txt`), with a reference in the message, as Claude Code keeps a long paste
  out of the prompt. Before, the box kept the first 100,000 characters and lost the rest with no
  message.

Measured in one Storybook session, with the fix stashed and then applied: a paste of 1 MB kept
100,000 characters and 0 bytes of files before, and 1 attachment of 1,000,000 bytes after; a paste of
5 MB kept 100,000 characters before, and 1 attachment of 5,000,000 bytes after. Pastes up to 100 KB
stay text in the box, as before.

Tried and not kept: reusing the unchanged lines of a streamed code block (no change in script time
per step at 100 KB: 15.5 to 16.3 ms with it, 15.2 to 15.3 ms without), and `content-visibility: auto`
on each code line (see the table below).

## Open, with estimates

| Proposal | Gain | Risk | Size |
| --- | --- | --- | --- |
| Find what recalculates style over the whole document on each streamed step (the trace shows about 10,000 elements per step, with `:has()` invalidations on `.ui-bubble`, `.message-entry` and `.conversation-panel`), and contain it | per-step cost no longer grows with the reply: about 3x at 100 KB, 10x at 1 MB | medium: CSS used by many surfaces | 1 to 2 days |
| Draw a long settled reply in chunks over several frames, or only the blocks near the screen | no freeze of 2 to 20 s when a 100 KB to 1 MB reply opens | high: the chat's own scroll keeping (`overflow-anchor: none`) and the virtualizer measure row heights | 3 to 5 days |
| Group code lines in chunks of about 200 with `content-visibility: auto` on each chunk | 1 MB code block opens in a few seconds | medium. One `content-visibility: auto` on each of 12,000 lines was tried and made the 1 MB block slower (more than 180 s): the browser checks each one on each frame | 1 day |
| Persist a streamed message to SQLite at most once per second when it is larger than 256 KB, and always at the end | 5 MB reply: about 21 s to under 1 s of main-process work | medium: the revision in each delta event comes from the write | 1 to 2 days |
| Give history pages and search results a byte budget, and return search excerpts in place of whole messages | no 100 MB IPC message when many large messages match | low | 1 day |
| A full-text index (FTS5) for chat search in place of `LIKE` over `message_json` | search time stops growing with the stored text | medium: needs a migration | 2 to 3 days |
| A generic size cap on results of the local MCP bridge, with the full output in a file and its path in the result | protects providers that do not truncate (not checked for Pi and ACP agents) | medium | 1 to 2 days |
