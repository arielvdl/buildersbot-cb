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
  "guard.coverage.title": "What the Guard checks now",
  "guard.coverage.description":
    "Pages that the built-in browser reads; the URLs, text and page scripts that it sends; chat posts; and the commands that an agent asks you to approve. Tools that a provider runs inside its own process are not checked yet.",
  "guard.loadFailed": "The Guard setting did not load.",
  "guard.saveFailed": "The Guard setting was not saved.",
});
