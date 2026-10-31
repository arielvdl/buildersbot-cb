# WhatsApp accounts

The WhatsApp plugin (`marketplace/plugin-catalog/plugins/whatsapp/plugin.json`) starts the community
MCP server `wazap-mcp@1.6.0` through `npx`. One wazap data folder holds many WhatsApp accounts. This
note says how Builders Bot lets a person add, link and manage these accounts, and how agents pick one.

## The problem

Before this change, the only way to link was in a chat: the agent called `link_account` with a
phone number. An agent made up an example number, and WhatsApp refused the code. Nothing had stored
that number. Also, wazap starts with one account, `default`. A second number linked into an account
that belonged to another number makes wazap set the earlier history aside, and delete it after seven
days. A second number must always get its own account.

## Decision

1. **Set up in the plugin page, use in the chat.** The WhatsApp plugin page in Marketplace › Apps
   shows an accounts panel when the plugin is installed. The person adds an account with a nickname
   ("WhatsApp do Ariel", "Empresa", "Sofia") and a number, and links it with a pairing code
   (default) or a QR code. An agent then picks the account by its nickname.
2. **wazap keeps the accounts.** The nickname is the wazap account `name`, and the account id is a
   slug of the nickname. Builders Bot keeps no copy of the accounts, the numbers or the codes. The
   panel reads `wazap status --json` each time.
3. **One number, one account.** Main refuses to link a number into an account that belonged to
   another number (`owner` in `accounts.json`), and refuses a number that another account has or
   had. The person adds a new account for a new number.
4. **The existing `default` account does not change.** The panel shows it as it is. Only a click of
   the person changes it, and each destructive action asks first.

## Parts

| Part | File |
| --- | --- |
| Shared types, slug, E.164, masking, wazap detection | `packages/contracts/src/ipc-whatsapp-accounts.ts` |
| IPC group `whatsappAccounts` | `packages/contracts/src/ipc-endpoints.ts` |
| CLI argument builders, output parsers, redaction | `src/main/wazap-cli.ts` |
| Service: runs the CLI, runs the pairing, keeps the link sessions | `src/main/whatsapp-accounts.ts` |
| IPC handlers and payload parsers | `src/main/ipc/whatsapp-accounts-handlers.ts`, `src/main/ipc/whatsapp-accounts-inputs.ts` |
| Preload decoders | `src/preload/whatsapp-accounts-decoding.ts` |
| Renderer adapter and polling | `src/renderer/src/features/settings/whatsapp-accounts-controller.ts` |
| Shared panel and dialogs | `packages/ui/src/features/marketplace/WhatsAppAccountsPanel.tsx` |
| Agent rules | `marketplace/plugin-catalog/plugins/whatsapp/skills/whatsapp-accounts/SKILL.md`, and one line in `src/backend/agent/developer-instructions.ts` |

## How main runs wazap

- Main runs the pinned package, `npx -y wazap-mcp@1.6.0`, the same version as the listing.
  `scripts/whatsapp-accounts-e2e.ts` fails when the two versions differ. The renderer never names a
  command, an argument or a path: it sends an account id, a nickname, a number and an action.
- Main finds `npx` with `usableMcpServer` (`src/backend/mcp-provider-shapes.ts`), the same lookup
  that a provider uses for the plugin's server. It uses `spawn` with an argument array and no
  shell. The environment is the MCP SDK default environment, the resolved `PATH`, `NO_COLOR=1` and
  `WAZAP_NO_UPDATE_CHECK=1`. No `WAZAP_*` value of the app passes through.
- Every value that the person typed goes in one argument: `--name=<nickname>`, `--phone=+<digits>`,
  `--account=<id>`. The `=` form keeps a value that starts with `-` from being read as a flag. The
  id must match wazap's own rule (`^[a-z0-9][a-z0-9-]{0,31}$`). A nickname with a control character
  or more than 64 characters is refused.
- Calls are serial. Each call has a deadline (60 seconds, because the first `npx` run can download
  the package) and an output limit. Main never shows or logs the raw output: it maps it to an error
  code, and it masks phone numbers and pairing codes in each log line (`redactWazapText`).
- On Windows, `npx` is a `.cmd` file, which `spawn` cannot start without a shell. The panel says
  that it is not available on Windows. Linking from a chat still works there.

| Action in the panel | wazap command |
| --- | --- |
| Read the list | `status --json`, and `accounts.json` (read only) for the per-account `writes` flag |
| Add an account | `account add <id> --name=<nickname> --json` |
| Turn on, turn off, set as default | `account enable|disable|default <id>` |
| Read only on or off | `config writes off|on --account=<id>` |
| Unlink | `logout --account=<id>` |
| Remove (deletes the history) | `account remove <id> --yes` |

The account changes reach a running server at once, over wazap's control line (`control.json`).
`config writes` is read only when an account starts, so the panel says when a running server needs
a restart. wazap 1.6.0 has no rename command, and main does not write `accounts.json` itself, so the
panel has no rename action (see next steps).

