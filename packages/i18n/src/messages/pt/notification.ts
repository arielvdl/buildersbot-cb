import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.lidAwakeBatteryLow": "O modo com a tampa fechada parou: a bateria está baixa.",
  "notification.lidAwakeTooHot": "O modo com a tampa fechada parou: o computador está quente demais.",
  "notification.lidAwakeTimeLimit": "O modo com a tampa fechada parou: o limite de tempo foi atingido.",
  "notification.lidAwakeSleepDisabled":
    "O repouso está desligado neste Mac, e o Builders Bot não pediu isso. Abra Configurações › Geral no Builders Bot e escolha Restaurar repouso normal.",
  "notification.needsInput": "Precisa de uma resposta sua.",
  "notification.needsApproval": "Precisa da sua aprovação.",
  "notification.needsBrowserStep": "Precisa que você conclua uma etapa no navegador.",
  "notification.needsApprovalFor": "Precisa da sua aprovação: {action}",
  "notification.finished": "Terminou o trabalho.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Uma etapa aguarda sua aprovação.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Um fluxo de trabalho tem um novo resultado.",
  "notification.failed": "Parou com um erro.",
  "notification.channelTitle": "{agent} em {channel}",
  "notification.channelMessage": "Enviou uma mensagem.",
  "notification.usageLimit.title": "A conta {provider} atingiu o limite",
  "notification.usageLimit.body": {
    one: "{count} agente aguarda. O Builders Bot tentará de novo mais tarde.",
    other: "{count} agentes aguardam. O Builders Bot tentará de novo mais tarde.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agente aguarda. O limite é renovado {reset}.",
    other: "{count} agentes aguardam. O limite é renovado {reset}.",
  },
  "notification.machineAlert.disk": "{server}: disco {percent} cheio",
  "notification.machineAlert.memory": "{server}: memória {percent} em uso",
  "notification.machineAlert.cpu": "{server}: CPU {percent} ocupada",
  "notification.machineAlert.body":
    "Passou do nível de alerta de {level}. Veja Configurações do servidor > Armazenamento.",
  "notification.test": "As notificações estão funcionando.",
  "notification.soundPreview": "Este é o som que você escolheu.",
  "notification.welcome": "O Builders Bot avisará aqui quando um agente precisar de você.",
  "notification.toast.region": "Notificações",
  "notification.toast.close": "Fechar notificação",
} as const satisfies PartialTranslation<typeof source>;
