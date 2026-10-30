import { defineMessages } from "../../message";

export const messages = defineMessages("dialog", {
  // Native file pickers.
  "dialog.chooseSiteDirectory": "Choose a static site directory",
  "dialog.chooseSkill": "Choose a skill folder or ZIP",
  "dialog.filter.skillPackages": "Skill packages",
  "dialog.filter.images": "Images",
  "dialog.filter.supportedFiles": "Supported files",
  "dialog.filter.attachment": "Attachment",
  "dialog.filter.zipArchive": "ZIP archive",
  "dialog.filter.jsonDocument": "JSON document",
  "dialog.chooseAgentExport": "Choose an agent export",
  "dialog.chooseHermesFolder": "Choose the Hermes folder",
  "dialog.filter.agentExports": "Agent exports",
  "dialog.chooseVaultCsv": "Choose a password export",
  "dialog.filter.csv": "CSV files",
  "dialog.saveExportSkill": "Save the export skill",
  "dialog.saveTransfer": "Save the transfer file",
  "dialog.chooseTransfer": "Choose a transfer file",
  "dialog.filter.transfer": "Builders Bot transfer files",
  "dialog.chooseExternalLinkApp": "Choose a browser",
  "dialog.filter.applications": "Applications",
  // The one question before an agent uses the Chrome sign-in of a site.
  "dialog.siteSession.message": "Use your Chrome sign-in for {site}?",
  "dialog.siteSession.detail":
    "An agent asked to open {site} already signed in. Builders Bot copies only the cookies of {site} from your Chrome into the Builders Bot browser, and no other site. macOS may ask once to let it read the Chrome key.",
  "dialog.siteSession.always": "Always allow {site}",
  "dialog.siteSession.once": "Allow this time",
  "dialog.siteSession.deny": "Do not allow",
});
