import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/auth";

export const messages = {
  "error.auth.serviceUnavailable":
    "O Builders Bot não conseguiu acessar o serviço de contas. Verifique se a API está em execução e tente novamente.",
  "error.auth.networkBlocked":
    "Um firewall ou proxy desta rede impediu o Builders Bot de acessar {host}. Peça ao administrador da rede para permitir {host} e tente novamente.",
  "error.auth.signInFirst": "Entre no Builders Bot primeiro.",
  "error.auth.signInRequired": "É necessário entrar.",
  "error.auth.accountChangedDuringRegister": "A conta conectada mudou durante o registro deste servidor.",
  "error.auth.hostCredentialUnavailable":
    "A credencial do computador anfitrião remoto está indisponível. Registre o computador anfitrião novamente.",
  "error.auth.codeNotVerified": "Não foi possível verificar o código de login.",
  "error.auth.serviceError": "O serviço de contas retornou um erro.",
  "error.auth.serviceUnreachable":
    "O Builders Bot não conseguiu acessar o serviço de contas. Verifique sua conexão e tente novamente.",
  "error.auth.serviceTimeout": "O serviço de contas não respondeu a tempo. Tente novamente.",
  "error.auth.serviceStatus": "O serviço de contas retornou um erro ({status}). Tente novamente mais tarde.",
  "error.auth.invalidHostedServer": "O serviço de contas retornou um servidor hospedado inválido.",
  "error.auth.codeNotSent": "O Builders Bot não conseguiu enviar o código de login.",
  "error.auth.deliveryTimeout":
    "O Builders Bot não conseguiu confirmar a entrega a tempo. O código ainda pode chegar; verifique a entrega antes de enviar novamente.",
  "error.auth.deliveryInterrupted":
    "A conexão terminou antes de o Builders Bot confirmar a entrega. Verifique a entrega para evitar o envio de outro código.",
  "error.auth.deliveryUnknown":
    "O Builders Bot não conseguiu confirmar se o código de login foi enviado. Verifique a entrega antes de enviar novamente.",
  "error.auth.signInServiceUnavailable": "O login da Cultura Builder não respondeu. Tente de novo.",
  "error.auth.deviceSignInDisabled": "O login da Cultura Builder não está disponível.",
  "error.auth.emailSignInRetired": "Entre com Cultura Builder.",
  "error.auth.deviceCodeExpired": "O código de login expirou. Peça um novo.",
  "error.auth.deviceCodeUsed": "Este código de login já foi usado. Peça um novo.",
  "error.auth.deviceSignInDenied": "O login não foi aprovado no Hub.",
  "error.auth.deviceSlowDown": "O login da Cultura Builder pediu para aguardar.",
  "error.auth.mobileConnectRetired":
    "Os códigos e links do Mobile Connect não estão mais disponíveis. Abra o app web e entre com Cultura Builder.",
  "error.auth.desktopInstallerUnpublished":
    "O instalador do Builders Bot para computador ainda não foi publicado neste site.",
} as const satisfies PartialTranslation<typeof source>;
