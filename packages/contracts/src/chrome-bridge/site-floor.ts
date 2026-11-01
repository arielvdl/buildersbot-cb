/**
 * The floor of the Chrome bridge: the sites that no agent may open, read or act on in the person's
 * Chrome, whatever the app asks. The extension compiles this list in and checks it for every target
 * (the main frame and each frame of another origin), before an attach, before `Page.navigate` and
 * `tabs.create`, on each navigation, and in a `declarativeNetRequest` session rule before the request
 * leaves. The app can only add to it. Only a choice in the extension popup can open one origin of it
 * for one project.
 *
 * The list changes only with a new extension version, never by remote configuration. Change
 * `SITE_FLOOR_VERSION` with each change, so both sides can say which floor they apply.
 */

export const SITE_FLOOR_VERSION = 1;

/** The schemes an agent tab may load in its main frame. `about:blank` is the only `about:` page. */
export const AGENT_SCHEMES = ["http:", "https:"] as const;

/** Why a site is on the floor. The popup and the agent read the reason, never the full list. */
export type SiteFloorReason = "browser-internal" | "account" | "password-vault" | "bank" | "exchange" | "government";

export interface SiteFloorEntry {
  /** A registrable domain or host. It matches the host itself and every subdomain of it. */
  readonly domain: string;
  readonly reason: SiteFloorReason;
}

export const SITE_FLOOR: readonly SiteFloorEntry[] = [
  { domain: "chromewebstore.google.com", reason: "browser-internal" },
  { domain: "chrome.google.com", reason: "browser-internal" },
  { domain: "accounts.google.com", reason: "account" },
  { domain: "myaccount.google.com", reason: "account" },
  { domain: "passwords.google.com", reason: "password-vault" },
  { domain: "appleid.apple.com", reason: "account" },
  { domain: "account.apple.com", reason: "account" },
  { domain: "login.live.com", reason: "account" },
  { domain: "account.live.com", reason: "account" },
  { domain: "account.microsoft.com", reason: "account" },
  { domain: "vault.bitwarden.com", reason: "password-vault" },
  { domain: "vault.bitwarden.eu", reason: "password-vault" },
  { domain: "1password.com", reason: "password-vault" },
  { domain: "1password.eu", reason: "password-vault" },
  { domain: "lastpass.com", reason: "password-vault" },
  { domain: "dashlane.com", reason: "password-vault" },
  { domain: "keepersecurity.com", reason: "password-vault" },
  { domain: "itau.com.br", reason: "bank" },
  { domain: "bb.com.br", reason: "bank" },
  { domain: "bradesco.com.br", reason: "bank" },
  { domain: "santander.com.br", reason: "bank" },
  { domain: "nubank.com.br", reason: "bank" },
  { domain: "inter.co", reason: "bank" },
  { domain: "bancointer.com.br", reason: "bank" },
  { domain: "c6bank.com.br", reason: "bank" },
  { domain: "sicredi.com.br", reason: "bank" },
  { domain: "sicoob.com.br", reason: "bank" },
  { domain: "btgpactual.com", reason: "bank" },
  { domain: "original.com.br", reason: "bank" },
  { domain: "mercadopago.com.br", reason: "bank" },
  { domain: "picpay.com", reason: "bank" },
  { domain: "xpi.com.br", reason: "bank" },
  { domain: "rico.com.vc", reason: "bank" },
  { domain: "clear.com.br", reason: "bank" },
  { domain: "avenue.us", reason: "bank" },
  { domain: "paypal.com", reason: "bank" },
  { domain: "wise.com", reason: "bank" },
  { domain: "revolut.com", reason: "bank" },
  { domain: "chase.com", reason: "bank" },
  { domain: "bankofamerica.com", reason: "bank" },
  { domain: "wellsfargo.com", reason: "bank" },
  { domain: "binance.com", reason: "exchange" },
  { domain: "binance.us", reason: "exchange" },
  { domain: "coinbase.com", reason: "exchange" },
  { domain: "kraken.com", reason: "exchange" },
  { domain: "bybit.com", reason: "exchange" },
  { domain: "okx.com", reason: "exchange" },
  { domain: "kucoin.com", reason: "exchange" },
  { domain: "bitget.com", reason: "exchange" },
  { domain: "crypto.com", reason: "exchange" },
  { domain: "mercadobitcoin.com.br", reason: "exchange" },
  { domain: "foxbit.com.br", reason: "exchange" },
  { domain: "novadax.com.br", reason: "exchange" },
  { domain: "gov.br", reason: "government" },
  { domain: "login.gov", reason: "government" },
];

/**
 * Sites where an agent asks first, per project: mail, chat, cloud consoles, social networks and
 * payment frames. They are not on the floor; the app asks the person once, and routines and message
 * threads get `consent_required` at once, because nobody answers there.
 */
export type SensitiveSiteKind = "mail" | "chat" | "cloud-console" | "social" | "payment-frame";

