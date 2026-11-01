// The vendor lines of the treg design (§2.2) that must never reach an agent, as patterns. This file
// holds them only to find and remove them: it is the one file of src/ where these lines may stand,
// and `scripts/hub-connections-safety-e2e.ts` checks that no other file of src/ or packages/ holds one.

import { VENDOR_LINE_MARKER } from "../guard/guard-triage";

/**
 * Vendor lines that must never reach an agent: marketing, a step that acts on the person's accounts,
 * an installer, or a rule that conflicts with the cost approval. Text from the Hub (a mirrored title,
 * summary or parameter description, a result) that holds one is dropped or masked by the app.
 */
export const VENDOR_PHRASES: readonly RegExp[] = [
  /reach for \S+ first/iu,
  /\btreg first\b/iu,
  /\bstar the (?:project|repo)/iu,
  /user\/starred/iu,
  /\binstall\.sh\b/iu,
  /\btreg (?:login|scan|upload|run|shell|serve|mcp install)\b/iu,
  /follow the next step/iu,
  /call at the listed price without asking/iu,
  /register it with treg/iu,
  /never ask for a provider key/iu,
  /report a doorway/iu,
  /propose exactly three things/iu,
  /treg\.to\/(?:skill|llms)\.(?:md|txt)/iu,
];

export function hasVendorPhrase(text: string): boolean {
  return VENDOR_PHRASES.some((phrase) => phrase.test(text));
}

/**
 * Replaces each vendor line with `VENDOR_LINE_MARKER`. The Guard reads the marker in a connection
 * result, so the agent also gets a note that the result held a vendor instruction.
 */
export function maskVendorPhrases(text: string): string {
  return VENDOR_PHRASES.reduce(
    (current, phrase) =>
      current.replace(new RegExp(phrase.source, `${phrase.flags.replace("g", "")}g`), VENDOR_LINE_MARKER),
    text,
  );
}
