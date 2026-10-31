import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/messaging";

// Not translated yet: the screen shows the English text.
export const messages = {
  "status.messaging.working": "Уже работаю…",
  "status.messaging.queued": "Ожидание: Builders Bot занят другим запросом. Ответ придёт сюда.",
  "status.messaging.busy": "В очереди слишком много запросов. Повторите попытку позже.",
  "status.messaging.failed": "Builders Bot не смог завершить этот запрос. Подробности — на хосте Builders Bot.",
  "status.messaging.noAnswer": "Builders Bot завершил работу без письменного ответа.",
  "status.messaging.noAgent":
    "Пока нет агента, который мог бы здесь ответить. Добавьте Оркестратора Slack в Builders Bot.",
  "status.messaging.delegated": "Над этим работает один из агентов. Ответ придёт сюда.",
  "status.messaging.stopped": "Остановлено.",
  "status.messaging.stop": "Остановить",
  "status.messaging.approvalTitle": "Builders Bot просит подтверждения, чтобы продолжить.",
  "status.messaging.approvalCommand": "Выполнить команду",
  "status.messaging.approvalFileChange": "Изменить файлы",
  "status.messaging.approvalPermissions": "Получить дополнительные разрешения",
  "status.messaging.approve": "Одобрить",
  "status.messaging.deny": "Отклонить",
  "status.messaging.approvedBy": "Одобрено: {user}.",
  "status.messaging.deniedBy": "Отклонено: {user}.",
  "status.messaging.answeredOnHost": "Отвечено на хосте Builders Bot.",
  "status.messaging.requestInactive": "Этот запрос больше не активен.",
  "status.messaging.onlyRequester": "Это может сделать только {user}. Ответить также может хост Builders Bot.",
  "status.messaging.hostOnly": "На этот запрос может ответить только хост Builders Bot.",
  "status.messaging.filesSkipped": "Некоторые файлы не отправлены: {names}.",
  "status.messaging.orchestratorName": "Оркестратор Slack",
  "status.messaging.orchestratorTitle": "Отвечает в Slack и обращается к команде",
  "status.messaging.discordNoAgent":
    "Пока нет агента, который мог бы здесь ответить. Добавьте Оркестратора Discord в Builders Bot.",
  "status.messaging.discordOrchestratorName": "Оркестратор Discord",
  "status.messaging.discordOrchestratorTitle": "Отвечает в Discord и обращается к команде",
  "status.messaging.integrationsSection": "Интеграции",
  "status.messaging.signInReceived": "Builders Bot получил установку Slack. Эту вкладку можно закрыть.",
  "status.messaging.signInUnknown": "Builders Bot не начинал эту установку Slack. Начните её заново в Builders Bot.",
  "status.messaging.telegramNoAgent":
    "Пока нет агента, который мог бы здесь ответить. Добавьте Оркестратора Telegram в Builders Bot.",
  "status.messaging.telegramLinked":
    "Builders Bot подключён к этому чату. Упомяните {bot} или ответьте на сообщение Builders Bot, чтобы обратиться к агентам.",
  "status.messaging.telegramOrchestratorName": "Оркестратор Telegram",
  "status.messaging.telegramOrchestratorTitle": "Отвечает в Telegram и обращается к команде",
} as const satisfies PartialTranslation<typeof source>;
