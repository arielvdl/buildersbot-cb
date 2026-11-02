### Added

- The Builders Bot extension for Chrome. Agents work in tabs of your own Chrome, in one tab group for
  each project, named after the project and in its color. A tab stays with its agent across turns, so
  no new tab or group opens at each turn, and no tab takes the focus.
- You connect Chrome to Builders Bot with no token: tap the words that the app shows in the welcome
  page of the extension. The channel to the app is encrypted.
- Banks, exchanges, password vaults, Google and Apple accounts and government sites such as gov.br are
  blocked for agents. You can allow one of them for one project in the extension menu.
- Stop all agents from the extension menu, with Alt+Shift+K, or with Cancel on Chrome's debugging
  bar. Only Resume in the extension menu starts them again.

### Fixed

- A tab that Chrome discarded to free memory loads again before an agent reads it, so an agent never
  reads an empty page.
- The check for passwords and card numbers also covers frames of other sites, such as the card fields
  of a payment page, and a page after a navigation.
- After an update of the extension, agents keep their tabs and groups; no second group with the same
  name opens.
- Tabs that agents left are cleaned up: a blank one closes after 10 minutes, and when the tab limit is
  full the oldest tab that nobody looked at closes before a new one is refused.
- A site that you allow for a project no longer opens its subdomains too.
- A tab that you drag out of a project group is yours: agents no longer count it, reload it or close
  it.
- Closing a window no longer pauses the agents of its project.
- With Builders Bot closed or not installed, the extension no longer tries to connect each minute.
- The welcome page opens by itself only when you connect Chrome in Builders Bot, at most 3 times an
  hour. More banks, exchanges, iCloud and Google Workspace admin are blocked for agents.

### Security

- Agents run in your pages only the fixed functions of the Builders Bot browser engine, checked by
  their fingerprint. No other code from outside the extension runs, until you turn on an agent's own
  scripts for a project, which this version cannot do.
- An agent can no longer read the value of a password, code or card field that Builders Bot typed for
  it, and a field that the page turns from a password into text counts as a secret again. A password
  inside a web component, also a closed one, counts too, and a very large page counts as holding a
  secret. Builders Bot types a secret only into a password, code or card field.
- An agent can no longer reach the extension's own secret check, the scripts of other extensions in
  the page (such as a password manager), the history of the tab, or the part of an address after
  "#", where some sites put a sign-in token.
- Copy, cut and paste keys, in every spelling, are refused, so an agent cannot read or change your
  clipboard.
- A command for a tab runs only for the agent that holds the tab.
