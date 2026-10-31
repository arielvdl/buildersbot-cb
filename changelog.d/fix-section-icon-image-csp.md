### Fixed

- A section icon image now loads in the installed app. Before, each image failed with "Builders Bot
  could not process this image", because the app does not allow `blob:` images. The editor also says
  why an image fails: an unsupported format, a file too large, a damaged file, or an SVG file with a
  script or a web link.
