### Added

- On a Mac laptop, Settings › General has "With the lid closed". "On power adapter" keeps the Mac on
  with its lid closed while the power adapter is connected, with no password. "Also on battery" keeps
  it on with battery power too. It asks for the administrator password one time, to install a small
  safety service. The service turns normal sleep on again when the battery goes below the level that
  you select, when the Mac is too hot, and in 90 seconds when Builders Bot quits or stops. The mode
  is off by default, and it also has a time limit.
- "Test with the lid closed" measures if the Mac slept while its lid was closed, and shows the result.
- When macOS has sleep turned off and Builders Bot did not ask for it, Settings shows "Restore normal
  sleep".

### Fixed

- "Keep this computer awake" now tells you that it stops only the sleep of an idle computer. Before,
  it did not say that the Mac still sleeps when you close the lid.
