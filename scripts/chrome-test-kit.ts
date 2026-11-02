/**
 * Builds what the owner needs to try the Builders Bot extension in their own Google Chrome, and writes
 * the steps in Portuguese (`COMO-TESTAR.md`, next to `<out>`).
 *
 *   bun run chrome-extension:kit [-- --out <folder>]
 *
 * It runs only the existing build scripts:
 *
 * - for the app in development (`bun run dev`, channel `dev`): the extension into `<out>/extension`, the
 *   folder to load with "Load unpacked" in chrome://extensions; the Native Messaging host and the
 *   `chrome-peer` addon into this worktree's `.buildersbot-build`, where the development app reads them,
 *   and a copy of each into `<out>/host` and `<out>/peer`;
 * - for an installed app that `bun run package:signed` signed with the owner's certificate (channel
 *   `local`): the extension into `<out>/extension-local`. That app carries its own host and addon.
 *
 * Each manifest `key` gives its extension a fixed ID.
 * The default `<out>` is `.buildersbot-build/chrome-extension/dist` of the main checkout, so the path
 * that Chrome remembers for the extension stays the same for every worktree and every run. The script
 * can run again at any time: each run replaces the earlier build, and Chrome then needs a click on the
 * extension's reload button. It checks that each extension ID from its manifest key is the one that the
 * host of its channel accepts. It never writes into a Chrome folder: only the app writes the Native
 * Messaging manifest, after the person turns on "Let agents use my Chrome".
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ChromeBridgeChannel,
  EXTENSION_IDS,
  extensionOrigin,
} from "@openbot/contracts/chrome-bridge/extension-ids";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { buildChromeExtension } from "./build-chrome-extension";
import { buildChromeHost } from "./build-chrome-host";
import { buildChromePeer } from "./build-chrome-peer";

const ROOT = resolve(import.meta.dirname, "..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The main checkout of this repository, also from a linked worktree. */
function mainCheckout(): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  return dirname(common);
}

/** Chrome's ID for an unpacked extension with this manifest `key`: SHA-256 of the key, 32 letters a to p. */
function idOfKey(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/** Builds the extension of one channel and checks that its ID is the one of that channel. */
async function extensionFor(channel: Exclude<ChromeBridgeChannel, "store">, folder: string): Promise<string> {
  const built = await buildChromeExtension(channel, folder);
  const manifest = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8"));
  const key = isDynamicRecord(manifest) && isString(manifest.key) ? manifest.key : null;
  if (key === null)
    throw new Error(`The ${channel} extension has no manifest key, so Chrome would give it a random ID.`);
  if (idOfKey(key) !== EXTENSION_IDS[channel])
    throw new Error(`The ${channel} extension ID ${idOfKey(key)} is not ${EXTENSION_IDS[channel]}.`);
  return built;
}

function steps(paths: { extension: string; extensionLocal: string; worktree: string }): string {
  return `# Testar a extensão do Builders Bot no seu Chrome

Feito por \`bun run chrome-extension:kit\`. Pode rodar de novo quando quiser: depois, clique em
recarregar (↻) no cartão da extensão em chrome://extensions.

## Com o app em desenvolvimento

1. Abra o app em desenvolvimento, com a permissão de gravar no seu Chrome:

       cd ${paths.worktree}
       bun install --frozen-lockfile
       OPENBOT_CHROME_BRIDGE_REAL_CHROME=1 bun run dev

   (Para usar o perfil de desenvolvimento que você já usa, acrescente \`--shared\` no fim.)

2. No app: Configurações > Geral > ligue "Deixar os agentes usarem o meu Chrome (beta)".
   Ligar é o "Conectar Chrome": o app grava o arquivo que deixa o Chrome abrir o Builders Bot e
   espera o pareamento por 2 minutos.

3. Em até 2 minutos, no Chrome: chrome://extensions > Modo do desenvolvedor ligado >
   "Carregar sem compactação" > escolha esta pasta:

       ${paths.extension}

   A página de boas-vindas da extensão abre sozinha.

4. Pareamento, duas escolhas (nada para digitar):
   a. No app aparece "Conectar o seu Chrome ao Builders Bot?". Toque no botão com as palavras que a
      página do Chrome mostra em "No Builders Bot, escolha estas palavras:".
   b. Na página do Chrome, em "Depois, toque nas palavras que o Builders Bot mostra:", toque nas
      palavras que o cartão do app mostra depois de "No Chrome, toque em:".
   Pronto quando o Chrome mostra "Conectado. Pode fechar esta aba."

5. Fixe o ícone do Builders Bot na barra do Chrome (menu de extensões > alfinete) e peça a um agente
   para abrir um site. As abas dele aparecem num grupo com o nome do projeto.

Se passarem os 2 minutos: desligue e ligue de novo a opção do passo 2 e, no menu da extensão, toque em
"Conectar".

Para parar: desligue a opção do passo 2 (o app apaga o arquivo do Chrome) ou use Alt+Shift+K.

## Com o app instalado

Só para um app feito por \`bun run package:signed\` (ou \`bun run package:install\`) a partir desta
versão: ele leva o host e a checagem dentro do pacote e não precisa do modo de desenvolvimento.

1. Remova a extensão "Builders Bot (Dev)" do Chrome, se estiver lá, e feche o app em desenvolvimento.
2. Abra o Builders Bot instalado (em Aplicativos). Configurações > Geral > ligue "Deixar os agentes
   usarem o meu Chrome (beta)".
3. Em até 2 minutos: chrome://extensions > "Carregar sem compactação" > esta pasta:

       ${paths.extensionLocal}

4. Faça as duas escolhas de palavras como acima.

O app instalado só aceita o host quando o Google Chrome estável (assinado pelo Google, time
EQHXZ8M8AV) o abriu. Chrome Beta, Canary, Chromium, Brave e Edge ficam de fora.
`;
}

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("The Chrome bridge runs on macOS only.");
  const out = resolve(option("--out") ?? join(mainCheckout(), ".buildersbot-build/chrome-extension/dist"));
  const extensionFolder = await extensionFor("dev", join(out, "extension"));
  const extensionLocal = await extensionFor("local", join(out, "extension-local"));
  const host = buildChromeHost({ channel: "dev" });
  const peer = buildChromePeer();
  if (host.origin !== extensionOrigin(EXTENSION_IDS.dev ?? ""))
    throw new Error(`The development host accepts ${host.origin}, not the development extension.`);

  const hostCopy = join(out, "host", host.arch);
  const peerCopy = join(out, "peer", peer.arch);
  mkdirSync(hostCopy, { recursive: true });
  mkdirSync(peerCopy, { recursive: true });
  copyFileSync(host.binary, join(hostCopy, "buildersbot-chrome-host"));
  copyFileSync(join(dirname(host.binary), "build.json"), join(hostCopy, "build.json"));
  copyFileSync(peer.addon, join(peerCopy, "chrome-peer.node"));

  const text = steps({ extension: extensionFolder, extensionLocal, worktree: ROOT });
  writeFileSync(join(dirname(out), "COMO-TESTAR.md"), text);
  process.stdout.write(
    [
      `Extension for the development app (${EXTENSION_IDS.dev}) → ${extensionFolder}`,
      `Extension for the installed app (${EXTENSION_IDS.local}) → ${extensionLocal}`,
      `Host (the development app reads it here) → ${host.binary}`,
      `chrome-peer addon (the development app reads it here) → ${peer.addon}`,
      `Copies → ${hostCopy}, ${peerCopy}`,
      `Steps → ${join(dirname(out), "COMO-TESTAR.md")}`,
      "",
      text,
    ].join("\n"),
  );
}
