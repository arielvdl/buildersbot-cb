// @vitest-environment node

import { describe, expect, it } from "vitest";
import { redactWazapText } from "./wazap-cli";

describe("wazap log redaction", () => {
  it("removes phone numbers in every form that wazap prints", () => {
    const lines = [
      '"+15550100" is not a phone number in international format.',
      "linked as Ana (+15 5xx xxx x)",
      "was +44 7xx xxx xxx",
      "owner 15550100:12@s.whatsapp.net",
      "phone 1 555 0100 refused",
      "number +1-555-0100",
    ];
    for (const line of lines) {
      const redacted = redactWazapText(line);
      expect(redacted).not.toMatch(/\d{4,}/);
      expect(redacted).not.toMatch(/5550100|555 0100|555-0100|5xx/);
    }
  });

  it("removes pairing codes, quoted ids and names, and colour codes", () => {
    const redacted = redactWazapText(
      '\u001b[32mpairing code: ABCD-EF12\u001b[0m\nNo account "sofia". Account "Ana Souza" added.',
    );
    expect(redacted).not.toContain("ABCD-EF12");
    expect(redacted).not.toContain("sofia");
    expect(redacted).not.toContain("Ana Souza");
    expect(redacted).not.toContain("\u001b[");
    expect(redacted).toContain("[code]");
  });

  it("keeps the words that say what failed", () => {
    expect(redactWazapText("wazap is running (pid 4242).")).toBe("wazap is running (pid 4242).");
    expect(redactWazapText("Cannot remove the last account.")).toBe("Cannot remove the last account.");
  });
});