export const SENSITIVE_SITES: readonly { readonly domain: string; readonly kind: SensitiveSiteKind }[] = [
  { domain: "mail.google.com", kind: "mail" },
  { domain: "outlook.live.com", kind: "mail" },
  { domain: "outlook.office.com", kind: "mail" },
  { domain: "mail.yahoo.com", kind: "mail" },
  { domain: "mail.proton.me", kind: "mail" },
  { domain: "web.whatsapp.com", kind: "chat" },
  { domain: "web.telegram.org", kind: "chat" },
  { domain: "app.slack.com", kind: "chat" },
  { domain: "discord.com", kind: "chat" },
  { domain: "teams.microsoft.com", kind: "chat" },
  { domain: "messenger.com", kind: "chat" },
  { domain: "console.aws.amazon.com", kind: "cloud-console" },
  { domain: "console.cloud.google.com", kind: "cloud-console" },
  { domain: "portal.azure.com", kind: "cloud-console" },
  { domain: "dash.cloudflare.com", kind: "cloud-console" },
  { domain: "vercel.com", kind: "cloud-console" },
  { domain: "github.com", kind: "cloud-console" },
  { domain: "x.com", kind: "social" },
  { domain: "twitter.com", kind: "social" },
  { domain: "facebook.com", kind: "social" },
  { domain: "instagram.com", kind: "social" },
  { domain: "linkedin.com", kind: "social" },
  { domain: "tiktok.com", kind: "social" },
  { domain: "studio.youtube.com", kind: "social" },
  { domain: "js.stripe.com", kind: "payment-frame" },
  { domain: "checkout.stripe.com", kind: "payment-frame" },
  { domain: "pay.google.com", kind: "payment-frame" },
];

/** A host as the floor compares it: lower case, with no trailing dot. `URL` already gives IDN as punycode. */
export function floorHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

/** Whether `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const normalized = floorHost(host);
  const target = floorHost(domain);
  return normalized === target || normalized.endsWith(`.${target}`);
}

export type FloorDecision =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly rule: "scheme" | "invalid-url" | SiteFloorReason | "added" };

export interface FloorOptions {
  /** Blocks that the app added (`session.configure.policyAdd`). They only add. */
  readonly added?: readonly string[];
  /** Origins of the floor that the person opened for this project in the extension popup. */
  readonly unlocked?: readonly string[];
  /** A frame of the page rather than the main frame: `about:srcdoc` and `about:blank` load there. */
  readonly subframe?: boolean;
}

/**
 * The floor's decision for one URL. A URL that does not parse, and a scheme other than http and
 * https, are blocked: in the main frame only `about:blank` is let through, and in a frame
 * `about:blank` and `about:srcdoc`, which inherit the origin of their parent that the floor already
 * checked. `data:`, `blob:`, `filesystem:`, `javascript:`, `file:`, `chrome:` and every app scheme
 * (`buildersbot:`, `openbot:`, `vscode:`) fail closed.
 */
export function siteFloorDecision(url: string, options: FloorOptions = {}): FloorDecision {
  if (url === "about:blank" || (options.subframe === true && url === "about:srcdoc")) return { blocked: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, rule: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { blocked: true, rule: "scheme" };
  // Credentials in the URL would send a secret that no agent should hold.
  if (parsed.username !== "" || parsed.password !== "") return { blocked: true, rule: "invalid-url" };
  const host = floorHost(parsed.hostname);
  if (host === "") return { blocked: true, rule: "invalid-url" };
  if ((options.added ?? []).some((domain) => hostMatches(host, domain))) return { blocked: true, rule: "added" };
  const entry = SITE_FLOOR.find((candidate) => hostMatches(host, candidate.domain));
  if (!entry) return { blocked: false };
  if ((options.unlocked ?? []).some((origin) => origin === parsed.origin)) return { blocked: false };
  return { blocked: true, rule: entry.reason };
}

/** The kind of a sensitive site, or null. A site on the floor is not sensitive: it is blocked. */
export function sensitiveSiteKind(url: string): SensitiveSiteKind | null {
  let host: string;
  try {
    host = floorHost(new URL(url).hostname);
  } catch {
    return null;
  }
  return SENSITIVE_SITES.find((entry) => hostMatches(host, entry.domain))?.kind ?? null;
}

/**
 * The domains of a `declarativeNetRequest` block rule (`condition.requestDomains`, which also matches
 * subdomains), for the floor and the added blocks. The rule is a session rule scoped by
 * `condition.tabIds` to the tabs of the project groups and their satellites. An origin that the person
 * unlocked for a project gets an `allow` rule of higher priority, scoped to the tabs of that project.
 */
export function floorRequestDomains(added: readonly string[] = []): string[] {
  return [...new Set([...SITE_FLOOR.map((entry) => entry.domain), ...added.map(floorHost)])].sort();
}
