import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sitePage";

export const messages = {
  "sitePage.error.title": "Bu sayfa yüklenemedi",
  "sitePage.error.body":
    "Bağlantınızı kontrol edin ve sayfayı yeniden yükleyin. Yine de yüklenmezse ana sayfaya dönün.",
  "sitePage.error.reload": "Sayfayı yenile",
  "sitePage.error.home": "Ana sayfaya dön",
  "sitePage.join.title": "Bir Builders Bot sunucusuna katıl",
  "sitePage.join.description": "Özel bir sunucu davetini Builders Bot'ta açın.",
  "sitePage.join.eyebrow": "Özel davet",
  "sitePage.join.intro":
    "Bu daveti Builders Bot'ta açın. Uygulama sunucuyu kontrol eder ve bağlanmadan önce onayınızı ister.",
  "sitePage.join.invalid": "Bu davet bağlantısı geçerli değil veya eksik. Sunucu sahibinden yeni bir davet isteyin.",
  "sitePage.join.open": "Builders Bot'u aç",
  "sitePage.join.browser": "Tarayıcıda aç",
  "sitePage.join.download": "Builders Bot'u indir",
  "sitePage.join.notOpened":
    "Builders Bot açılmadıysa {download} ile yükleyin veya davet bağlantılarını açabilmesi için Builders Bot'u bir kez başlatın. {browser} seçeneğini de kullanabilirsiniz.",
  "sitePage.join.singleUse":
    "Tek kullanımlık bağlantı bir kez çalışır ve sonra süresi dolar. Kalıcı bağlantı, sahibi iptal edene kadar çalışır. Builders Bot, katılmadan önce son kullanma tarihini gösterir.",
  "sitePage.join.email": "Davet e-postayla geldiyse Builders Bot'ta o e-posta adresiyle oturum açın.",
  "sitePage.join.share": "Bu bağlantı bir sunucuya erişim sağlar. Yalnızca davet etmek istediğiniz kişilerle paylaşın.",
  "sitePage.connect.title": "Builders Bot'a dön",
  "sitePage.connect.failedTitle": "Bağlantı tamamlanmadı",
  "sitePage.connect.openApp": "Builders Bot'u aç",
  "sitePage.connect.tryAgainApp": "Builders Bot'ta tekrar dene",
  "sitePage.connect.tryAgainBrowser": "Tarayıcıda tekrar dene",
  "sitePage.connect.doneInWebClient":
    "Builders Bot sekmeniz {name} bağlantısını tamamlar. Bu sekmeyi kapatabilirsiniz.",
  "sitePage.connect.doneInApp": "Builders Bot, {name} bağlantısını bilgisayarınızda tamamlar.",
  "sitePage.connect.failure.cancelled": "{name} bağlantısı iptal edildi. Hiçbir şey değişmedi.",
  "sitePage.connect.failure.expired": "{name} oturum açma süresi doldu. Bağlantıyı yeniden başlatın.",
  "sitePage.connect.failure.exchange": "{name} bağlantıyı onaylamadı. Tekrar deneyin.",
  "sitePage.connect.failure.enterprise": "Tüm kuruluşu değil, tek bir Slack çalışma alanını bağlayın.",
  "sitePage.connect.failure.takenSlack":
    "Başka bir Builders Bot sunucusu bu Slack çalışma alanında zaten yanıt veriyor. O sunucuda bağlantısını kesin, sonra tekrar deneyin.",
  "sitePage.connect.failure.takenDiscord":
    "Başka bir Builders Bot sunucusu bu Discord sunucusunda zaten yanıt veriyor. O sunucuda bağlantısını kesin, sonra tekrar deneyin.",
  "sitePage.connect.failure.unavailable":
    "Builders Bot şu anda {name} ile bağlantı kuramıyor. Daha sonra tekrar deneyin.",
  "sitePage.connect.failure.tabClosed":
    "{name} bağlantısını başlatan Builders Bot sekmesi yanıt vermedi. Builders Bot'u tarayıcınızda açın ve {name} bağlantısını yeniden kurun.",
  "sitePage.connect.failure.failed": "{name} bağlantıyı tamamlamadı. Tekrar deneyin.",
  "sitePage.connect.restartHint":
    "Builders Bot'ta {marketplace}, ardından {apps}, ardından {name} bölümünü açın ve {connect} seçeneğini seçin.",
  "sitePage.connect.notOpened":
    "Builders Bot'u başlatın, sonra tekrar deneyin. Builders Bot bu bilgisayarda yoksa indirin ve {name} bağlantısını uygulamadan kurun.",
  "sitePage.openApp.title": "Hiçbir şey açılmadı mı?",
  "sitePage.openApp.dismiss": "Şimdi değil",
  "sitePage.billing.pageTitle": "Builders Bot faturalandırma",
  "sitePage.billing.updatedTitle": "Faturalandırma güncellendi",
  "sitePage.billing.updatedBody": "Builders Bot'a dönün. Bu sayfayı kapatabilirsiniz.",
  "sitePage.billing.cancelledTitle": "Ödeme iptal edildi",
  "sitePage.billing.cancelledBody": "Hiçbir ücret alınmadı. Builders Bot'a dönün.",
  "sitePage.report.pageTitle": "Barındırılan siteyi bildir — Builders Bot",
  "sitePage.report.title": "Barındırılan siteyi bildir",
  "sitePage.report.intro": "Bir openbot.site adresindeki zararlı veya yasa dışı içerik hakkında bildirim gönderin.",
  "sitePage.report.hostnameLabel": "Site adresi",
  "sitePage.report.hostnameMissing": "Site adresini girin",
  "sitePage.report.reasonLabel": "Neden",
  "sitePage.report.reason.phishing": "Kimlik avı",
  "sitePage.report.reason.malware": "Kötü amaçlı yazılım",
  "sitePage.report.reason.abuse": "Kötüye kullanım",
  "sitePage.report.reason.copyright": "Telif hakkı",
  "sitePage.report.reason.other": "Diğer",
  "sitePage.report.detailsLabel": "Ayrıntılar",
  "sitePage.report.optional": "İsteğe bağlı",
  "sitePage.report.detailsPlaceholder": "Bu sitede sorun ne?",
  "sitePage.report.send": "Bildirimi gönder",
  "sitePage.report.sending": "Gönderiliyor…",
  "sitePage.report.tooMany": "Çok fazla bildirim. Daha sonra tekrar deneyin.",
  "sitePage.report.sendFailed": "Bildirim gönderilemedi. Tekrar deneyin.",
  "sitePage.report.writeTo": "{email} adresine de yazabilirsiniz.",
  "sitePage.report.sentTitle": "Bildirim gönderildi",
  "sitePage.report.sentBody": "Teşekkürler. Bildiriminizi aldık.",
  "sitePage.report.home": "Ana sayfaya git",
  "sitePage.pricing.title": "Builders Bot fiyatlandırması",
  "sitePage.pricing.description":
    "Barındırılan sunucular ve ekipler için lisans. Builders Bot, kendi bilgisayarınızda kişisel kullanım için ücretsizdir.",
  "sitePage.pricing.heading": "Fiyatlandırma",
  "sitePage.pricing.enterprise.title": "Kurumsal",
  "sitePage.pricing.enterprise.body":
    "Daha büyük sunucular, {count} üyeden fazlası veya ihtiyacınız olan her şey. Kurumsal destekle.",
  "sitePage.pricing.enterprise.contact": "Satış ekibine ulaşın",
} as const satisfies PartialTranslation<typeof source>;
