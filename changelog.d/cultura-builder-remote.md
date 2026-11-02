### Added

- A joined server now signs in Cultura Builder on the host with the Hub device code. The Cultura
  Builder row no longer says that a remote server cannot connect it. The access token stays on the
  host, and the Hub proxy serves the models.
- The first provider step of a joined server downloads the Builders CLI when Builders is the choice
  and the host does not have it, as the first run does. The step no longer waits for the user to press
  Download.
