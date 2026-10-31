---
name: whatsapp-accounts
description: Use the right WhatsApp account of the wazap tools. Use it before you read, search or send on WhatsApp when wazap can hold more than one number, and when the user asks to connect, link or add a WhatsApp number.
---

# WhatsApp accounts

wazap can hold several WhatsApp accounts. Each account is one phone number, with an id (such as
`empresa`) and a nickname (such as "Empresa" or "WhatsApp da Sofia").

## Pick the account

1. Call `get_status` first. Its `accounts` list gives each id, nickname, state and default.
2. Match the nickname that the user says ("o WhatsApp do Ariel", "o da empresa", "o da Sofia") to an
   account, and pass its `account_id` to every tool call.
3. With one account, use it. With two or more accounts and no clear nickname, ask which account.
   Never guess.
4. An account that is not linked or is turned off cannot read or send. Say so, and say how to fix it.

## Numbers

- Never invent, assume or reuse a phone number. A number in an example, a test or another chat is
  not the user's number. Ask the user for it.
- A number is in E.164: `+`, the country code, then the number, with no spaces (for example
  `+15550100` in a test). Without a country code, ask for the country.

## Add or link an account

- Prefer the plugin page: Marketplace › Apps › WhatsApp. Its accounts panel adds an account with a
  nickname and links it with a pairing code or a QR code.
- When the user types a number in the chat and asks you to connect it:
  1. Normalize the number to E.164, and read it back to the user.
  2. Create a new account for it, with the nickname that the user gives (`wazap account add <id>
     --name <nickname>`, or ask the user to add it in the panel). One number is one account.
  3. Call `link_account` with that `account_id` and the number. Show the 8-character code and the
     steps: WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead.
     The code lasts two minutes.
  4. Call `get_status` every 10 seconds until the account is connected.
- Never link a number into an account that belongs to another number. wazap then sets the history
  of the earlier number aside and deletes it after seven days.
- Connect only numbers that the user owns, or whose owner agrees.

## Send

- Every send is a draft first: `send_message` returns a preview, and `confirm_send` sends it only
  after the user approves that draft.
- An account in read only cannot send. Do not look for another way.
- Writes are limited to 20 a minute for each account. Do not send in bulk.
