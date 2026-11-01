import { defineMessages } from "../../message";

/** The Guard page in Settings. */
export const messages = defineMessages("guard", {
  "guard.tab.title": "Guard",
  "guard.tab.description": "Checks what enters and leaves your agents' work",
  "guard.section.title": "Guard",
  "guard.level.title": "Level",
  "guard.level.description": "How careful the Guard is. Light is the default.",
  "guard.level.off": "Off (asleep)",
  "guard.level.light": "Light",
  "guard.level.strict": "Strict",
  "guard.level.veryStrict": "Very strict",
  "guard.level.custom": "Custom",
  "guard.level.comingSoon": "{level} (coming soon)",
  "guard.level.offExplain":
    "The Guard is asleep and checks nothing. Choose Off only to turn the Guard off completely. You can turn it on again at any time.",
  "guard.level.lightExplain":
    "At Light, the Guard looks for prompt injection. It checks content that enters an agent's work, such as web pages and tool results, and actions that leave it, such as URLs, typed text and chat posts. A fast local check reads everything first. A small model reviews only what looks suspicious. When the Guard finds a clear risk, it asks you on the approval card. It never stops the work by itself.",
  "guard.model.title": "Review model",
  "guard.model.description":
    "The model that reviews suspicious items. It gets only a short part of the item, at most 2,000 characters, with secrets masked. It never gets the conversation.",
  "guard.model.localOnly": "Local check only",
  "guard.model.recommended": "{name} (recommended)",
  "guard.model.label": "{provider} · {model}",
  "guard.model.slower":
    "This model starts its provider for each review, so a review can take longer. Builder Fast is quicker.",
  "guard.notice.signedOut.title": "Not signed in to Cultura Builder",
  "guard.notice.signedOut.description":
    "The Guard uses only the local check and sends nothing over the network. Sign in to Cultura Builder in the provider settings to add the model review.",
  "guard.notice.localOnly": "The Guard uses only the local check. Nothing goes over the network.",
  "guard.notice.unavailable.title": "The review model is not available",
  "guard.notice.unavailable.description":
    "The Guard uses only the local check now: suspicious content gets a note, and a suspicious action passes. Choose another model, or connect its provider again.",
  "guard.coverage.title": "What the Guard checks now",
  "guard.coverage.description":
    "Pages that the built-in browser and the shared Playwright browser read; the URLs, text, scripts and files that the browser sends; chat posts, attachments, sites and new MCP servers; and the commands that an agent asks you to approve. Tools that a provider runs in its own process, and MCP servers that it reaches directly, are not checked yet.",
  "guard.ask.title": "When the Guard asks you",
  "guard.ask.card":
    "It asks on the approval card, with the title “The Guard asks you to confirm”. The card has no “Always allow”, and Full access does not answer it for you.",
  "guard.ask.remember":
    "When you allow an item, it does not ask again for 10 minutes about the same item of the same agent in the same conversation. A decline is not kept.",
  "guard.ask.owner":
    "When a secret may leave the computer, only the owner of this computer can answer, not a team member.",
  "guard.leaves.title": "What leaves the computer",
  "guard.leaves.suspicious":
    "Only an item that the local check marks as suspicious goes to the review model: an excerpt of at most 2,000 characters, with secrets and emails masked.",
  "guard.leaves.never": "Never the conversation, the agent's instructions or other tool results.",
  "guard.leaves.log":
    "The Guard's log keeps the tool, the decision and the time, never the content. The app keeps no list of past decisions.",
  "guard.related.title": "Related",
  "guard.related.taskReviewer": "It uses this review model to decide about slow channel tasks.",
  "guard.joined.description":
    "{server} is another server, with its own Guard. This page changes the Guard of this computer only: this app cannot change the one of {server} yet.",
  "guard.loadFailed": "The Guard setting did not load.",
  "guard.saveFailed": "The Guard setting was not saved.",
});
