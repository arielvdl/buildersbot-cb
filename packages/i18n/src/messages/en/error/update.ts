import { defineMessages } from "../../../message";

export const messages = defineMessages("error.update", {
  // Updater state the user reads.
  "error.update.unsupported": "Updates are available in installed desktop builds.",
  "error.update.notAvailableInThisVersion": "Updates are not available in this version of Builders Bot yet.",
  "error.update.notReady": "An update is not ready to install.",
  "error.update.restartFailed": "Builders Bot could not restart to install the update.",
  "error.update.downloadStalled": "The update download stopped responding. Try again.",
  "error.update.installFailed": "Could not install the update. Quit and reopen Builders Bot, then try again.",
  "error.update.downloadFailed": "Could not download the update. Try again.",
  "error.update.checkFailed": "Could not check for updates. Try again.",
  "error.update.checkStalled": "The update check stopped responding. Try again.",
  "error.update.checkOffline": "Could not reach the update service. Check your internet connection, then try again.",
  "error.update.checkUnavailable":
    "The update service did not answer. Builders Bot tries again on its own in a few minutes.",
  "error.update.checkNoRelease":
    "No published update was found for this platform. Builders Bot tries again on its own in a few minutes.",
  "error.update.managedByNix": "Nix installs updates for this copy of Builders Bot. Update it with Nix.",
  "error.update.managedByHost":
    "Updates on this Mac are installed by the host. The update stays ready until the host's maintenance runs.",
  "error.update.siblingSession":
    "Another Builders Bot session is still running from this application. Stop Builders Bot in every other macOS user account first, then install the update again.",
  "error.update.siblingSessionSameAccount":
    "Another Builders Bot process is still running in this user account. Quit it, then install the update again.",
  "error.update.siblingCheckFailed": "Could not verify other Builders Bot sessions. Try again before installing.",
  // A joined server's admin reads these from the host.
  "error.update.remoteDisabled": "Updates from server admins are turned off on this computer.",
  "error.update.restartStarted": "Builders Bot is already restarting to install the update.",
  "error.update.alreadyRestarting": "Builders Bot is already restarting.",
});
