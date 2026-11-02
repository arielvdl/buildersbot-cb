import { defineMessages } from "../../message";

/**
 * Text of the Builders Bot Chrome extension. `scripts/build-chrome-extension.ts` writes it to the
 * extension's `_locales` (Chrome's message format), so this area is not in the desktop catalog. Chrome
 * messages have no plural forms: write a sentence that reads well with any number.
 */
export const messages = defineMessages("chromeExtension", {
  "chromeExtension.extName": "Builders Bot",
  "chromeExtension.extDescription":
    "Lets the AI agents of the Builders Bot app for macOS work in tabs of your Chrome, in one tab group for each project.",
  "chromeExtension.actionTitle": "Builders Bot",
  "chromeExtension.command.stopAll": "Stop all agents in Chrome",
  "chromeExtension.badge.controlledBy": "Controlled by {agent} · {project}",

  "chromeExtension.popup.connected": "Connected to Builders Bot",
  "chromeExtension.popup.appOffline": "Builders Bot is closed",
  "chromeExtension.popup.notPaired": "Not connected yet",
  "chromeExtension.popup.noHost": "Builders Bot is not set up on this Mac",
  "chromeExtension.popup.connecting": "Connecting…",
  "chromeExtension.popup.connect": "Connect",
  "chromeExtension.popup.stopAll": "Stop all",
  "chromeExtension.popup.resume": "Resume",
  "chromeExtension.popup.stoppedNote": "Agents are stopped. Nothing acts in your tabs until you resume.",
  "chromeExtension.popup.noProjects": "No agent works in Chrome now.",
  "chromeExtension.popup.pause": "Pause",
  "chromeExtension.popup.tabCount": "Tabs: {count}",
  "chromeExtension.popup.blockedTitle": "Blocked sites",
  "chromeExtension.popup.blockedHelp": "Agents may not use these sites. Allow one only if this project must use it.",
  "chromeExtension.popup.allow": "Allow",
  "chromeExtension.popup.allowPrompt": "To allow {site} for this project, tap it below.",
  "chromeExtension.popup.allowedTitle": "Allowed for this project",
  "chromeExtension.popup.blockAgain": "Block again",
  "chromeExtension.popup.cancel": "Cancel",
  "chromeExtension.popup.disconnect": "Disconnect",
  "chromeExtension.popup.choiceMismatch": "That was not the site. Nothing changed.",

  "chromeExtension.welcome.title": "Builders Bot in your Chrome",
  "chromeExtension.welcome.intro":
    "The AI agents of the Builders Bot app can work in tabs of this Chrome, in one tab group for each project. They use the sites where you are signed in, from this computer.",
  "chromeExtension.welcome.readsTitle": "What the extension reads",
  "chromeExtension.welcome.reads":
    "Only tabs inside a Builders Bot project group, and only while an agent works there: the page, its address and title, and what the agent types or clicks. Passwords, codes and card numbers go from the app to the page, and never back.",
  "chromeExtension.welcome.whereTitle": "Where it goes",
  "chromeExtension.welcome.where":
    "Only to the Builders Bot app on this Mac, through an encrypted local channel. The extension makes no network connection. The app can send page content to the AI provider that you chose. Chrome can sync the name of a project group to your other devices.",
  "chromeExtension.welcome.neverTitle": "What it never touches",
  "chromeExtension.welcome.never":
    "Tabs outside the project groups, incognito windows, banks, exchanges, password vaults, Google and Apple accounts, and government sites such as gov.br.",
  "chromeExtension.welcome.stopTitle": "How to stop",
  "chromeExtension.welcome.stop":
    "Chrome shows a bar while an agent works. Press Cancel on that bar, Stop all in the extension menu, or Alt+Shift+K.",
  "chromeExtension.welcome.pairTitle": "Connect to Builders Bot",
  "chromeExtension.welcome.showWords": "In Builders Bot, choose these words:",
  "chromeExtension.welcome.chooseWords": "Then tap the words that Builders Bot shows:",
  "chromeExtension.welcome.notNow": "Not now",
  "chromeExtension.welcome.paired": "Connected. You can close this tab.",
  "chromeExtension.welcome.mismatch": "The words did not match. Nothing was connected.",
  "chromeExtension.welcome.declined": "Nothing was connected.",
  "chromeExtension.welcome.tryAgain": "Try again",
  "chromeExtension.welcome.waiting": "Waiting for Builders Bot…",
  "chromeExtension.welcome.noHost":
    "Builders Bot is not installed on this Mac, or it has not set up the connection to Chrome yet.",
  "chromeExtension.welcome.openApp": "Open Builders Bot",
  "chromeExtension.welcome.restart": "If you just set it up in Builders Bot, restart Chrome.",
  "chromeExtension.welcome.unsupported":
    "This extension needs the Builders Bot app for macOS. It does not work on this system yet.",
  "chromeExtension.welcome.pin": "Pin the Builders Bot icon to the toolbar to see the agents and stop them.",
});
