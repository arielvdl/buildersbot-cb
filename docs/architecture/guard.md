# The Guard

The Guard is an agent of Builders Bot that checks what enters an agent's work and what leaves it.
It is on by default at the Light level. The person can turn it off completely in Settings, Guard.

It is not the [message reviewer](prompt-injection-guard.md). The message reviewer reads each message
that a person, a chat app or a teammate sends, before the turn starts. The Guard reads tool calls and
tool results while the turn runs.

## Levels

| Level | Saved value | State |
| --- | --- | --- |
| Off (asleep) | `off` | Runs now. The Guard checks nothing. |
| Light | `light` | Runs now. The default. |
| Strict | `strict` | Planned. Shows as "coming soon". |
| Very strict | `very-strict` | Planned. Shows as "coming soon". |
| Custom | `custom` | Planned. Shows as "coming soon". |

The list in `GUARD_LEVELS` (`packages/contracts/src/ipc-guard.ts`) is stable: a saved value never
changes its meaning. A window can choose only a level of `GUARD_AVAILABLE_LEVELS`. A saved planned
level runs as Light until it exists (`guardEffectiveLevel`).

## Light

At Light, the concern is prompt injection: content from a page, a file, a tool or a third party that
carries instructions for the agent, and actions that send secrets or data out, or run code from the
network. Light never stops the work by itself.

1. **Local check** (`src/backend/guard/guard-triage.ts`). It runs first, with no network. It reads
   the whole item up to 4,000,000 characters; a longer item is read at its start and its end and is
   *incomplete*. The rules that weigh high always read the whole text in one pass. The lighter rules
   read it in parts of 64,000 characters that overlap by 4,096, and stop when the 150 ms budget ends;
   the item is then incomplete. Every quantifier of a rule that is read in parts is bounded, and runs
   of white space read as one, so no match is longer than the overlap. The result is `clean`,
   `suspicious` or `high`, with the place of each finding.
2. **Reviewer** (`guard-judge.ts`). Only a suspicious item with a marked place goes to a small, fast
   model, with a deadline of 4 s. The default is Builder Fast of Cultura Builder
   (`cultura-builder/builder-fast`), called on the Hub gateway with the person's own sign-in. The
   person can choose another model, or "Local check only". A model of another provider runs one
   toolless turn on a disposable client, with a deadline of 12 s.
3. **Decision** (`guard-policy.ts`).

| Local check | Reviewer | Content that enters | Action that leaves |
| --- | --- | --- | --- |
| clean | not asked | passes | passes |
| high | not asked | the person decides | the person decides |
| suspicious | allow, with every marked place in the excerpt | passes | passes |
| suspicious | allow, but a marked place was not in the excerpt | passes with a note | the person decides |
| suspicious | ask or block | the person decides | the person decides |
| suspicious | no verdict: no sign-in, timeout, error, reply outside the schema | passes with a note | passes |
| incomplete | not asked when nothing is marked | passes with a note | the person decides |

"The person decides" uses the existing approval card. A Full access grant does not answer a Guard
question. A question about a secret that may leave (category `secret-leak`) is for the owner only,
on each of the three paths to the card: a built-in tool (`awaitToolApproval`), a provider command
(`surfaceApproval`) and a legacy provider command (`surfaceLegacyApproval`).

"Passes with a note" puts a `<guard_notice>` item in front of the result: the content is data, not a
request from the person. Where no card can be shown, such as the shared browser, a result that would
ask gets the strong note (`<guard_notice level="high">`).

## Where the Guard runs

The router of Builders Bot tools (`src/backend/agent/openbot-tool-router.ts`) calls `GuardGate`
(`src/backend/guard/guard-gate.ts`):

- **Before a call**: `beforeTool`, for each tool that `GUARD_TOOL_EGRESS` marks `checked`: browser
  open, navigate, type, fill_fields, evaluate, run_script, act and upload_files; messaging_post,
  attach_files_to_response, publish_site, replace_site, html_preview, html_render and
  save_mcp_server. A provider's command approval gets `commandMark`.
