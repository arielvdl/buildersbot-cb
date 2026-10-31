import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/menu";

export const messages = {
  "menu.stopAllAgents": "すべてのエージェントを停止",
  "menu.checkForUpdates": "アップデートを確認…",
  "menu.preferences": "設定…",
  "menu.actualSize": "実際のサイズ",
  "menu.zoomIn": "拡大",
  "menu.zoomOut": "縮小",
  "menu.copyLink": "リンクをコピー",
  "menu.trayOpen": "Builders Bot を開く",
  "menu.trayQuit": "Builders Bot を終了",
  "menu.trayTooltip": "Builders Bot",
  "menu.undo": "取り消す",
  "menu.redo": "やり直す",
  "menu.cut": "カット",
  "menu.copy": "コピー",
  "menu.paste": "ペースト",
  "menu.pasteAndMatchStyle": "ペーストしてスタイルを合わせる",
  "menu.delete": "削除",
  "menu.selectAll": "すべてを選択",
} as const satisfies PartialTranslation<typeof source>;
