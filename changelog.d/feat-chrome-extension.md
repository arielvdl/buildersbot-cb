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
