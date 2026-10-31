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

### Removed

- The permanent link and the one-time Mobile Connect code. They put an openbot:// link with a
  sign-in secret in a QR code, for the earlier phone app. A phone that signed in with one stays
  signed in until you disconnect it.

### Fixed

- The Cultura Builder sign-in screen shows why a sign-in could not start. Before, it showed nothing.

### Security

- The sign-in of the web app is bound to the browser that started it. Only that browser can collect
  the approval from the Hub, and the page never gets a session token.
- The account service refuses to make or redeem a Mobile Connect code or permanent link.
