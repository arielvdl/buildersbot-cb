import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/auth";

export const messages = {
  "error.auth.serviceUnavailable":
    "Builders Bot nie może połączyć się z usługą kont. Sprawdź, czy API działa, i spróbuj ponownie.",
  "error.auth.networkBlocked":
    "Zapora lub serwer proxy w tej sieci blokuje połączenie Builders Bot z {host}. Poproś administratora sieci o zezwolenie na {host} i spróbuj ponownie.",
  "error.auth.signInFirst": "Najpierw zaloguj się do Builders Bot.",
  "error.auth.signInRequired": "Wymagane jest zalogowanie.",
  "error.auth.accountChangedDuringRegister": "Zalogowane konto zmieniło się podczas rejestrowania tego serwera.",
  "error.auth.hostCredentialUnavailable": "Poświadczenie zdalnego hosta jest niedostępne. Zarejestruj hosta ponownie.",
  "error.auth.codeNotVerified": "Nie udało się zweryfikować kodu logowania.",
  "error.auth.serviceError": "Usługa kont zwróciła błąd.",
  "error.auth.serviceUnreachable":
    "Builders Bot nie może połączyć się z usługą kont. Sprawdź połączenie i spróbuj ponownie.",
  "error.auth.serviceTimeout": "Usługa kont nie odpowiedziała na czas. Spróbuj ponownie.",
  "error.auth.serviceStatus": "Usługa kont zwróciła błąd ({status}). Spróbuj ponownie później.",
  "error.auth.invalidHostedServer": "Usługa kont zwróciła nieprawidłowy serwer hostowany.",
  "error.auth.codeNotSent": "Builders Bot nie mógł wysłać kodu logowania.",
  "error.auth.deliveryTimeout":
    "Builders Bot nie zdołał na czas potwierdzić dostarczenia. Kod może jeszcze dotrzeć; sprawdź skrzynkę, zanim wyślesz go ponownie.",
  "error.auth.deliveryInterrupted":
    "Połączenie zakończyło się, zanim Builders Bot potwierdził dostarczenie. Sprawdź skrzynkę, aby nie wysyłać kolejnego kodu.",
  "error.auth.deliveryUnknown":
    "Builders Bot nie mógł potwierdzić, czy kod logowania został wysłany. Sprawdź skrzynkę, zanim wyślesz go ponownie.",
} as const satisfies PartialTranslation<typeof source>;
