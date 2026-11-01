### Security

- Agents can no longer run Playwright code in your Chrome with `browser_run_code_unsafe`. That
  tool reached every tab of the group and the cookies of your signed-in sites. Agents now get an
  error for it and use the other browser tools, such as `browser_evaluate` on the current page.
