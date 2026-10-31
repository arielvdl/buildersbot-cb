### Added

- The WhatsApp plugin page shows the WhatsApp accounts when the plugin is installed. Each account is
  one number with a nickname, such as "WhatsApp of Ana" or "Company", and shows the last digits of
  its number, its state and its message count. "Add account" takes a nickname and a number with a
  country, and links it with a pairing code or a QR code. The code shows large, with a countdown and
  the steps on the phone. The menu of each account unlinks it, turns it on or off, sets it as the
  default, makes it read only and removes it. Unlink, turn off and remove ask first, and remove says
  that the history of that account is deleted.
- Agents with the WhatsApp plugin pick the account by the nickname that you say, and ask when two
  or more accounts can fit. They do not invent a phone number, and they do not link a number into
  an account that existed before.

### Fixed

- The accounts panel does not link a number into a WhatsApp account that had another number, or
  that keeps the history of another number after an unlink. Before, a second number linked into the
  same account made wazap set the history of the earlier number aside and delete it after seven
  days.
