import { localizeSourceText, sourceText } from "@openbot/i18n";
import { describe, expect, it } from "vitest";

/** The reason that every version stored on a channel task the provider did not start. */
const STORED_REASON = "The provider could not start this assignment. Resume to try again.";

describe("the reason of a stopped channel task", () => {
  it("keeps the English that older versions stored", () => {
    expect(sourceText("error.backend.channelStartFailed")).toBe(STORED_REASON);
  });

  it("shows in the language of the reader, also when an older version stored it", () => {
    expect(localizeSourceText(STORED_REASON, "pt")).toBe(
      "O provedor não conseguiu iniciar esta tarefa. Toque em Continuar para tentar de novo.",
    );
    expect(localizeSourceText(STORED_REASON, "en")).toBe(STORED_REASON);
  });
});
