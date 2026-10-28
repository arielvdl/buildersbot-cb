import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/dictation";

export const messages = {
  "error.dictation.microphone": "O Builders Bot não conseguiu abrir o microfone.",
  "error.dictation.empty": "Não deu para ouvir nada. Tente de novo.",
  "error.dictation.tooLong": "O ditado ficou longo demais.",
  "error.dictation.failed": "O Builders Bot não conseguiu transcrever o ditado.",
  "error.dictation.paste": "A transcrição está na área de transferência. Use o atalho de colar no app.",
  "error.dictation.pastePermission":
    "A transcrição está na área de transferência. Permita o Builders Bot em Ajustes do Sistema → Privacidade → Acessibilidade para colar, ou use o atalho de colar.",
  "error.dictation.shortcutTaken": "Outro app já usa essa combinação.",
} satisfies PartialTranslation<typeof source>;
