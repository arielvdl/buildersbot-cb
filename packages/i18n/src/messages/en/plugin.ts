import { defineMessages } from "../../message";

export const messages = defineMessages("plugin", {
  // The plugin page in the marketplace.
  "plugin.link.website": "Website",
  "plugin.link.privacyPolicy": "Privacy Policy",
  "plugin.link.terms": "Terms of Service",
  "plugin.copyLink": "Copy link",
  "plugin.askPrompt": "Ask {name}: {prompt}",
  "plugin.section.skills": "Skills",
  "plugin.section.information": "Information",
  "plugin.info.developer": "Developer",
  "plugin.info.category": "Category",
  "plugin.info.version": "Version",

  // The uninstall confirmation. {number} is a count that has no plural form here.
  "plugin.uninstallDialog.title": "Disconnect {name}?",
  "plugin.uninstallDialog.description":
    "This removes what {name} installed on this computer. Nothing else on this host or on this agent changes.",
  "plugin.uninstallDialog.confirm": "Disconnect",
  "plugin.uninstallDialog.appsLabel": "Apps to remove, {number}",
  "plugin.uninstallDialog.appsTitle": "Apps removed from this host",
  "plugin.uninstallDialog.appsNote":
    "Their tools stop being available, and any sign-in Builders Bot kept for them is forgotten.",
  "plugin.uninstallDialog.skillsLabel": "Skills to remove, {number}",
  "plugin.uninstallDialog.skillsTitle": "Skills removed from {agentName}",

  // The WhatsApp accounts panel on the WhatsApp plugin page. An account is one number in wazap.
  "plugin.whatsapp.title": "WhatsApp accounts",
  "plugin.whatsapp.description":
    'Each account is one number. Agents pick an account by its nickname, such as "WhatsApp of Ana" or "Company".',
  "plugin.whatsapp.add": "Add account",
  "plugin.whatsapp.refresh": "Refresh",
  "plugin.whatsapp.loading": "Reading the WhatsApp accounts…",
  "plugin.whatsapp.remote":
    "The accounts are on the computer that runs {host}. Open Builders Bot on that computer to add or link an account. Agents on {host} can still link from a chat.",
  "plugin.whatsapp.unavailable": "The WhatsApp accounts could not be read",
  "plugin.whatsapp.default": "Default",
  "plugin.whatsapp.readOnly": "Read only",
  "plugin.whatsapp.readOnlyGlobal": "Read only (global)",
  "plugin.whatsapp.globalReadOnly":
    'Sending is off for every account: WAZAP_READ_ONLY is on in the wazap folder. Agents can only read, and "Allow sending" on an account has no effect until that setting is off.',
  "plugin.whatsapp.formerNumber": "Was linked to {number}",
  "plugin.whatsapp.unlinkedHistory": "Keeps the history of an unlinked number",
  "plugin.whatsapp.messages": { one: "{count} message", other: "{count} messages" },
  "plugin.whatsapp.state.linked": "Linked",
  "plugin.whatsapp.state.notLinked": "Not linked",
  "plugin.whatsapp.state.linking": "Linking",
  "plugin.whatsapp.state.disabled": "Off",
  "plugin.whatsapp.state.error": "Error",
  "plugin.whatsapp.action.more": "More actions for {name}",
  "plugin.whatsapp.action.link": "Link",
  "plugin.whatsapp.action.unlink": "Unlink",
  "plugin.whatsapp.action.enable": "Turn on",
  "plugin.whatsapp.action.disable": "Turn off",
  "plugin.whatsapp.action.default": "Set as default",
  "plugin.whatsapp.action.readOnly": "Make read only",
  "plugin.whatsapp.action.writable": "Allow sending",
  "plugin.whatsapp.action.remove": "Remove",
  "plugin.whatsapp.addTitle": "Add a WhatsApp account",
  "plugin.whatsapp.addDescription":
    "Give the account a nickname and the number to link. Agents find the account by its nickname.",
  "plugin.whatsapp.nickname": "Nickname",
  "plugin.whatsapp.nicknamePlaceholder": "WhatsApp of Ana",
  "plugin.whatsapp.accountId": "Account id: {id}",
  "plugin.whatsapp.country": "Country",
  "plugin.whatsapp.number": "Number",
  "plugin.whatsapp.numberHint": "With the area code. Or type the full number with +.",
  "plugin.whatsapp.numberPreview": "Number to link: {number}",
  "plugin.whatsapp.invalidName": "Type a nickname of up to 64 characters.",
  "plugin.whatsapp.invalidNumber":
    "This is not a number of the country that you chose. Check the area code, or type the full number with +.",
  "plugin.whatsapp.consent":
    "Connect only numbers that you own, or whose owner agrees. This link is not official (it uses Baileys), and WhatsApp can restrict a number that sends in bulk.",
  "plugin.whatsapp.addConfirm": "Add and link",
  "plugin.whatsapp.linkTitle": "Link {name}",
  "plugin.whatsapp.linkDescription": "Choose how to link this account to WhatsApp on the phone.",
  "plugin.whatsapp.method.label": "How to link",
  "plugin.whatsapp.method.code": "Pairing code",
  "plugin.whatsapp.method.codeHint": "Works without a camera and on a remote computer.",
  "plugin.whatsapp.method.qr": "QR code",
  "plugin.whatsapp.method.qrHint": "Scan it with the phone camera.",
  "plugin.whatsapp.startCode": "Generate code",
  "plugin.whatsapp.startQr": "Show QR code",
  "plugin.whatsapp.starting": "Asking WhatsApp for a code…",
  "plugin.whatsapp.expiresIn": "Expires in {time}",
  "plugin.whatsapp.codeSteps":
    "On the phone: WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead. Then type this code.",
  "plugin.whatsapp.qrSteps":
    "On the phone: WhatsApp › Settings › Linked devices › Link a device. Then point the camera at this code.",
  "plugin.whatsapp.qrLabel": "QR code to link {name}",
  "plugin.whatsapp.newCode": "Generate another code",
  "plugin.whatsapp.newQr": "Show another QR code",
  "plugin.whatsapp.cancelHint":
    "If you cancel, this code can still work until the countdown ends. Ignore it on the phone.",
  "plugin.whatsapp.expired": "The code expired before the phone used it.",
  "plugin.whatsapp.linked": "{name} is linked. WhatsApp sends the recent chats in the next minutes.",
  "plugin.whatsapp.linkedOtherNumber":
    "{name} is linked, but to a number that is not the one you typed. Check the number in the list.",
  "plugin.whatsapp.removeTitle": "Remove {name}?",
  "plugin.whatsapp.removeDescription":
    "This unlinks {name} and deletes its history, media and notes on this computer. You cannot undo this.",
  "plugin.whatsapp.removeDefaultNext": "{next} becomes the default account.",
  "plugin.whatsapp.unlinkTitle": "Unlink {name}?",
  "plugin.whatsapp.unlinkDescription":
    "WhatsApp removes this computer from the linked devices of the number. The history stays here. After this, only the same number can link to this account again; for another number, add a new account.",
  "plugin.whatsapp.disableTitle": "Turn off {name}?",
  "plugin.whatsapp.disableDescription": "Agents stop using {name} until you turn it on again. The history stays.",
  "plugin.whatsapp.notice.restartNeeded":
    "Saved. It applies when the WhatsApp server starts again, for example after Builders Bot restarts.",
  "plugin.whatsapp.notice.keptRunning":
    "Saved. The running WhatsApp server keeps this account on until it stops, because it has no other account on.",
  "plugin.whatsapp.error.unsupportedPlatform":
    "The accounts panel is not available on Windows yet. An agent can link an account from a chat.",
  "plugin.whatsapp.error.commandNotFound": "npx was not found. Install Node.js 22.16 or later, then try again.",
  "plugin.whatsapp.error.timeout": "wazap did not answer in time. Try again.",
  "plugin.whatsapp.error.failed": "wazap could not do this. Try again.",
  "plugin.whatsapp.error.qrNeedsFreeFolder":
    "A QR code needs WhatsApp to be closed in every agent chat. Use the pairing code instead.",
  "plugin.whatsapp.error.serverBusy":
    "Another wazap process uses the wazap folder and does not answer. Close the agent chats that use WhatsApp, or restart Builders Bot, then try again.",
  "plugin.whatsapp.error.invalidPhone": "WhatsApp did not accept this number. Check the country and the area code.",
  "plugin.whatsapp.error.invalidId": "The account id is not valid. Change the nickname.",
  "plugin.whatsapp.error.idTaken": "An account with this id exists. Change the nickname.",
  "plugin.whatsapp.error.alreadyLinked": "This account is already linked.",
  "plugin.whatsapp.error.ownerMismatch":
    "This account belonged to another number. Add a new account for this number, so that the history of the other number stays.",
  "plugin.whatsapp.error.hasHistory":
    "This account keeps the history of an unlinked number. For another number, add a new account.",
  "plugin.whatsapp.error.numberInUse": "Another account has this number. One number is one account.",
  "plugin.whatsapp.error.accountNotFound": "This account no longer exists. Refresh the list.",
  "plugin.whatsapp.error.accountDisabled": "This account is off. Turn it on first.",
  "plugin.whatsapp.error.lastAccount": "wazap needs at least one account. Add another account first.",
  "plugin.whatsapp.error.onlyServed": "Turn on another account before you remove this one.",
  "plugin.whatsapp.error.rateLimited": "WhatsApp asked to wait. Try again in a minute.",
  "plugin.whatsapp.error.restricted": "WhatsApp restricts this number now. Try again later.",
});
