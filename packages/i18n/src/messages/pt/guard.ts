import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/guard";

export const messages = {
  "guard.tab.title": "Guarda",
  "guard.tab.description": "Confere o que entra e o que sai do trabalho dos seus agentes",
  "guard.section.title": "Guarda",
  "guard.level.title": "Nível",
  "guard.level.description": "Quão cuidadoso o Guarda é. Leve é o padrão.",
  "guard.level.off": "Desligado (dormindo)",
  "guard.level.light": "Leve",
  "guard.level.strict": "Exigente",
  "guard.level.veryStrict": "Muito exigente",
  "guard.level.custom": "Personalizado",
  "guard.level.comingSoon": "{level} (em breve)",
  "guard.level.offExplain":
    "O Guarda está dormindo e não confere nada. Escolha Desligado só para desligar o Guarda por completo. Você pode ligá-lo de novo quando quiser.",
  "guard.level.lightExplain":
    "No nível Leve, o Guarda procura injeção de prompt. Ele confere o conteúdo que entra no trabalho de um agente, como páginas da web e resultados de ferramentas, e as ações que saem, como URLs, texto digitado e posts em chats. Uma verificação local rápida lê tudo primeiro. Um modelo pequeno revisa só o que parece suspeito. Quando o Guarda encontra um risco claro, ele pergunta a você no cartão de aprovação. Ele nunca para o trabalho sozinho.",
  "guard.model.title": "Modelo de revisão",
  "guard.model.description":
    "O modelo que revisa os itens suspeitos. Ele recebe só um trecho curto do item, no máximo 2.000 caracteres, com os segredos mascarados. Ele nunca recebe a conversa.",
  "guard.model.localOnly": "Só a verificação local",
  "guard.model.recommended": "{name} (recomendado)",
  "guard.model.label": "{provider} · {model}",
  "guard.model.slower":
    "Este modelo inicia o provedor a cada revisão, então a revisão pode demorar mais. O Builder Fast é mais rápido.",
  "guard.notice.signedOut.title": "Sem login no Cultura Builder",
  "guard.notice.signedOut.description":
    "O Guarda usa só a verificação local e não envia nada pela rede. Entre no Cultura Builder nas configurações de provedor para ativar a revisão pelo modelo.",
  "guard.notice.localOnly": "O Guarda usa só a verificação local. Nada vai pela rede.",
  "guard.coverage.title": "O que o Guarda confere agora",
  "guard.coverage.description":
    "As páginas que o navegador interno e o navegador Playwright compartilhado leem; as URLs, o texto, os scripts e os arquivos que o navegador envia; posts em chats, anexos, sites e novos servidores MCP; e os comandos que um agente pede para você aprovar. As ferramentas que um provedor roda no próprio processo, e os servidores MCP que ele acessa direto, ainda não são conferidos.",
  "guard.loadFailed": "A configuração do Guarda não carregou.",
  "guard.saveFailed": "A configuração do Guarda não foi salva.",
} as const satisfies PartialTranslation<typeof source>;
