import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/guard";

export const messages = {
  "guard.tab.title": "Guarda",
  "guard.tab.description": "Confere o que entra e o que sai do trabalho dos seus agentes",
  "guard.section.title": "Guarda",
  "guard.level.title": "Nível",
  "guard.level.description": "Quão cuidadoso o Guarda é. Leve é o padrão.",
  "guard.level.off": "Desligado (dormindo)",
  "guard.level.offShort": "Desligado",
  "guard.level.light": "Leve",
  "guard.level.strict": "Exigente",
  "guard.level.veryStrict": "Muito exigente",
  "guard.level.custom": "Personalizado",
  "guard.level.comingSoon": "{level} (em breve)",
  "guard.level.choose": "Escolha o nível",
  "guard.level.chosen": "Escolhido",
  "guard.level.soon": "Em breve",
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
  "guard.notice.unavailable.title": "O modelo revisor não está disponível",
  "guard.notice.unavailable.description":
    "Agora o Guarda usa só a verificação local: conteúdo suspeito recebe uma nota, e uma ação suspeita passa. Escolha outro modelo ou conecte o provedor dele de novo.",
  "guard.coverage.title": "O que o Guarda confere agora",
  "guard.coverage.description":
    "As páginas que o navegador interno e o navegador Playwright compartilhado leem; as URLs, o texto, os scripts e os arquivos que o navegador envia; posts em chats, anexos, sites e novos servidores MCP; e os comandos que um agente pede para você aprovar. As ferramentas que um provedor roda no próprio processo, e os servidores MCP que ele acessa direto, ainda não são conferidos.",
  "guard.ask.title": "Quando o Guarda pergunta a você",
  "guard.ask.card":
    "No app do computador, ele pergunta no cartão de aprovação, com o título “O Guarda pede sua confirmação”. O cartão não tem “Sempre permitir”, e o acesso total não responde por você. No celular e no cliente web, a pergunta ainda aparece como uma aprovação comum, e o cliente web ainda oferece “Sempre permitir”.",
  "guard.ask.remember":
    "Quando você permite um item, ele não pergunta de novo por 10 minutos sobre o mesmo item, do mesmo agente, na mesma conversa. Uma recusa não fica guardada.",
  "guard.ask.owner":
    "Quando um segredo pode sair do computador, só o dono deste computador responde, não um membro da equipe.",
  "guard.leaves.title": "O que sai do computador",
  "guard.leaves.suspicious":
    "Só um item que a verificação local marca como suspeito vai para o modelo de revisão: um trecho de no máximo 2.000 caracteres, com segredos e e-mails mascarados.",
  "guard.leaves.never": "Nunca a conversa, as instruções do agente ou outros resultados de ferramentas.",
  "guard.leaves.log":
    "O registro do Guarda guarda a ferramenta, a decisão e o horário, nunca o conteúdo. O app não guarda uma lista das decisões passadas.",
  "guard.related.title": "Relacionados",
  "guard.related.taskReviewer": "Usa este modelo de revisão para decidir sobre tarefas lentas dos canais.",
  "guard.related.messageReview":
    "Outra verificação, fora do Guarda: lê cada mensagem antes de o turno começar. A opção fica em Geral.",
  "guard.joined.description":
    "{server} é outro servidor, com o próprio Guarda. Esta página muda só o Guarda deste computador: este app ainda não muda o de {server}.",
  "guard.loadFailed": "A configuração do Guarda não carregou.",
  "guard.saveFailed": "A configuração do Guarda não foi salva.",
  "guard.siren.label": "A sirene do Guarda",
  "guard.siren.status.loading": "Lendo o estado do Guarda…",
  "guard.siren.status.off": "Dormindo. O Guarda não confere nada.",
  "guard.siren.status.asking": "Perguntando a você agora. Responda no cartão da conversa.",
  "guard.siren.status.localOnly": "Calmo. A verificação local lê tudo, e nada sai pela rede.",
  "guard.siren.status.signedOut": "Calmo. Só a verificação local roda: você não entrou no Cultura Builder.",
  "guard.siren.status.unavailable": "Calmo. Só a verificação local roda: o modelo de revisão não está disponível.",
  "guard.siren.status.ready": "Calmo. A verificação local lê tudo, e o modelo revisa o que parece suspeito.",
} as const satisfies PartialTranslation<typeof source>;
