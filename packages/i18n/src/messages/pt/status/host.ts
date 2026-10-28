import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  "status.host.registered": "Este Builders Bot foi registrado para acesso por WebRTC.",
  "status.host.keyRotated": "Chave do servidor alterada. Os dispositivos pareados continuam pareados.",
  "status.host.identityUpdated": "Identidade do servidor atualizada.",
  "status.host.starting": "Iniciando o computador anfitrião WebRTC…",
  "status.host.ready": "Este Builders Bot está pronto para conexões WebRTC.",
  "status.host.stopping": "Tornando este Builders Bot privado…",
  "status.host.private": "Este Builders Bot é privado.",
} as const satisfies PartialTranslation<typeof source>;
