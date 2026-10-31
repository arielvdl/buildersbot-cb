### Changed

- Builders Bot sends no usage analytics and no error reports from the desktop app, the browser client
  or the website. Before, they went with your account ID and email to the analytics service of the
  OpenBot project, which Builders Bot does not control.
- First run and the web sign-in no longer show the "Help make Builders Bot better" box.
- Settings → General → Permissions shows a note in place of the "Share product analytics" switch. The
  old text said that the analytics service was hosted by Builders Bot. That was not true.
- The account service sends no account, billing or email events to an analytics service, and its
  deployment needs no OpenPanel secrets. The Signal capacity report has no default address.
- `bun run dev --hosting=test` stops with an error. It signed the development app in to a test Worker of
  the OpenBot project.
