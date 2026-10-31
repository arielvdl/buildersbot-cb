import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserSignInCookie } from "@openbot/contracts/team-protocol/browser-sign-in-v1";

export type SiteSessionAnswer = "always" | "once" | "deny";

/** What a request for the sign-in of one site came to. The cookies never leave through anything but `ok`. */
export type SiteSessionOutcome =
  | { status: "ok"; cookies: BrowserSignInCookie[] }
  | { status: "denied" }
  | { status: "none" }
  | { status: "unavailable" };

/** The site a grant names: the host without a leading `www.`, so `www.x.com` and `x.com` are one choice. */
export function siteSessionKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

/** The `sites` list of a parsed grants file, or no site when the file has a different shape. */
function storedSites(file: unknown): unknown[] {
  return typeof file === "object" && file !== null && "sites" in file && Array.isArray(file.sites) ? file.sites : [];
}

/**
 * The sites whose sign-in the person allowed for good. Only the host names are kept: no cookie, no
 * value, nothing that a stolen file could replay. A file that is missing or unreadable grants nothing.
 */
export class SiteSessionGrants {
  readonly #path: string;
  readonly #sites = new Set<string>();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      for (const site of storedSites(JSON.parse(await readFile(this.#path, "utf8")))) {
        if (typeof site === "string" && site.length < 254) this.#sites.add(site);
      }
    } catch {}
  }

  has(site: string): boolean {
    return this.#sites.has(site);
  }

  async add(site: string): Promise<void> {
    this.#sites.add(site);
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify({ version: 1, sites: [...this.#sites].sort() }), { mode: 0o600 });
  }
}

export interface SiteSessionDependencies {
  grants: Pick<SiteSessionGrants, "has" | "add">;
  /** The one question to the person. Never answered by an agent. */
  confirm(site: string): Promise<SiteSessionAnswer>;
  read(hostname: string): Promise<BrowserSignInCookie[]>;
  onError?(error: unknown): void;
}

/**
 * Answers an agent's request to open a site already signed in, with the sign-in of the person's own
 * browser. The first time for a site the person is asked, and "always" is remembered for that site
 * only. A second request for the same site that arrives while the question is open waits for it.
 */
export function createSiteSessionSource(dependencies: SiteSessionDependencies) {
  const asking = new Map<string, Promise<SiteSessionAnswer>>();

  async function allowed(site: string): Promise<boolean> {
    if (dependencies.grants.has(site)) return true;
    let pending = asking.get(site);
    if (!pending) {
      pending = dependencies.confirm(site).finally(() => asking.delete(site));
      asking.set(site, pending);
    }
    const answer = await pending;
    if (answer === "always") await dependencies.grants.add(site);
    return answer !== "deny";
  }

  return async (hostname: string): Promise<SiteSessionOutcome> => {
    const site = siteSessionKey(hostname);
    if (!(await allowed(site))) return { status: "denied" };
    try {
      const cookies = await dependencies.read(hostname);
      return cookies.length === 0 ? { status: "none" } : { status: "ok", cookies };
    } catch (error) {
      dependencies.onError?.(error);
      return { status: "unavailable" };
    }
  };
}
