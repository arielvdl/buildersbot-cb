### Security

- Agents can no longer run Playwright code in your Chrome with `browser_run_code_unsafe`. That
  tool reached every tab of the group and the cookies of your signed-in sites. Agents now get an
  error for it and use the other browser tools, such as `browser_evaluate` on the current page.

### Added

- The Builders Bot Chrome extension can now connect to the app with no token and no network port:
  through a small signed program in the app and a private, encrypted channel. You pair a Chrome
  profile with two taps: one on the words in the app, and one on the words in Chrome. Nothing is
  copied or typed. The app package does not hold that program yet.
- Settings > General has a new switch, off by default: "Let agents use my Chrome (beta)". On,
  agents work in tabs of your own Chrome through the Builders Bot extension. Each project gets a tab
  group with its name, an agent keeps its tabs from one turn to the next, and tabs open in the
  background without taking the focus. Banks, password vaults and government sites stay blocked, an
  agent's own scripts are off, and each message that an agent sends on a mail, chat or social site
  waits for your approval of the text and the recipients. Messages from team members, channels that
  team members can write in, chat apps and routines do not reach your Chrome.
- Before an agent reads or acts on a mail, chat, cloud console, social network, payment page or a
  site of your own network in your Chrome, you allow it once for that project. The answer holds until
  Builders Bot restarts.
- An agent can no longer send a message in your Chrome around the approval card: Enter, Space, a new
  line, a button with no name, a part of a button's name, and a recipient that changed after the
  agent read the page all ask you first.
- Agents that a routine or a webhook started, also through other agents, do not reach your Chrome.
- More ways around the approval card in your Chrome now ask you first: a key with a space or a "+"
  after it, Alt+S and other keys with Ctrl, Cmd or Alt, a button named only by a symbol, a button in
  Spanish, French, German, Italian or Dutch, a tab or another control character in the text, and a
  button that the agent named by a part of its name, which the page can change after the agent read
  it.
- More ways around the approval card now ask you first: a send button in Japanese, Russian, Arabic or
  another language, a button whose label and visible text differ, a send button in a web component or a
  frame, and a space typed while a button has the focus. While a message is being written, any button
  asks unless it is an action such as Cancel, Close, Attach or Bold.
- Builders Bot connects only to its own Chrome program when Google Chrome started it. A copy of that
  program that another program starts, or that a program starts and then turns into Chrome, gets no
  connection and opens no pairing card. The pairing words stay the main protection.

### Fixed

- One slow page in your Chrome no longer cuts the connection for every agent.
- The connection renews its keys once a day without failing an agent's action.
- Turning "Let agents use my Chrome" off removes the link that lets Chrome start Builders Bot. Builders
  Bot writes that link back when another program changes it.
