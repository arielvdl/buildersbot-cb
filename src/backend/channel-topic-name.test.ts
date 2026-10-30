// @vitest-environment node
// The name a fresh tab takes from the channel model: the answer is cleaned to a title, and the
// prompt carries the request but not a whole log.
import { describe, expect, it } from "vitest";
import { cleanTopicName, topicNamePrompt } from "./channel-topic-name";

describe("the name a model answers with", () => {
  it("keeps the first line without fences, quotes, labels or a final period", () => {
    expect(cleanTopicName('```text\n"Revisar login"\n```')).toBe("Revisar login");
    expect(cleanTopicName("Tab: Ajustar o filtro.")).toBe("Ajustar o filtro");
    expect(cleanTopicName("1. Correção do relatório")).toBe("Correção do relatório");
    expect(cleanTopicName("  **Renomear   abas**  ")).toBe("Renomear abas");
  });

  it("cuts a phrase to three words", () => {
    expect(cleanTopicName("Corrigir o filtro de abas do canal")).toBe("Corrigir o filtro");
  });

  it("refuses an empty answer", () => {
    expect(cleanTopicName("")).toBeNull();
    expect(cleanTopicName("   \n  ")).toBeNull();
    expect(cleanTopicName('""')).toBeNull();
  });
});

describe("the prompt", () => {
  it("names the channel and cuts the request", () => {
    const prompt = topicNamePrompt("Builders Bot", `${"x".repeat(2000)}fim`);
    expect(prompt).toContain("Channel: Builders Bot");
    expect(prompt).toContain("2 or 3 words");
    expect(prompt).not.toContain("fim");
    expect(prompt.length).toBeLessThan(1_800);
  });
});
