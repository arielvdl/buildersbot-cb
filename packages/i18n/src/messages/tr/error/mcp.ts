import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/mcp";

export const messages = {
  // MCP oturum açma hataları ve tarayıcıdaki oturum açma sayfası.
  "error.mcp.redirectByName": "Bu adrese adıyla ulaşılamıyor.",
  "error.mcp.redirectGetOnly": "Bu adres yalnızca GET isteklerine yanıt verir.",
  "error.mcp.redirectNotSignIn": "Bu adres bir oturum açma işleminin parçası değil.",
  "error.mcp.redirectRefused": "Oturum açma reddedildi. Builders Bot'a geri dönün ve tekrar deneyin.",
  "error.mcp.redirectNoSignIn": "Bunun için bekleyen bir oturum açma işlemi yok. Sona ermiş olabilir.",
  "error.mcp.redirectSignedIn": "Builders Bot oturumu açıldı. Bu pencereyi kapatabilirsiniz.",
  "error.mcp.signInFileUnreadable": "MCP oturum açma dosyası okunamıyor.",
  "error.mcp.signInFileTooLarge": "MCP oturum açma dosyası çok büyük.",
  "error.mcp.unsupported": "MCP sunucuları bu sunucu tarafından desteklenmiyor.",
  "error.mcp.signInOnHost": "Bir MCP sunucusunda oturum açma yalnızca ana makinedeki Builders Bot'ta çalışır.",
  "error.mcp.signInAppUnsupported":
    "Bu sunucu oturum açma uygulamalarını desteklemiyor. Ana makinedeki Builders Bot'u güncelleyin.",
  "error.mcp.redirectRelayed": "Builders Bot oturum açmayı sunucuya gönderdi. Bu pencereyi kapatabilirsiniz.",
  "error.mcp.relayEnded": "Bu oturum açma sona erdi. Yeniden başlatın.",
  "error.mcp.relayNoState":
    "Sunucunun oturum açma sayfası dönüş adresini korumuyor, bu yüzden Builders Bot onu bu bilgisayarda açmaz.",
  "error.mcp.relayAddressInvalid": "Bu, bu oturum açmanın sonundaki adres değil. Tarayıcıdan tam adresi kopyalayın.",
} as const satisfies PartialTranslation<typeof source>;
