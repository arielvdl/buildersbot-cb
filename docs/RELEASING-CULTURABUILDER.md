# Release Cultura Builder — guia completo de build e produção

Guia operacional para **cada novo build do Builders Bot** no fork da Cultura Builder
(`arielvdl/buildersbot-cb`): validar certificados, empacotar macOS e Windows, publicar a
release no GitHub e deixar os downloads ativos no site de produção
(`buildersbot.culturabuilder.com`). O guia upstream geral fica em
[docs/RELEASING.md](RELEASING.md); este documento descreve o fluxo nosso, com as
credenciais da Cultura Builder.

## 0. Credenciais e pré-requisitos (uma vez por máquina)

| Item | Valor | Onde está |
| --- | --- | --- |
| Apple Developer Team | `HCT8F2D969` (CULTURA BUILDER EDUCACAO E TECNOLOGIA LTDA) | — |
| Certificado Developer ID Application | válido até **2027-12-04** (ID 67B4W35HKC) | Keychain do macOS (`security find-identity -v -p codesigning`) |
| Chave de API App Store Connect | Key ID `L8KABF93C5` | `~/.appstoreconnect/private_keys/AuthKey_L8KABF93C5.p8` |
| Issuer ID da chave | `772f6c41-8140-4c41-b0e4-a2bff919be63` | — |
| GitHub | autenticado como `arielvdl` | `gh auth status` |

Checagem rápida antes de qualquer build:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# 2FA da conta Apple cai no WhatsApp do Ygor (+55 21 97390-6969)
```

Se o certificado expirar, emita outro em <https://developer.apple.com/account/resources/certificates/list>
(tipo **Developer ID Application**) usando um CSR novo; o pipeline assina pelo nome, então
não é preciso mudar mais nada.

## 1. macOS — assinar, notarizar e empacotar

O script já faz build → assinatura → notarização → grampeia → valida:

```bash
cd ~/Documents/PROJETOS/buildersbot-cb
export PATH="$PWD/node_modules/.bin:$PATH"
ASC_KEY_ID=L8KABF93C5 ASC_ISSUER=772f6c41-8140-4c41-b0e4-a2bff919be63 \
  zsh scripts/dist-mac-signed.sh
```

Ao final, confira `dist/Builders Bot-<versão>-arm64.dmg`:
`spctl -a -vvv -t exec "dist/mac-arm64/Builders Bot.app"` deve responder
`accepted — source=Notarized Developer ID`.

## 2. Windows — empacotar

```bash
cd ~/Documents/PROJETOS/buildersbot-cb
bun run package:win          # gera dist/<versão>/Builders Bot Setup <versão>.exe (x64)
```

Assinatura no Windows usa Azure Artifact Signing (ver
[Windows signing](RELEASING.md#windows-signing) no guia upstream). Sem ela o instalador
funciona, mas o WindowsSmartScreen acusa aviso — publish assim mesmo quando não houver
certificado de código Windows contratado.

## 3. Manifests de auto-update (obrigatórios para o site)

O site de produção redireciona `/download/{macos,windows,linux}/latest` para o instalador
listado em `latest-mac.yml` / `latest.yml` / `latest-linux.yml`. O electron-builder gera
esses arquivos no `dist/` quando o target roda **sem** `--prepackaged` (build completo) —
suba-os junto com o instalador. Regra prática:

- macOS: incluir **`latest-mac.yml`** no release (aponta pro `.dmg` com SHA-512);
- Windows: incluir **`latest.yml`** (aponta pro `.exe`);
- Linux: incluir `latest-linux.yml` / `latest-linux-arm64.yml`.

Sem o manifest correspondente, o botão do site cai na página de releases em vez de baixar
direto.

## 4. Publicar a release no GitHub

```bash
gh release create v<versão> \
  "dist/Builders Bot-<versão>-arm64.dmg" \
  "dist/Builders Bot-<versão>-arm64.zip" \
  "dist/latest-mac.yml" \
  "dist/Builders Bot Setup <versão>.exe" "dist/latest.yml" \
  "dist/SHA256SUMS-<versão>.txt" \
  --title "Builders Bot <versão>" \
  --notes "Assinado e notarizado. Veja SHA256SUMS."
```

Depois, grampeie/atualize: `xcrun stapler staple dist/*.dmg` (se regenerou) e
`gh release upload v<versão> ... --clobber` para substituir assets.

## 5. Produção — buildersbot.culturabuilder.com

1. `apps/auth-api/src/server/latest-download.ts` já aponta
   `RELEASES_BASE_URL` para `https://github.com/arielvdl/buildersbot-cb/releases`.
2. Publique o Worker que serve o site (faz os redirects `/download/*/latest`):

   ```bash
   bun scripts/deploy-auth-api.ts
   ```

3. Teste: `curl -I https://buildersbot.culturabuilder.com/download/macos/latest`
   deve responder **302** para o `.dmg` da última release.

Qualquer mudança de código no `apps/auth-api` (inclusive `RELEASES_BASE_URL`) só vale
depois do passo 2.

## 6. Checklist-resumo por build

- [ ] `bun run test` e checks locais verdes
- [ ] `zsh scripts/dist-mac-signed.sh` (macOS assinado + notarizado)
- [ ] `bun run package:win` (Windows x64)
- [ ] Release no GitHub com `.dmg`/`.exe` + `latest-mac.yml`/`latest.yml` + SHA256SUMS
- [ ] `bun scripts/deploy-auth-api.ts` (atualiza os redirects de download)
- [ ] Anúncio no canal para quem usa a versão anterior
