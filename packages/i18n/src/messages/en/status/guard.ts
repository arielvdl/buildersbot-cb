import { defineMessages } from "../../../message";

/** Text that the Guard sends from the backend: the reason on an approval card, and each local finding. */
export const messages = defineMessages("status.guard", {
  "status.guard.askAction": "The Guard asks you to check this step. {reason}",
  "status.guard.askActionReviewed":
    "The Guard and its review model ask you to check this step. {reason} The model says: {detail}",
  "status.guard.askContentFrom":
    "The Guard found possible prompt injection in what {tool} read from {origin}. {reason} Allow lets the agent read it as data. Deny holds it back.",
  "status.guard.askContentTool":
    "The Guard found possible prompt injection in what {tool} gave back. {reason} Allow lets the agent read it as data. Deny holds it back.",
  "status.guard.askContentFromReviewed":
    "The Guard and its review model found possible prompt injection in what {tool} read from {origin}. {reason} The model says: {detail} Allow lets the agent read it as data. Deny holds it back.",
  "status.guard.askContentToolReviewed":
    "The Guard and its review model found possible prompt injection in what {tool} gave back. {reason} The model says: {detail} Allow lets the agent read it as data. Deny holds it back.",
  "status.guard.finding.override": "The content tells the agent to ignore its instructions.",
  "status.guard.finding.newInstructions": "The content gives the agent new instructions.",
  "status.guard.finding.promptLeak": "The content asks the agent to reveal its instructions.",
  "status.guard.finding.roleChange": "The content tries to give the agent a new role.",
  "status.guard.finding.roleMarker": "The content imitates a system or developer message.",
  "status.guard.finding.aiAddressed": "The content addresses instructions to an AI agent.",
  "status.guard.finding.judgeManipulation": "The content tries to make the security check approve it.",
  "status.guard.finding.hiddenUnicodeTags": "The content holds invisible Unicode tag characters.",
  "status.guard.finding.hiddenBidi": "The content holds characters that reverse the reading direction.",
  "status.guard.finding.hiddenZeroWidth": "The content holds many invisible characters.",
  "status.guard.finding.hiddenMarkup": "The content hides instructions in markup that a reader cannot see.",
  "status.guard.finding.imageExfiltration": "The content makes an image link that sends data to another site.",
  "status.guard.finding.exfiltrationRequest": "The content asks to send data to another site.",
  "status.guard.finding.secretRequest": "The content mentions secrets.",
  "status.guard.finding.secretSendRequest": "The content asks to send secrets.",
  "status.guard.finding.remoteCodeRequest": "The content asks to run a script from the network.",
  "status.guard.finding.reverseShell": "The command opens a remote shell.",
  "status.guard.finding.encodedExecution": "The command runs hidden encoded code.",
  "status.guard.finding.pipeToShell": "The command runs a script from the network at once.",
  "status.guard.finding.secretFileUpload": "The action reads secrets and sends them over the network.",
  "status.guard.finding.secretVariableInTransfer": "The action sends a secret variable over the network.",
  "status.guard.finding.secretInTransfer": "The action sends a secret value out of this computer.",
  "status.guard.finding.dataInUrl": "The URL carries a block of data.",
  "status.guard.finding.credentialsInUrl": "The URL carries a user name or a password.",
  "status.guard.finding.pasteHost": "The action sends data to a site that keeps anonymous uploads.",
  "status.guard.finding.pageScriptExfiltration": "The page script reads cookies or storage and sends them out.",
  "status.guard.finding.pageScriptNetwork": "The page script sends a network request.",
  "status.guard.finding.vendorInstruction":
    "The result asks the agent to take a step for a vendor, such as to install a tool, run a script, sign up or star a project.",
  "status.guard.finding.cookieInTransfer":
    "The action sends a cookie, a session or a sign-in token out of this computer.",
  "status.guard.finding.textInTransfer":
    "The action sends a long free text out of this computer, such as a pasted chat.",
  "status.guard.finding.blobInTransfer": "The action sends a long block of encoded data out of this computer.",
  "status.guard.finding.incompleteScan": "The Guard could not read all of this item.",
});