- **After a call**: `afterTool`, for each tool that `GUARD_TOOL_INBOUND` marks `checked`: the
  browser results that are page content, messaging_history, messaging_list_places and
  test_mcp_server.
- **The shared Playwright browser** (`src/main/playwright-broker.ts`): each `tools/call` result
  passes `McpResultGuard` (`guard-mcp-results.ts`) on its way to the agent. Other events of the
  stream pass at once. A result longer than 8 MB gets the strong note, unread, and is logged.

Tests fail when a tool of the catalog is not in `GUARD_TOOL_EGRESS` or `GUARD_TOOL_INBOUND`.
`GUARD_INBOUND_PATHS` lists each path of outside content, covered or not:

| Path | Covered |
| --- | --- |
| Builders Bot browser (`openbot_browser`) | Yes |
| Builders Bot tools with outside content | Yes |
| Shared Playwright browser (broker) | Yes |
| Slack, Discord and Telegram messages | By the message reviewer |
| Playwright in its own process (no broker) | No |
| MCP over http through the sign-in proxy | No; `McpResultGuard` can wrap `pipeBody` of `mcp-oauth-proxy.ts` |
| MCP over http, direct, and MCP over stdio | No; the provider reads the result itself |
| Provider web fetch and search | No; it runs in the provider's process |
| Provider file reads and shell output | No; only a command that asks for approval reaches the Guard |

### Files

Uploads, attachments and site sources are checked at each path that leads to the file
(`guard-paths.ts`): as given, in normal form, with `~` expanded, in the folders where the
attachment code opens a relative path, and behind every symbolic link. An upload then runs on the
real paths that the Guard checked. When the Guard asked the person, the paths are resolved again
after the answer, and the upload does not run if a file changed. A path that cannot be resolved for
another reason makes the action incomplete.

## What leaves the computer

Only for a suspicious item, and only to the chosen reviewer:

- the direction, the tool name and the host of a page;
- the codes of the local findings;
- an excerpt of at most 2,000 characters, cut around the marked places, with hidden text written
  out and secrets masked before it leaves (`maskSecrets`: known key shapes, tokens, private keys,
  credential assignments, secret lines of environment files, URL credentials, long key-like runs,
  emails and every secret that this app saved).

Never the conversation, the agent's instructions or other tool results. The excerpt is one JSON
string between `<item>` markers; the reply must be one JSON object with exactly `verdict`,
`category` and `reason`, else it counts as no verdict.

The log (`guard`) records the direction, the tool, the local level, the decision, the category, who
decided, the time and whether the item was read in full. It never records the content.

## Settings

The preference is `openbot-guard-v1.json` in the user data directory. A file that is missing,
damaged, of another version or of another shape reads as the default, so a broken file never turns
the Guard off.

| Key | Default | Meaning |
| --- | --- | --- |
| `level` | `light` | A value of `GUARD_LEVELS`. |
| `judge` | `{ "provider": "cultura-builder", "model": "cultura-builder/builder-fast" }` | The reviewer. `null` is "Local check only". |

The window reads and sets it through the `guard` IPC group: `guard:get-state` and
`guard:set-preference`. The state also says whether the reviewer can run now (`judgeReady`), such as
Cultura Builder with no sign-in. The page is `src/renderer/src/features/settings/SettingsGuardTab.tsx`.

## Known limits

- The paths marked "No" above.
- The local check reads text. It does not read images, such as a screenshot with text in it.
- A file is checked by its path, not its content: a hard link or a copy of a key under an ordinary
  name passes.
- An upload resolves its paths again when it opens the files; a folder that becomes a link in the
  milliseconds between the Guard check and the open is not seen.
- A reviewer that the same content fools can clear a suspicious item that it saw in full. It cannot
  clear a high finding, and it cannot clear an item whose marked places were not all in its excerpt.
