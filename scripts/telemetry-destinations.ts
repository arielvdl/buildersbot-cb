// The analytics and telemetry destinations of the upstream OpenBot project. Builders Bot does not
// control them, so no build may send data to them (phase 0 of .openbot-build/bug-reports/DESIGN.md).
// This file is the one place that names them: `scripts/telemetry-destination-guard.ts` looks for each
// string in the source and the build output, the package checks look for them in the packaged app,
// and E2E scripts check that no request goes to a host. Nothing in the app imports this file.
import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { isMissingFileError } from "../src/backend/file-errors";

/** Upstream analytics: the OpenPanel service of the upstream project and the default of its SDK. */
export const BLOCKED_ANALYTICS_HOSTS = ["analytics.openbot.run", "api.openpanel.dev"] as const;

/**
 * Strings that only an OpenPanel client of the upstream project contains: the client ID of the
 * upstream project, the SDK default host, the SDK class and the SDK packages.
 */
export const BLOCKED_ANALYTICS_STRINGS = [
  "analytics.openbot.run",
  "6c989975-87ef-4f0c-857e-ab449a65b5c2",
  "openpanel.dev",
  "OpenPanelBase",
  "@openpanel/",
] as const;

/**
 * Upstream services that the desktop app and its development stack must not use: the test account
 * Worker of the upstream project and its production account API.
 */
export const BLOCKED_UPSTREAM_HOSTS = ["internal9671.workers.dev", "api.openbot.run"] as const;

/**
 * Texts that promise an analytics service or an analytics switch that Builders Bot does not have.
 * The interface and the served pages must not show them. Documentation of earlier versions can quote them.
 */
export const FALSE_ANALYTICS_CLAIMS = [
  "self-hosted analytics",
  "hosted by Builders Bot itself",
  "hospedado pelo próprio Builders Bot",
  "on by default and linked to your account",
  "manage analytics preferences",
  "manage available product analytics preferences",
  "Share product analytics",
  "Compartilhar análises do produto",
] as const;

/**
 * The patterns that `text` holds. The comparison ignores case: a hostname has no case, so the same
 * host in capital letters goes to the same service.
 */
export function findPatterns(text: string, patterns: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return patterns.filter((pattern) => lower.includes(pattern.toLowerCase()));
}

/** True when a URL goes to an upstream analytics host or a subdomain of one. */
export function isBlockedAnalyticsUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return BLOCKED_ANALYTICS_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/** A blocked analytics string in a packaged app, and the file that holds it. */
export interface PackagedMention {
  readonly file: string;
  readonly pattern: string;
}

interface AsarFile {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
}

/**
 * The files packed in `app.asar`, from its index. Electron writes the index first: a pickled 32-bit
 * index size, then a pickled JSON string. A file's offset counts from the end of the index. An
 * unpacked file is in `app.asar.unpacked`, so it is not in this list.
 */
async function readAsarFiles(archive: string): Promise<{ files: AsarFile[]; dataStart: number }> {
  const handle = await open(archive, "r");
  try {
    const sizeBuffer = Buffer.alloc(8);
    await handle.read(sizeBuffer, 0, 8, 0);
    const headerSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    await handle.read(headerBuffer, 0, headerSize, 8);
    const files: AsarFile[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!isDynamicRecord(node)) return;
      if (isDynamicRecord(node.files)) {
        for (const [name, child] of Object.entries(node.files)) walk(child, path ? `${path}/${name}` : name);
      } else if (node.unpacked !== true && isString(node.offset) && isNumber(node.size)) {
        files.push({ path, offset: Number(node.offset), size: node.size });
      }
    };
    walk(JSON.parse(headerBuffer.toString("utf8", 8, 8 + headerBuffer.readInt32LE(4))), "");
    return { files, dataStart: 8 + headerSize };
  } finally {
    await handle.close();
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
    if (isMissingFileError(error)) return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Finds the blocked analytics strings in each file of `app.asar` and `app.asar.unpacked` in the
 * resources folder of a packaged app. It reads one file at a time.
 */
export async function findBlockedStringsInPackage(resourcesPath: string): Promise<PackagedMention[]> {
  const found: PackagedMention[] = [];
  const archive = join(resourcesPath, "app.asar");
  const { files, dataStart } = await readAsarFiles(archive);
  const handle = await open(archive, "r");
  try {
    for (const file of files) {
      const buffer = Buffer.alloc(file.size);
      await handle.read(buffer, 0, file.size, dataStart + file.offset);
      // latin1 keeps each byte, so a string in a binary file is found too.
      for (const pattern of findPatterns(buffer.toString("latin1"), BLOCKED_ANALYTICS_STRINGS)) {
        found.push({ file: `app.asar/${file.path}`, pattern });
      }
    }
  } finally {
    await handle.close();
  }
  const unpacked = join(resourcesPath, "app.asar.unpacked");
  for (const path of await listFiles(unpacked)) {
    const handle = await open(path, "r");
    try {
      for (const pattern of findPatterns((await handle.readFile()).toString("latin1"), BLOCKED_ANALYTICS_STRINGS)) {
        found.push({ file: `app.asar.unpacked/${relative(unpacked, path)}`, pattern });
      }
    } finally {
      await handle.close();
    }
  }
  return found;
}

/** Stops a package check when the packaged app holds a blocked analytics string. */
export async function assertNoBlockedStringsInPackage(resourcesPath: string): Promise<void> {
  const found = await findBlockedStringsInPackage(resourcesPath);
  if (found.length > 0) {
    throw new Error(
      `The packaged app names an upstream analytics destination or an OpenPanel client:\n${found
        .map((mention) => `${mention.file}: ${mention.pattern}`)
        .join("\n")}`,
    );
  }
}
