### Security

- Agents can no longer run Playwright code in your Chrome with `browser_run_code_unsafe`. That
  tool reached every tab of the group and the cookies of your signed-in sites. Agents now get an
  error for it and use the other browser tools, such as `browser_evaluate` on the current page.

### Added

- The Builders Bot Chrome extension can now connect to the app with no token and no network port:
  through a small signed program in the app and a private, encrypted channel. You pair a Chrome
  profile with two taps: one on the words in the app, and one on the words in Chrome. Nothing is
  copied or typed. This path is not on in the app yet.
