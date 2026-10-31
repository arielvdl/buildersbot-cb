### Added

- On a Mac laptop, Settings › General has "With the lid closed". "On power adapter" should keep the
  Mac on with its lid closed while the power adapter is connected, with no password. "Also on
  battery" keeps it on with battery power too. It asks for the administrator password one time, to
  install a small safety service. The service turns normal sleep on again when the battery goes below
  the level that you select (also on the power adapter while the battery does not charge), when the
  Mac is too hot, after 8 hours on battery with the lid closed, and in about 2 minutes when Builders
  Bot quits or stops. When the mode stops with the lid closed, Builders Bot and the service ask macOS
  to sleep. The mode is off by default, and it also has a time limit. While the mode is on, the Mac
  also does not sleep when it is idle, with the lid open too.
- "Test with the lid closed" uses the sleep record of macOS to find if the Mac slept while its lid was
  closed, and shows the result.
- When macOS has sleep turned off and Builders Bot did not ask for it, Settings shows "Restore normal
  sleep", and a desktop notification tells you.
- Settings shows when the safety service is installed but does not run, and when it did not turn
  sleep off.

### Fixed

- "Keep this computer awake" now tells you that it stops only the sleep of an idle computer. Before,
  it did not say that the Mac still sleeps when you close the lid.
