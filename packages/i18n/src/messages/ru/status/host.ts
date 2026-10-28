import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  "status.host.registered": "Этот Builders Bot зарегистрирован для доступа через WebRTC.",
  "status.host.keyRotated": "Ключ сервера изменён. Связанные устройства остаются связанными.",
  "status.host.identityUpdated": "Идентификатор сервера обновлён.",
  "status.host.starting": "Запуск хоста WebRTC…",
  "status.host.ready": "Этот Builders Bot готов к подключениям WebRTC.",
  "status.host.stopping": "Перевод этого Builders Bot в приватный режим…",
  "status.host.private": "Этот Builders Bot приватный.",
} as const satisfies PartialTranslation<typeof source>;
