### Fixed

- Settings search finds every setting again: Theme, Transparent window, Security review of messages,
  the dictation settings, Voice server and the security check of the Agents tab. Before, these rows
  had no search entry.
- Settings search finds the sections of the server settings, such as Vault, Roles, MCP, Storage and
  Updates, and the rows of General, such as Timezone and Memories per agent. A result opens the
  section and moves to the row. The server settings page has the search field too.
- Settings search finds a setting when you type it without accents, in English, or with another word
  for it: "notificacoes", "update" and "tampa" each find their setting. A search for "tema" no longer
  shows "Permissões do sistema".
- A result for a row that is not shown now opens its tab and says why the row is not there.
- The command palette finds all the sections of the server settings and finds a settings page by the
  words of its rows. It ranks settings pages as the settings search does, so "voice" shows Voice first
  and "tema" no longer finds a page through "sistema". Enter does not open a settings page that only
  other words found while messages and files are still loading.
- Settings search finds a setting when the query has small words or a plural, such as "cofre do
  servidor", "membros do servidor" and "memória dos agentes". A search for "servidor" shows the
  sections of the server below the settings of this app, and each group shows its own results.
- Settings search does not show a row that the Updates tab hides now, and does not show Remove server
  for a hosted server. A newer result stops an older one that still waits for its row.
- In the web app, the command palette also finds the settings: Profile, Preferences and the sections
  of the server settings.
- The Roles section of the server settings is in Portuguese.
