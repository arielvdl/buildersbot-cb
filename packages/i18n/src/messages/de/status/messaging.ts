import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/messaging";

export const messages = {
  "status.messaging.working": "Wird bearbeitet…",
  "status.messaging.queued": "Wartet: Builders Bot bearbeitet eine andere Anfrage. Die Antwort erscheint hier.",
  "status.messaging.busy": "Zu viele Anfragen warten. Versuche es später erneut.",
  "status.messaging.failed":
    "Builders Bot konnte diese Anfrage nicht abschließen. Der Builders Bot-Host hat die Details.",
  "status.messaging.noAnswer": "Builders Bot wurde ohne schriftliche Antwort fertig.",
  "status.messaging.noAgent": "Hier kann noch kein Agent antworten. Füge den Slack Orchestrator in Builders Bot hinzu.",
  "status.messaging.delegated": "Ein Teamkollege arbeitet daran. Die Antwort erscheint hier.",
  "status.messaging.stopped": "Gestoppt.",
  "status.messaging.stop": "Stoppen",
  "status.messaging.approvalTitle": "Builders Bot bittet um Genehmigung, um fortzufahren.",
  "status.messaging.approvalCommand": "Einen Befehl ausführen",
  "status.messaging.approvalFileChange": "Dateien ändern",
  "status.messaging.approvalPermissions": "Weitere Berechtigungen erhalten",
  "status.messaging.approve": "Genehmigen",
  "status.messaging.deny": "Ablehnen",
  "status.messaging.approvedBy": "Von {user} genehmigt.",
  "status.messaging.deniedBy": "Von {user} abgelehnt.",
  "status.messaging.answeredOnHost": "Auf dem Builders Bot-Host beantwortet.",
  "status.messaging.requestInactive": "Diese Anfrage ist nicht mehr aktiv.",
  "status.messaging.onlyRequester": "Nur {user} kann dies tun. Der Builders Bot-Host kann ebenfalls antworten.",
  "status.messaging.hostOnly": "Nur der Builders Bot-Host kann diese Anfrage beantworten.",
  "status.messaging.filesSkipped": "Einige Dateien wurden nicht gesendet: {names}.",
  "status.messaging.orchestratorName": "Slack Orchestrator",
  "status.messaging.orchestratorTitle": "Antwortet in Slack und fragt das Team",
  "status.messaging.discordNoAgent":
    "Hier kann noch kein Agent antworten. Füge den Discord Orchestrator in Builders Bot hinzu.",
  "status.messaging.discordOrchestratorName": "Discord Orchestrator",
  "status.messaging.discordOrchestratorTitle": "Antwortet in Discord und fragt das Team",
  "status.messaging.integrationsSection": "Integrationen",
  "status.messaging.signInReceived":
    "Builders Bot hat die Slack-Installation empfangen. Du kannst diesen Tab schließen.",
  "status.messaging.signInUnknown":
    "Builders Bot hat diese Slack-Installation nicht gestartet. Starte sie erneut in Builders Bot.",
  "status.messaging.telegramNoAgent":
    "Hier kann noch kein Agent antworten. Füge den Telegram-Orchestrator in Builders Bot hinzu.",
  "status.messaging.telegramLinked":
    "Builders Bot ist mit diesem Chat verbunden. Erwähne {bot} oder antworte auf eine Nachricht von Builders Bot, um die Agenten zu fragen.",
  "status.messaging.telegramOrchestratorName": "Telegram-Orchestrator",
  "status.messaging.telegramOrchestratorTitle": "Antwortet in Telegram und fragt das Team",
} as const satisfies PartialTranslation<typeof source>;
