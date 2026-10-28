import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sitePage";

export const messages = {
  "sitePage.error.title": "Impossible de charger cette page",
  "sitePage.error.body":
    "Vérifiez votre connexion et rechargez la page. Si elle ne se charge toujours pas, revenez à la page d’accueil.",
  "sitePage.error.reload": "Recharger la page",
  "sitePage.error.home": "Retour à l’accueil",
  "sitePage.join.title": "Rejoindre un serveur Builders Bot",
  "sitePage.join.description": "Ouvrez une invitation privée à un serveur dans Builders Bot.",
  "sitePage.join.eyebrow": "Invitation privée",
  "sitePage.join.intro":
    "Ouvrez cette invitation dans Builders Bot. L’app vérifie le serveur et vous demande de confirmer avant de se connecter.",
  "sitePage.join.invalid":
    "Ce lien d’invitation n’est pas valide ou est incomplet. Demandez une nouvelle invitation au propriétaire du serveur.",
  "sitePage.join.open": "Ouvrir Builders Bot",
  "sitePage.join.browser": "Ouvrir dans le navigateur",
  "sitePage.join.download": "Télécharger Builders Bot",
  "sitePage.join.notOpened":
    "Si Builders Bot ne s’est pas ouvert, installez-le avec {download}, ou lancez Builders Bot une fois pour qu’il puisse ouvrir les liens d’invitation. Vous pouvez aussi utiliser {browser}.",
  "sitePage.join.mobile":
    "Si Builders Bot est installé, touchez {open}. Vous pouvez aussi coller ce lien dans Ajouter un serveur dans l’app.",
  "sitePage.join.singleUse":
    "Un lien à usage unique fonctionne une fois puis expire. Un lien permanent fonctionne jusqu’à ce que le propriétaire le révoque. Builders Bot affiche l’expiration avant que vous ne rejoigniez.",
  "sitePage.join.email": "Si l’invitation est arrivée par e-mail, connectez-vous à Builders Bot avec cette adresse e-mail.",
  "sitePage.join.share":
    "Ce lien donne accès à un serveur. Partagez-le uniquement avec les personnes que vous voulez inviter.",
  "sitePage.connect.title": "Revenir à Builders Bot",
  "sitePage.connect.failedTitle": "La connexion n’a pas abouti",
  "sitePage.connect.openApp": "Ouvrir Builders Bot",
  "sitePage.connect.tryAgainApp": "Réessayer dans Builders Bot",
  "sitePage.connect.tryAgainBrowser": "Réessayer dans le navigateur",
  "sitePage.connect.doneInWebClient":
    "Votre onglet Builders Bot termine la connexion à {name}. Vous pouvez fermer cet onglet.",
  "sitePage.connect.doneInApp": "Builders Bot termine la connexion à {name} sur votre ordinateur.",
  "sitePage.connect.failure.cancelled": "La connexion à {name} a été annulée. Rien n’a changé.",
  "sitePage.connect.failure.expired": "La connexion à {name} a expiré. Relancez la connexion.",
  "sitePage.connect.failure.exchange": "{name} n’a pas confirmé la connexion. Réessayez.",
  "sitePage.connect.failure.enterprise": "Connectez un espace de travail Slack, pas une organisation entière.",
  "sitePage.connect.failure.takenSlack":
    "Un autre serveur Builders Bot répond déjà dans cet espace de travail Slack. Déconnectez-le sur ce serveur, puis réessayez.",
  "sitePage.connect.failure.takenDiscord":
    "Un autre serveur Builders Bot répond déjà sur ce serveur Discord. Déconnectez-le sur ce serveur, puis réessayez.",
  "sitePage.connect.failure.unavailable":
    "Builders Bot ne peut pas se connecter à {name} pour le moment. Réessayez plus tard.",
  "sitePage.connect.failure.tabClosed":
    "L’onglet Builders Bot qui a lancé la connexion à {name} n’a pas répondu. Ouvrez Builders Bot dans votre navigateur et connectez de nouveau {name}.",
  "sitePage.connect.failure.failed": "{name} n’a pas terminé la connexion. Réessayez.",
  "sitePage.connect.restartHint":
    "Dans Builders Bot, ouvrez {marketplace}, puis {apps}, puis {name}, et sélectionnez {connect}.",
  "sitePage.connect.notOpened":
    "Lancez Builders Bot, puis réessayez. Si Builders Bot n’est pas sur cet ordinateur, téléchargez-le et connectez {name} depuis l’app.",
  "sitePage.openApp.title": "Rien ne s’est ouvert ?",
  "sitePage.openApp.dismiss": "Plus tard",
  "sitePage.billing.pageTitle": "Facturation Builders Bot",
  "sitePage.billing.updatedTitle": "Facturation mise à jour",
  "sitePage.billing.updatedBody": "Revenez à Builders Bot. Vous pouvez fermer cette page.",
  "sitePage.billing.cancelledTitle": "Paiement annulé",
  "sitePage.billing.cancelledBody": "Rien n’a été facturé. Revenez à Builders Bot.",
  "sitePage.report.pageTitle": "Signaler un site hébergé — Builders Bot",
  "sitePage.report.title": "Signaler un site hébergé",
  "sitePage.report.intro": "Envoyez un signalement sur un contenu nuisible ou illégal à une adresse openbot.site.",
  "sitePage.report.hostnameLabel": "Adresse du site",
  "sitePage.report.hostnameMissing": "Saisissez l’adresse du site",
  "sitePage.report.reasonLabel": "Motif",
  "sitePage.report.reason.phishing": "Hameçonnage",
  "sitePage.report.reason.malware": "Logiciel malveillant",
  "sitePage.report.reason.abuse": "Abus",
  "sitePage.report.reason.copyright": "Droit d’auteur",
  "sitePage.report.reason.other": "Autre",
  "sitePage.report.detailsLabel": "Détails",
  "sitePage.report.optional": "Facultatif",
  "sitePage.report.detailsPlaceholder": "Quel est le problème avec ce site ?",
  "sitePage.report.send": "Envoyer",
  "sitePage.report.sending": "Envoi…",
  "sitePage.report.tooMany": "Trop de signalements. Réessayez plus tard.",
  "sitePage.report.sendFailed": "Impossible d’envoyer le signalement. Réessayez.",
  "sitePage.report.writeTo": "Vous pouvez aussi écrire à {email}.",
  "sitePage.report.sentTitle": "Signalement envoyé",
  "sitePage.report.sentBody": "Merci. Nous avons reçu votre signalement.",
  "sitePage.report.home": "Aller à la page d’accueil",
} as const satisfies PartialTranslation<typeof source>;
