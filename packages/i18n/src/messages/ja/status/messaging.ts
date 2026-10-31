import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/messaging";

export const messages = {
  "status.messaging.working": "対応しています…",
  "status.messaging.queued": "待機中: Builders Bot は別のリクエストを処理しています。回答はここに届きます。",
  "status.messaging.busy": "待機中のリクエストが多すぎます。しばらくしてからもう一度お試しください。",
  "status.messaging.failed":
    "Builders Bot はこのリクエストを完了できませんでした。詳細は Builders Bot のホストにあります。",
  "status.messaging.noAnswer": "Builders Bot はテキストの回答を返さずに終了しました。",
  "status.messaging.noAgent":
    "ここで回答できるエージェントはまだいません。Builders Bot で Slack Orchestrator を追加してください。",
  "status.messaging.delegated": "チームメイトが対応しています。回答はここに届きます。",
  "status.messaging.stopped": "停止しました。",
  "status.messaging.stop": "停止",
  "status.messaging.approvalTitle": "Builders Bot が続行の承認を求めています。",
  "status.messaging.approvalCommand": "コマンドを実行",
  "status.messaging.approvalFileChange": "ファイルを変更",
  "status.messaging.approvalPermissions": "追加の権限を取得",
  "status.messaging.approve": "承認",
  "status.messaging.deny": "拒否",
  "status.messaging.approvedBy": "{user} が承認しました。",
  "status.messaging.deniedBy": "{user} が拒否しました。",
  "status.messaging.answeredOnHost": "Builders Bot のホストで回答されました。",
  "status.messaging.requestInactive": "このリクエストはもう有効ではありません。",
  "status.messaging.onlyRequester": "これを行えるのは {user} だけです。Builders Bot のホストでも回答できます。",
  "status.messaging.hostOnly": "このリクエストに回答できるのは Builders Bot のホストだけです。",
  "status.messaging.filesSkipped": "一部のファイルは送信されませんでした: {names}。",
  "status.messaging.orchestratorName": "Slack Orchestrator",
  "status.messaging.orchestratorTitle": "Slack で回答し、チームに依頼します",
  "status.messaging.discordNoAgent":
    "ここで回答できるエージェントはまだいません。Builders Bot で Discord Orchestrator を追加してください。",
  "status.messaging.discordOrchestratorName": "Discord Orchestrator",
  "status.messaging.discordOrchestratorTitle": "Discord で回答し、チームに依頼します",
  "status.messaging.integrationsSection": "連携",
  "status.messaging.signInReceived":
    "Builders Bot は Slack のインストールを受け取りました。このタブは閉じてかまいません。",
  "status.messaging.signInUnknown":
    "この Slack のインストールは Builders Bot が開始したものではありません。Builders Bot でもう一度開始してください。",
  "status.messaging.telegramNoAgent":
    "ここで回答できるエージェントはまだいません。Builders Bot で Telegram Orchestrator を追加してください。",
  "status.messaging.telegramLinked":
    "Builders Bot はこのチャットに接続されています。エージェントに依頼するには、{bot} をメンションするか、Builders Bot のメッセージに返信してください。",
  "status.messaging.telegramOrchestratorName": "Telegram Orchestrator",
  "status.messaging.telegramOrchestratorTitle": "Telegram で回答し、チームに依頼します",
} as const satisfies PartialTranslation<typeof source>;
