### Fixed

- Cultura Builder sign-in no longer gives up on the first dropped request or unrecognised answer
  from the Hub. A device code lives for minutes and is polled every few seconds, so one bad
  round-trip was ending the whole sign-in and silently resetting the dialog, even after the user had
  approved the code on the Hub.
