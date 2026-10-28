import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/menu";

export const messages = {
  "menu.stopAllAgents": "Parar todos os agentes",
  "menu.checkForUpdates": "Buscar atualizações…",
  "menu.preferences": "Configurações…",
  "menu.actualSize": "Tamanho real",
  "menu.zoomIn": "Ampliar",
  "menu.zoomOut": "Reduzir",
  "menu.copyLink": "Copiar link",
  "menu.trayOpen": "Abrir o Builders Bot",
  "menu.trayQuit": "Sair do Builders Bot",
  "menu.trayTooltip": "Builders Bot",
} as const satisfies PartialTranslation<typeof source>;
