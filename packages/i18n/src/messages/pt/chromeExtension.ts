import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/chromeExtension";

export const messages = {
  "chromeExtension.extName": "Builders Bot",
  "chromeExtension.extDescription":
    "Deixa os agentes de IA do app Builders Bot para macOS trabalharem em abas do seu Chrome, num grupo de abas para cada projeto.",
  "chromeExtension.actionTitle": "Builders Bot",
  "chromeExtension.command.stopAll": "Parar todos os agentes no Chrome",
  "chromeExtension.badge.controlledBy": "Controlada por {agent} · {project}",

  "chromeExtension.popup.connected": "Conectado ao Builders Bot",
  "chromeExtension.popup.appOffline": "O Builders Bot está fechado",
  "chromeExtension.popup.notPaired": "Ainda não conectado",
  "chromeExtension.popup.noHost": "O Builders Bot não está configurado neste Mac",
  "chromeExtension.popup.connecting": "Conectando…",
  "chromeExtension.popup.connect": "Conectar",
  "chromeExtension.popup.stopAll": "Parar tudo",
  "chromeExtension.popup.resume": "Retomar",
  "chromeExtension.popup.stoppedNote": "Os agentes estão parados. Nada age nas suas abas até você retomar.",
  "chromeExtension.popup.noProjects": "Nenhum agente trabalha no Chrome agora.",
  "chromeExtension.popup.pause": "Pausar",
  "chromeExtension.popup.tabCount": "Abas: {count}",
  "chromeExtension.popup.blockedTitle": "Sites bloqueados",
  "chromeExtension.popup.blockedHelp":
    "Os agentes não podem usar estes sites. Libere um só se este projeto precisar dele.",
  "chromeExtension.popup.allow": "Liberar",
  "chromeExtension.popup.allowPrompt": "Para liberar {site} neste projeto, toque nele abaixo.",
  "chromeExtension.popup.allowedTitle": "Liberados neste projeto",
  "chromeExtension.popup.blockAgain": "Bloquear de novo",
  "chromeExtension.popup.cancel": "Cancelar",
  "chromeExtension.popup.disconnect": "Desconectar",
  "chromeExtension.popup.choiceMismatch": "Esse não era o site. Nada mudou.",

  "chromeExtension.welcome.title": "Builders Bot no seu Chrome",
  "chromeExtension.welcome.intro":
    "Os agentes de IA do app Builders Bot podem trabalhar em abas deste Chrome, num grupo de abas para cada projeto. Eles usam os sites em que você já entrou, a partir deste computador.",
  "chromeExtension.welcome.readsTitle": "O que a extensão lê",
  "chromeExtension.welcome.reads":
    "Só as abas dentro de um grupo de projeto do Builders Bot, e só enquanto um agente trabalha nelas: a página, o endereço, o título e o que o agente digita ou clica. Senhas, códigos e números de cartão vão do app para a página e nunca voltam.",
  "chromeExtension.welcome.whereTitle": "Para onde vai",
  "chromeExtension.welcome.where":
    "Só para o app Builders Bot neste Mac, por um canal local cifrado. A extensão não faz nenhuma conexão de rede. O app pode enviar o conteúdo da página ao provedor de IA que você escolheu. O Chrome pode sincronizar o nome de um grupo de projeto com seus outros aparelhos.",
  "chromeExtension.welcome.neverTitle": "O que ela nunca toca",
  "chromeExtension.welcome.never":
    "Abas fora dos grupos de projeto, janelas anônimas, bancos, corretoras, cofres de senha, contas Google e Apple e sites de governo, como o gov.br.",
  "chromeExtension.welcome.stopTitle": "Como parar",
  "chromeExtension.welcome.stop":
    "O Chrome mostra uma faixa enquanto um agente trabalha. Toque em Cancelar nessa faixa, em Parar tudo no menu da extensão, ou use Alt+Shift+K.",
  "chromeExtension.welcome.pairTitle": "Conectar ao Builders Bot",
  "chromeExtension.welcome.showWords": "No Builders Bot, escolha estas palavras:",
  "chromeExtension.welcome.chooseWords": "Depois, toque nas palavras que o Builders Bot mostra:",
  "chromeExtension.welcome.notExpected":
    "Se o Builders Bot não mostra agora um cartão com estas palavras, toque em Agora não.",
  "chromeExtension.welcome.notNow": "Agora não",
  "chromeExtension.welcome.paired": "Conectado. Pode fechar esta aba.",
  "chromeExtension.welcome.mismatch": "As palavras não bateram. Nada foi conectado.",
  "chromeExtension.welcome.declined": "Nada foi conectado.",
  "chromeExtension.welcome.tryAgain": "Tentar de novo",
  "chromeExtension.welcome.waiting": "Aguardando o Builders Bot…",
  "chromeExtension.welcome.noHost":
    "O Builders Bot não está instalado neste Mac, ou ainda não configurou a conexão com o Chrome.",
  "chromeExtension.welcome.openApp": "Abrir o Builders Bot",
  "chromeExtension.welcome.restart": "Se você acabou de configurar no Builders Bot, reinicie o Chrome.",
  "chromeExtension.welcome.unsupported":
    "Esta extensão precisa do app Builders Bot para macOS. Ela ainda não funciona neste sistema.",
  "chromeExtension.welcome.pin": "Fixe o ícone do Builders Bot na barra para ver os agentes e pará-los.",
} as const satisfies PartialTranslation<typeof source>;
