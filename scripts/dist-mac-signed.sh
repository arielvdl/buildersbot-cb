#!/bin/zsh
# dist-mac-signed.sh — build de distribuição do Builders Bot ASSINADO e NOTARIZADO.
#
# O `dist:mac` normal passa `--config.mac.identity=null --config.mac.notarize=false`,
# porque no CI não há certificado. Este script faz o mesmo build, mas com a
# identidade Developer ID do keychain e a notarização da Apple ligadas.
#
# Pré-requisitos:
#   1. certificado "Developer ID Application" no keychain (scripts/creds/ do repo
#      builders-cve emite, ver docs de assinatura)
#   2. chave de API ASC: ASC_KEY_ID + ASC_ISSUER (padrão: chave principal
#      da Cultura Builder, L8KABF93C5)
#
# Uso:
#   ./scripts/dist-mac-signed.sh            # build + assinatura + notarização
#   ./scripts/dist-mac-signed.sh --check    # só valida pré-requisitos
set -euo pipefail

cd "$(dirname "$0")/.."

ASC_KEY_ID="${ASC_KEY_ID:-L8KABF93C5}"
ASC_ISSUER="${ASC_ISSUER:-772f6c41-8140-4c41-b0e4-a2bff919be63}"
ASC_KEY="${ASC_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
IDENTITY="${IDENTITY:-Developer ID Application}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

fail() { print -u2 "ERRO: $1"; exit 1; }

print -r -- ">> pré-requisitos"
[[ -f "$ASC_KEY" ]] || fail "chave ASC não encontrada em $ASC_KEY"
security find-identity -v -p codesigning | grep -q "$IDENTITY" \
  || fail "nenhum certificado \"$IDENTITY\" no keychain (a Apple ainda não emitiu)"
print -r -- "   ok chave e certificado presentes"

# A mesma checagem que o build de assinatura do Builders Protect faz: a Apple
# recusa a API com 403 quando o PLA está pendente, e é melhor parar antes de
# gastar 10 minutos de build.
TOKEN=$(node --input-type=module -e '
import fs from "fs"; import crypto from "crypto";
const [iss,kid,p8]=process.argv.slice(1);
const key=crypto.createPrivateKey(fs.readFileSync(p8,"utf8"));
const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const now=Math.floor(Date.now()/1000);
const input=`${b64({alg:"ES256",kid,typ:"JWT"})}.${b64({iss,iat:now,exp:now+900,aud:"appstoreconnect-v1"})}`;
console.log(`${input}.${crypto.sign("sha256",Buffer.from(input),{key,dsaEncoding:"ieee-p1363"}).toString("base64url")}`);
' "$ASC_ISSUER" "$ASC_KEY_ID" "$ASC_KEY")
CODE=$(curl -sS -o /tmp/asc-bb.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.appstoreconnect.apple.com/v1/certificates?limit=1")
if [[ "$CODE" == "403" ]]; then
  fail "Apple exige aceitar o PLA atualizado (403 REQUIRED_AGREEMENTS_MISSING): https://developer.apple.com/account > Contratos"
fi
[[ "$CODE" == "200" ]] || fail "API da Apple respondeu $CODE (veja /tmp/asc-bb.json)"
print -r -- "   ok API autenticada"

(( CHECK_ONLY )) && { print -r -- "Pré-requisitos ok."; exit 0; }

export APPLE_API_KEY="$ASC_KEY"
export APPLE_API_KEY_ID="$ASC_KEY_ID"
export APPLE_API_ISSUER="$ASC_ISSUER"

print -r -- ">> build (o mesmo do dist:mac, com assinatura ligada)"
# Espelha os passos de `dist:mac` do package.json; se ele ganhar um passo novo,
# ele precisa entrar aqui também (só as flags do electron-builder mudam).
bun run voice:prepare-runtime
bun run prepare:remote-desktop-runtime
bun run verify:remote-desktop-runtime
bun run prepare:cua-driver
bun run prepare:chrome-bridge
bun run build
bun scripts/build-output-check.ts
bun scripts/telemetry-destination-guard.ts --build-output
electron-builder --mac \
  --config.mac.identity="$IDENTITY" \
  --config.mac.notarize=true
bun scripts/telemetry-destination-guard.ts --package

APP="dist/mac-arm64/Builders Bot.app"
[[ -d "$APP" ]] || APP="dist/mac/Builders Bot.app"
[[ -d "$APP" ]] || fail "app não encontrado em dist/"

print -r -- ">> verificação do artefato"
codesign --verify --strict --deep "$APP" || fail "assinatura inválida"
[[ $(codesign -dvvv "$APP" 2>&1) == *"(runtime)"* ]] || fail "hardened runtime ausente"
# O Computer Use depende de Apple Events; se a assinatura derrubar o entitlement,
# o driver para de funcionar só no app distribuído.
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "automation.apple-events" \
  || fail "entitlement de Apple Events perdido na assinatura"
# O driver da Cua AI é de outro time e precisa manter a assinatura original.
codesign -dvv "$APP/Contents/Resources/cua-driver/darwin/arm64/cua-driver" 2>&1 | grep -q "Developer ID Application" \
  || fail "cua-driver perdeu a assinatura de terceiro (signIgnore)"
spctl -a -vvv -t exec "$APP" || fail "Gatekeeper recusou (não notarizado)"
xcrun stapler validate "$APP" || fail "ticket de notarização não grampeado"
print -r -- "PRONTO: app assinado, notarizado e aceito pelo Gatekeeper."
