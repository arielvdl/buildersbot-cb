### Changed

- The web app, also on a phone, signs in with Cultura Builder: select Sign in with Cultura Builder,
  approve the code on the Cultura Builder Hub, and go back to the app. The web app no longer sends a
  sign-in code by email.
- Settings > Mobile Connect > Add phone shows only the address of the web app,
  buildersbot.culturabuilder.com/app, as a QR code and a link. The steps tell you to sign in there
  with Cultura Builder.
- `openbot mobile-connect` on a server with no screen shows the address of the web app and its QR
  code.
- The iPhone and Android download pages name buildersbot.culturabuilder.com/app and the Cultura
  Builder sign-in. The Linux page no longer gives a command that installed the upstream OpenBot
  server.
- A server invitation and its QR code are a buildersbot.culturabuilder.com/join link, which a phone
  camera opens in the web app. An invitation can also go by email.
- The link to share an agent is a buildersbot.culturabuilder.com/agents page.
- The desktop download buttons of the website say that the installer is not published there yet,
  in place of the upstream OpenBot installer.

### Removed

- The permanent link and the one-time Mobile Connect code. They put an openbot:// link with a
  sign-in secret in a QR code, for the earlier phone app. A phone that signed in with one stays
  signed in until you disconnect it.

### Fixed

- The Cultura Builder sign-in screen shows why a sign-in could not start. Before, it showed nothing.
- An approval on the Hub is no longer lost when many people sign in from one network, or when the
  code was already used: the screen asks for a new code at once.
- When a phone reloads the web app while you approve on the Hub, the sign-in continues.
- Two tabs, or a tab and the installed web app, can each wait for their own code.
- The web app no longer opens the upstream changelog, guides, Discord or feedback pages.

### Security

- The sign-in of the web app is bound to the browser that started it. Only that browser can collect
  the approval from the Hub, and the page never gets a session token.
- The account service refuses to make or redeem a Mobile Connect code or permanent link.
- The web app opens only with a session of the Cultura Builder sign-in. The phone email code of the
  earlier phone app is refused.
- The sign-in screen says to approve on the Hub only the code that it shows.
- After a sign-in, the sign-in service ends its own copy of the Hub access at once.
