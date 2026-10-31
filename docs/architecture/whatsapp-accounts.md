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
   another number (`owner` in `accounts.json`), or that keeps the history of another number after
   an unlink (the `owner` of the account database). It refuses a number that another account has,
   had or keeps the history of. The person adds a new account for a new number.
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
  that a provider uses for the plugin's server. Main starts `npx` with `execFile` or `spawn`, an
  argument array and no shell of its own. The environment is the MCP SDK default environment, the
  resolved `PATH`, `NO_COLOR=1` and `WAZAP_NO_UPDATE_CHECK=1`. No `WAZAP_*` value of the app passes
  through.
- With Server settings › Network egress on, the egress proxy variables come last in that
  environment (`WhatsAppAccountsOptions.environment`, read at each command). So the `npx` download
  and `wazap login` (the pairing and the history sync) leave through the egress gateway, as the
  wazap server that an agent starts does. A number is not linked from one address and used from
  another. See [Network egress](egress-proxy.md).
- `npx` itself is not shell-free: `npm exec` runs the wazap bin with `sh -c` (`@npmcli/run-script`),
  and npm's quoting (`@npmcli/promise-spawn`, `escape.js`) leaves `{`, `}`, `[` and `]` bare. On
  macOS `sh` is bash, which expands braces: `Loja{1,2}` became `Loja2`. So the nickname refuses
  these four characters (`cleanWhatsAppAccountName`). The `--name=` prefix stays on each word, so no
  new flag can come in.
- Every value that the person typed goes in one argument: `--name=<nickname>`, `--phone=+<digits>`,
  `--account=<id>`. The `=` form keeps a value that starts with `-` from being read as a flag. The
  id must match wazap's own rule (`^[a-z0-9][a-z0-9-]{0,31}$`). A nickname with a control character,
  a brace, a square bracket or more than 64 characters is refused.
- Calls are serial. Each call has a deadline (60 seconds, because the first `npx` run can download
  the package) and an output limit. Main never shows or logs the raw output: it maps it to an error
  code, and it masks phone numbers and pairing codes in each log line (`redactWazapText`).
- On Windows, `npx` is a `.cmd` file, which `spawn` cannot start without a shell. The panel says
  that it is not available on Windows. Linking from a chat still works there.

| Action in the panel | wazap command |
| --- | --- |
| Read the list | `status --json`; `accounts.json` and `.env` (read only) for the per-account `writes` flag and the global `WAZAP_READ_ONLY`; the `owner` meta of an unlinked account's `wazap.sqlite` (read only) |
| Add an account | `account add <id> --name=<nickname> --json` |
| Turn on, turn off (asks first), set as default | `account enable|disable|default <id>` |
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
| Running | MCP client to a new `npx -y wazap-mcp@1.6.0` over stdio. It joins the running server as a bridge, and main calls `link_account` with `account_id` and the number. | Not available (`qr-needs-free-folder`). The panel says why and offers the code. |
| Not running | `login --account=<id> --phone=+<digits> --code`. The CLI pairs, syncs the history and exits. | `login --account=<id> --qr`. Main reads each QR that the CLI draws and shows it in the panel. |

If `login` finds a server that started after the status read (`server-busy`), main tries the MCP
path once. A code
lasts two minutes. The panel shows the code in large type, a countdown, the steps on the phone
(WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead) and
"Generate another code". While a session runs, the panel asks main for its state every two
seconds. On the MCP path, main asks the server with `get_status` (`account_id`) every three seconds
over the open client, which starts no process, and reads `status --json` only when the client
cannot answer, until the account has a number or the code expires. Any number ends the wait. Main
then compares it with the typed number with `sameWhatsAppNumber`: the WhatsApp id of many Brazilian
mobile numbers has no ninth digit (`55 DD XXXXXXXX` for `+55 DD 9 XXXXXXXX`). A number that is not
the same one shows as a warning, not as an expired code. The CLI path ends when `wazap login`
exits. Cancel ends the CLI process (SIGTERM, so wazap frees the lock) or closes the MCP client.

On the MCP path, `link_account` gives the pairing that runs, so a second request before the code
expires gives the same code, and closing the bridge does not stop the pairing in the server. The
panel keeps "Generate another code" off until the code expires, and says under the code that it can
still work after Cancel and that the person can ignore it on the phone.

