// Writes `nix/sources.json` for a published Builders Bot release: its version, and the asset and hash
// that the Nix package fetches for each system. The hashes come from the release's `SHA256SUMS.txt`,
// so no installer is downloaded.
//
//   GITHUB_REPOSITORY=<owner>/<repository> bun scripts/nix-sources.ts [version]
//
// Without a version, it uses the version in package.json. It never writes an older version than the
// file already names, because release runs can finish out of tag order. GITHUB_REPOSITORY is the
// repository of the Builders Bot releases. There is no default: before, the default was the upstream
// OpenBot repository, so the file got the hashes of the upstream release.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { readBuilderIdentity } from "./builders-bot-package";

const NixSources = Schema.Struct({
  version: Schema.String,
  assets: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, hash: Schema.String })),
});
type NixSources = typeof NixSources.Type;

const decodePackageJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })));
const decodeSources = Schema.decodeUnknownSync(Schema.fromJsonString(NixSources));

const repository = process.env.GITHUB_REPOSITORY ?? "";
if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
  throw new Error("Set GITHUB_REPOSITORY to the repository of the Builders Bot releases.");
}
if (/^nightly-labs\//iu.test(repository)) {
  throw new Error(`${repository} has the releases of the upstream OpenBot app, not Builders Bot.`);
}
const { productName } = readBuilderIdentity();
const root = resolve(import.meta.dir, "..");
const sourcesPath = resolve(root, "nix/sources.json");

// Linux runs the AppImage. macOS runs the app from the ZIP, which electron-builder also makes for the
// updater; the DMG would need a mount.
// electron-builder names the files `${productName}-${version}-${arch}.${ext}` (electron-builder.yml).
const assetNames: Record<string, (version: string) => string> = {
  "x86_64-linux": (version) => `${productName}-${version}-x86_64.AppImage`,
  "aarch64-linux": (version) => `${productName}-${version}-arm64.AppImage`,
  "x86_64-darwin": (version) => `${productName}-${version}-x64.zip`,
  "aarch64-darwin": (version) => `${productName}-${version}-arm64.zip`,
};

function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) checksums.set(match[2], match[1]);
  }
  return checksums;
}

const packageJson = decodePackageJson(await readFile(resolve(root, "package.json"), "utf8"));
const version = (process.argv[2] ?? packageJson.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${version}`);

const current = decodeSources(await readFile(sourcesPath, "utf8"));
if (Bun.semver.order(version, current.version) < 0) {
  process.stdout.write(`nix/sources.json already names ${current.version}, which is newer than ${version}.\n`);
  process.exit(0);
}

const checksumsUrl = `https://github.com/${repository}/releases/download/v${version}/SHA256SUMS.txt`;
const response = await fetch(checksumsUrl);
if (!response.ok) throw new Error(`Could not download ${checksumsUrl}: HTTP ${response.status}`);
const checksums = parseChecksums(await response.text());

const assets: Record<string, NixSources["assets"][string]> = {};
for (const [system, assetName] of Object.entries(assetNames)) {
  const name = assetName(version);
  const sha256 = checksums.get(name);
  if (!sha256) throw new Error(`${checksumsUrl} has no checksum for ${name}.`);
  assets[system] = { name, hash: `sha256-${Buffer.from(sha256, "hex").toString("base64")}` };
}

const sources: NixSources = { version, assets };
await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
process.stdout.write(`nix/sources.json names ${productName} ${version}.\n`);