## Linking

`wazap login` holds the lock of the data folder for the whole pairing and the history sync. It
refuses to start while another wazap holds that folder, such as the server of an agent session.
`link_account` runs the pairing inside the server that holds the folder and does not stop the
other accounts. So main picks the path from `status --json`:

| Server of the data folder | Pairing code | QR code |
| --- | --- | --- |
| Running | MCP client to a new `npx -y wazap-mcp@1.6.0` over stdio. It joins the running server as a bridge, and main calls `link_account` with `account_id` and the number. | Not available. The panel says why and offers the code. |
| Not running | `login --account=<id> --phone=+<digits> --code`. The CLI pairs, syncs the history and exits. | `login --account=<id> --qr`. Main reads each QR that the CLI draws and shows it in the panel. |

If `login` finds a server that started after the status read, main tries the MCP path once. A code
lasts two minutes. The panel shows the code in large type, a countdown, the steps on the phone
(WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead) and
"Generate another code". While a session runs, the panel asks main for its state every two
seconds. On the MCP path, main asks the server with `get_status` (`account_id`) every three seconds
over the open client, which starts no process, and reads `status --json` only when the client
cannot answer, until the account has the number or the code expires. The CLI path ends when
`wazap login` exits. Cancel ends the CLI process (SIGTERM, so wazap frees the lock) or closes the
MCP client.

Risk: when no server ran at the status read and the CLI pairs, an agent session that starts during
the pairing cannot start its WhatsApp server until the CLI exits (at most about 3.5 minutes).

## Local and remote servers

The panel runs the commands on this computer, for the "Local" server. Its data folder is `~/.wazap`,
the wazap default, so the existing link keeps working. Main does not pass `--data-dir` in the app.

- A joined server runs its own Builders Bot and its own wazap on its own computer, with its own
  `~/.wazap`. The Team API has no WhatsApp accounts capability yet, so the panel of a joined server
  says to manage the accounts on the computer that runs it. Agents on that server can still link
  from the chat.
- A server on this computer (`src/main/local-servers/`) shares the home folder, so it shares
  `~/.wazap` and the same wazap server with "Local". To give it its own folder, a listing would need
  a per-server `WAZAP_DATA_DIR`, which listings cannot set today.

## Agent side

The catalog build refuses plugin skills until pinned skill versions exist, so the rules have two
places:

- `marketplace/plugin-catalog/plugins/whatsapp/skills/whatsapp-accounts/SKILL.md` is the skill
  text, ready for the listing when the catalog takes skills.
- `developerInstructions` adds one short rule line when the agent's MCP servers include a wazap
  server (`isWazapServer`). This is the same pattern as the line for http MCP servers.

The rules: call `get_status` first; pick the account by the nickname that the person says and pass
`account_id`; with two or more accounts and no clear nickname, ask; never invent, assume or reuse a
phone number; to add an account, send the person to the plugin page, or, with a number that the
person typed in the chat, normalize it to E.164, create the account with its nickname, then call
`link_account`; never link a number into an account of another number; every send stays draft and
then confirm.

## Safety

- Connect only numbers that you own, or whose owner agrees. The link is unofficial (Baileys), and
  WhatsApp can restrict a number that sends in bulk. The add dialog says this.
- No number, code or nickname goes to analytics or to a log line without masking.
- The IPC handlers are bound with `payloadHandler`, so the trusted-sender check runs before
  decoding. Unlink and remove need `confirm` equal to the account id in the payload, which only the
  confirmation dialog sets.

## Tests

- `src/main/ipc/whatsapp-accounts-handlers.test.ts`: sender check, payload decoding, and the
  confirmation of destructive actions.
- `src/preload/whatsapp-accounts-decoding.test.ts`: what main sends is decoded before the page
  reads it.
- `src/main/wazap-cli.test.ts`: masking of numbers and codes in log text.
- `scripts/whatsapp-accounts-e2e.ts`: drives the real pinned wazap CLI in a temporary data folder
  (only commands that do not contact WhatsApp), and checks slugs, E.164 by country, the argument
  builders with injection attempts, the parsers against fixtures and real output, and the state
  mapping. It writes `.openbot-build/whatsapp-accounts-e2e/report.json`. Run it with
  `bun scripts/whatsapp-accounts-e2e.ts`. It never runs `login` and never asks for a code.

## Next steps

- **Rename.** Propose `wazap account rename <id> --name` upstream. Until then, an account that is
  not linked can be removed and added again with the new nickname.
- **Accounts per agent.** stdio MCP results go to the provider directly, so neither the Guard nor
  the approval path sees which account a call uses. A per-agent limit needs a small stdio proxy in
  front of wazap that drops calls with another `account_id`, or upstream support for an account
  allow list per session.
- **Joined servers.** A Team API capability (`whatsapp-accounts-v1`) with the same five actions,
  run by the host with this service.
- **Windows.** Resolve the package's own `node` entry point, so `spawn` needs no `.cmd`.