## After an unlink

`wazap logout` deletes the credentials and sets `owner` to null in `accounts.json`, but keeps the
account database (`accounts/<id>/wazap.sqlite`), whose `owner` meta still names the number. When
another number links into that account, wazap renames the database to
`wazap.<time>.previous-owner.sqlite` and deletes it after seven days, unless that number is linked to
an enabled account. `status --json` does not give the database owner, so main reads it:

- Only for an account with no number and no `owner` in `accounts.json`, and a database.
- With `node:sqlite`, read only. Without a write-ahead log the file opens immutable, as wazap's own
  readers do, so no `-wal` or `-shm` file appears beside a closed database. A busy or unreadable
  file gives no owner.

`linkRefusal` then refuses (`has-history`) a number that is not that owner, and a QR code, which
cannot say which number links. When main cannot read the owner, a database that holds messages is
enough to refuse. The same number links again. The row says "Was linked to •••• 0100", or "Keeps the
history of an unlinked number" without a readable owner. The unlink confirmation says that, after
it, only the same number can link to that account again.

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
phone number. No wazap tool creates an account, so to add one the agent sends the person to the
plugin page; only an agent that runs commands on the computer of the server runs
`npx -y wazap-mcp@1.6.0 account add <id> '--name=<nickname>'`. The agent calls `link_account` always
with `account_id`, and only for an account that it created for that number in the same
conversation, never for an account that existed before, linked or not: `get_status` does not show
whose history an unlinked account keeps. Every send stays draft and then confirm.

## Safety

- Connect only numbers that you own, or whose owner agrees. The link is unofficial (Baileys), and
  WhatsApp can restrict a number that sends in bulk. The add dialog says this.
- No number, code or nickname goes to analytics or to a log line without masking.
- The IPC handlers are bound with `payloadHandler`, so the trusted-sender check runs before
  decoding. Unlink, remove and turn off need `confirm` equal to the account id in the payload, which
  only the confirmation dialog sets. Turning off takes the number away from every agent at once,
  over the control line, so it asks first too.
- The panel shows "Read only (global)" and a notice when `WAZAP_READ_ONLY` is on in the data
  folder's `.env`: then no account can send, whatever its own flag. The confirmation to remove the
  default account names the account that becomes the default (wazap takes the first one left).

## Tests

The repository default is E2E tests only. The review of this change asked for the pure parts to run
in CI, so they have Vitest files (a default set aside, not a protected area):

- `src/main/ipc/whatsapp-accounts-handlers.test.ts`: sender check, payload decoding, the nickname
  characters that the shell of `npx` would change, and the confirmation of unlink, remove and turn
  off.
- `src/preload/whatsapp-accounts-decoding.test.ts`: what main sends is decoded before the page
  reads it.
- `src/main/wazap-cli.test.ts`: masking in log text, the pinned version of the listing, slugs, E.164
  by country, `sameWhatsAppNumber`, the argument builders with injection attempts, the readers of
  wazap's output against fixtures, the state of each row, and `linkRefusal`, with the status after
  a logout and a Brazilian id without the ninth digit.
- `src/main/whatsapp-accounts.test.ts`: the service with fake `execute`, `startLogin` and
  `openServerClient`: a running server takes a code over MCP, no server takes `wazap login`, a QR
  with a server is refused, cancel stops the child, an unused code expires, dispose closes every
  pairing, and the database owner is read read-only from a real SQLite file.
- `scripts/egress-proxy-e2e.ts`: the spawn environment of a wazap command of the panel has the
  gateway variables while the egress proxy is on.
- `scripts/whatsapp-accounts-e2e.ts`: drives the real pinned wazap CLI in a temporary data folder
  (only commands that do not contact WhatsApp), including the refusal after an unlink with a fake
  account database. It writes `.openbot-build/whatsapp-accounts-e2e/report.json`. Run it with
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
- **No shell at all, and Windows.** Resolve the pinned package's own `node` entry point
  (`dist/index.js`) and run it with `node`, so neither `npx`'s `sh -c` nor a `.cmd` file is in the
  path. Then the nickname can take braces and square brackets again.
