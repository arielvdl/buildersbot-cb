import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sitePage";

export const messages = {
  "sitePage.error.title": "このページを読み込めませんでした",
  "sitePage.error.body":
    "接続を確認して、ページを再読み込みしてください。それでも読み込めない場合は、ホームページに戻ってください。",
  "sitePage.error.reload": "再読み込み",
  "sitePage.error.home": "ホームに戻る",
  "sitePage.join.title": "Builders Bot サーバーに参加",
  "sitePage.join.description": "非公開のサーバー招待を Builders Bot で開きます。",
  "sitePage.join.eyebrow": "非公開の招待",
  "sitePage.join.intro":
    "この招待を Builders Bot で開いてください。アプリがサーバーを確認し、接続する前に確認を求めます。",
  "sitePage.join.invalid": "この招待リンクは無効か、不完全です。サーバーのオーナーに新しい招待を依頼してください。",
  "sitePage.join.open": "Builders Bot を開く",
  "sitePage.join.browser": "ブラウザーで開く",
  "sitePage.join.download": "Builders Bot をダウンロード",
  "sitePage.join.notOpened":
    "Builders Bot が開かなかった場合は、{download} からインストールするか、Builders Bot を一度起動して招待リンクを開けるようにしてください。{browser} も使えます。",
  "sitePage.join.singleUse":
    "1 回限りのリンクは 1 回だけ使え、その後は期限切れになります。無期限のリンクは、オーナーが取り消すまで使えます。Builders Bot は参加前に有効期限を表示します。",
  "sitePage.join.email": "招待がメールで届いた場合は、そのメールアドレスで Builders Bot にサインインしてください。",
  "sitePage.join.share": "このリンクでサーバーにアクセスできます。招待したい人とだけ共有してください。",
  "sitePage.connect.title": "Builders Bot に戻る",
  "sitePage.connect.failedTitle": "接続が完了しませんでした",
  "sitePage.connect.openApp": "Builders Bot を開く",
  "sitePage.connect.tryAgainApp": "Builders Bot で再試行",
  "sitePage.connect.tryAgainBrowser": "ブラウザーで再試行",
  "sitePage.connect.doneInWebClient":
    "Builders Bot のタブが {name} との接続を完了します。このタブは閉じてかまいません。",
  "sitePage.connect.doneInApp": "Builders Bot がこのコンピューターで {name} との接続を完了します。",
  "sitePage.connect.failure.cancelled": "{name} との接続はキャンセルされました。何も変更されていません。",
  "sitePage.connect.failure.expired": "{name} へのサインインの期限が切れました。接続をもう一度始めてください。",
  "sitePage.connect.failure.exchange": "{name} が接続を確認しませんでした。もう一度お試しください。",
  "sitePage.connect.failure.enterprise": "組織全体ではなく、Slack ワークスペースを 1 つ接続してください。",
  "sitePage.connect.failure.takenSlack":
    "別の Builders Bot サーバーがすでにこの Slack ワークスペースで応答しています。そのサーバーで接続を解除してから、もう一度お試しください。",
  "sitePage.connect.failure.takenDiscord":
    "別の Builders Bot サーバーがすでにこの Discord サーバーで応答しています。そのサーバーで接続を解除してから、もう一度お試しください。",
  "sitePage.connect.failure.unavailable":
    "Builders Bot は現在 {name} に接続できません。しばらくしてからもう一度お試しください。",
  "sitePage.connect.failure.tabClosed":
    "{name} との接続を始めた Builders Bot のタブが応答しませんでした。ブラウザーで Builders Bot を開き、{name} をもう一度接続してください。",
  "sitePage.connect.failure.failed": "{name} が接続を完了しませんでした。もう一度お試しください。",
  "sitePage.connect.restartHint":
    "Builders Bot で {marketplace}、{apps}、{name} の順に開き、{connect} を選択してください。",
  "sitePage.connect.notOpened":
    "Builders Bot を起動してから、もう一度お試しください。このコンピューターに Builders Bot がない場合は、ダウンロードしてアプリから {name} を接続してください。",
  "sitePage.openApp.title": "何も開きませんでしたか?",
  "sitePage.openApp.dismiss": "後で",
  "sitePage.billing.pageTitle": "Builders Bot の請求",
  "sitePage.billing.updatedTitle": "請求情報を更新しました",
  "sitePage.billing.updatedBody": "Builders Bot に戻ってください。このページは閉じてかまいません。",
  "sitePage.billing.cancelledTitle": "支払いをキャンセルしました",
  "sitePage.billing.cancelledBody": "請求は発生していません。Builders Bot に戻ってください。",
  "sitePage.report.pageTitle": "ホストされたサイトを報告 — Builders Bot",
  "sitePage.report.title": "ホストされたサイトを報告",
  "sitePage.report.intro": "openbot.site のアドレスにある有害または違法なコンテンツを報告します。",
  "sitePage.report.hostnameLabel": "サイトのアドレス",
  "sitePage.report.hostnameMissing": "サイトのアドレスを入力してください",
  "sitePage.report.reasonLabel": "理由",
  "sitePage.report.reason.phishing": "フィッシング",
  "sitePage.report.reason.malware": "マルウェア",
  "sitePage.report.reason.abuse": "迷惑行為",
  "sitePage.report.reason.copyright": "著作権",
  "sitePage.report.reason.other": "その他",
  "sitePage.report.detailsLabel": "詳細",
  "sitePage.report.optional": "任意",
  "sitePage.report.detailsPlaceholder": "このサイトの何が問題ですか?",
  "sitePage.report.send": "報告を送信",
  "sitePage.report.sending": "送信中…",
  "sitePage.report.tooMany": "報告が多すぎます。しばらくしてからもう一度お試しください。",
  "sitePage.report.sendFailed": "報告を送信できませんでした。もう一度お試しください。",
  "sitePage.report.writeTo": "{email} に連絡することもできます。",
  "sitePage.report.sentTitle": "報告を送信しました",
  "sitePage.report.sentBody": "ありがとうございます。報告を受け付けました。",
  "sitePage.report.home": "ホームページへ",
  "sitePage.pricing.title": "Builders Bot の料金",
  "sitePage.pricing.description":
    "ホスト型サーバーとチーム向けライセンス。自分のコンピューターでの個人利用なら Builders Bot は無料です。",
  "sitePage.pricing.heading": "料金",
  "sitePage.pricing.enterprise.title": "エンタープライズ",
  "sitePage.pricing.enterprise.body":
    "より大きなサーバー、{count} 人を超えるメンバー、そのほかのご要望にも対応します。エンタープライズサポート付きです。",
  "sitePage.pricing.enterprise.contact": "営業に問い合わせる",
} as const satisfies PartialTranslation<typeof source>;
