### Added

- Settings > Mobile Connect and the sign-in step of Add phone show whether your phone can reach this
  computer. When the server of this computer is not published, Publish this server publishes it
  with one click.

### Fixed

- The web app on a phone can sign in again. Before, the browser refused the sign-in request before
  it sent it, because the name of a request header had a space in it, and no code came.
- A computer passes the requests of a phone to its server again, and the live view of the agent
  browser opens on the phone. Before, each phone request failed on the computer.
- Remote desktop, the upload of the server logo and site publishing send valid header names again.
- The web app tells you where to publish the computer. Before, it asked you to "turn on remote
  access", which is not the name of a setting.
- The web app starts offline with its offline page. Before, the browser could show a network error.
- The web app on a phone shows the name Builders Bot under its icon and in its notifications.
- The web app shows its notifications in Chrome on Android and as an installed app on a phone, while
  the app is open in the background. Before, the browser refused them and nothing showed. A click
  on such a notification opens the agent or the channel.
- Mobile Connect tells a published server that is offline now, such as after sleep, from a server
  that is not published. It shows the cause and Try again. Before, it said "This server is not
  published" in both cases, and also while the server was connecting.
- Mobile Connect says that a phone reaches the computer only while the computer is on and awake, and
  names the settings that keep it awake.
- Mobile Connect says where a phone with the web app is: Profile > Account sessions. Before, the
  phone list stayed empty, and the phone seemed not to be paired.
- The settings search finds Publish this server with "publish" and "remote access".
- **Install this version on the computer that phones connect to.**

### Security

- The sign-in code of the web app comes only by email again. Before, a configuration error showed
  the code in the sign-in form.
- The account service no longer returns a sign-in code on its public address, also when that
  configuration error comes back. Only a local development address gets the code.
