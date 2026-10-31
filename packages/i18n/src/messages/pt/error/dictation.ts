import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/dictation";

export const messages = {
  "error.dictation.microphone": "O Builders Bot não conseguiu abrir o microfone.",
  "error.dictation.noWindow": "Abra a janela do Builders Bot primeiro, para ele poder usar o microfone.",
  "error.dictation.empty": "Não deu para ouvir nada. Tente de novo.",
  "error.dictation.tooLong": "O ditado ficou longo demais.",
  "error.dictation.failed": "O Builders Bot não conseguiu transcrever o ditado.",
  "error.dictation.paste": "A transcrição está na área de transferência. Use o atalho de colar no app.",
  "error.dictation.pastePermission":
    "A transcrição está na área de transferência. Permita o Builders Bot em Ajustes do Sistema → Privacidade → Acessibilidade para colar, ou use o atalho de colar.",
  "error.dictation.shortcutTaken": "Outro app já usa essa combinação.",
  "error.dictation.system.platform": "Este sistema não tem reconhecimento de fala. O ditado usa o modelo de voz.",
  "error.dictation.system.missing":
    "O reconhecimento de fala do sistema não está instalado. No Mac, ligue o Ditado em Ajustes do Sistema → Teclado; no Windows, adicione o pacote de idioma.",
  "error.dictation.system.language":
    "O sistema não reconhece este idioma. Adicione o idioma nos ajustes do sistema ou escolha outro em Voz.",
  "error.dictation.system.permission":
    "O Builders Bot não pode usar o reconhecimento de fala. Permita em Ajustes do Sistema → Privacidade → Reconhecimento de Fala, ou use o modelo de voz.",
} satisfies PartialTranslation<typeof source>;
