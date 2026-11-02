### Added

- An app that you sign on your Mac with `bun run package:signed` now holds the small program that
  connects the Builders Bot extension to it, and the check of that program. "Let agents use my Chrome"
  then works in the installed app, with no development run. Load the extension from the
  `extension-local` folder that `bun run chrome-extension:kit` makes. The app takes the program only
  when it has the same signature as the app and Google Chrome started it.
- `bun run chrome-extension:kit` makes the extension folders to load in your own Chrome and writes
  the steps to connect it, for the app in development and for a locally signed app.

### Changed

- An app that has no signature that the program can check, such as an unsigned package, keeps "Let
  agents use my Chrome" off and says why in its log.
