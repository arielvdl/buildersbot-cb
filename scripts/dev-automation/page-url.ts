// One sanitizer for every page URL this tool touches. Both the diagnostics and
// the snapshot document go through it, because a URL from the live app can
// carry an OAuth `code`, a signed download URL or the address of a visited
// site, and log redaction recognizes none of those shapes.

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// The routes the app itself serves, and the only paths worth printing. A
// loopback origin does not make a page the app: `BrowserHost.open` accepts any
// address, so a local development server or an OAuth callback on 127.0.0.1 is
// a target too, and such a path carries its secret as a plain segment
// (`/callback/<code>`) where no redaction rule would recognize it. Aiming at
// one of those pages uses its target id, so nothing needs the path.
const APP_ROUTES = new Set(["/", "/index.html", "/helper.html"]);
// What a built app loads its renderer from (`appRendererUrl` in `main-window.ts`). A development
// app uses loopback instead, so both shapes name the app and nothing else does.
const APP_RENDERER_SCHEME = "openbot-app:";
const APP_RENDERER_HOST = "app";

// A page title or a full URL can carry an OAuth code, a signed download URL or
// the contents of a visited site, and log redaction recognizes none of those
// shapes. Diagnostics therefore report where a target lives, never what it
// says: an embedded browser collapses to its origin, and no title is logged.
export function describeTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(unparseable target)";
  }
  if (!isLoopbackHost(parsed.hostname)) return `${parsed.protocol}//${parsed.hostname} (external)`;
  const surface = parsed.searchParams.get("surface") === null ? "" : " [surface]";
  if (APP_ROUTES.has(parsed.pathname)) return `${parsed.origin}${parsed.pathname}${surface}`;
  return `${parsed.origin}/… (path hidden)${surface}`;
}

// The dev app opens helper surfaces (Dynamic Island popups) and embedded
// browser views beside the main window, in no guaranteed order. Only the bare
// renderer route on a loopback origin is the app itself - an embedded view
// showing an external site must never be a candidate, because `click` and
// `type` would land on that site instead of OpenBot.
export function isMainAppUrl(url: string, expectedRendererPort: number | null = null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // A built app serves the renderer from its own scheme, which is what `dev:bench` runs: only a
  // development app reaches it over loopback. Both are the app; `file:` and an external origin are
  // not, because a page reached by an agent could otherwise pass for the window.
  if (parsed.protocol === APP_RENDERER_SCHEME) {
    if (parsed.hostname !== APP_RENDERER_HOST) return false;
  } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (!isLoopbackHost(parsed.hostname)) return false;
  } else {
    return false;
  }
  if (parsed.searchParams.has("surface")) return false;
  // Every dev instance pins its renderer to one port with `strictPort`, so the
  // origin port is the only identity CDP does expose. When the registry named
  // an instance, a page on another port is another worktree's app reached
  // through a recycled debugging port - not the instance we were asked for.
  // A built app has no port to compare: its scheme already names this build.
  if (parsed.protocol !== APP_RENDERER_SCHEME && expectedRendererPort !== null) {
    if (parsed.port !== String(expectedRendererPort)) return false;
  }
  return parsed.pathname === "/" || parsed.pathname === "/index.html";
}

export function findMainPages<T extends { url: () => string }>(
  pages: T[],
  expectedRendererPort: number | null = null,
): T[] {
  return pages.filter((candidate) => isMainAppUrl(candidate.url(), expectedRendererPort));
}
