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
- On start, the desktop app deletes the failure report queues and the inventory file that earlier versions
  kept for that analytics service, so an earlier version that opens the same profile cannot send them.
- The privacy policy at `/privacy` and the compare pages no longer say that Builders Bot has a self-hosted
  analytics service, that analytics are on by default, or that the apps have an analytics setting.
- `bun run hosting:setup` registers the Stripe and boat webhooks at the Builders Bot account service, and
  `--target=test` needs `--api`. Before, it used the account API and the test Worker of the OpenBot project.
- The package scripts and the package checks stop a build whose code or `app.asar` names the analytics
  service or an OpenPanel client of the OpenBot project, and a workflow runs the same check on each push
  to `builders-bot`.
