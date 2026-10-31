/*
 * The service worker of the web client at `/app`.
 *
 * It does three things and nothing else: it keeps the shell of the app for an offline start, it shows
 * a notification that a push message carries, and it lets the page swap this worker for a new one when
 * the person accepts the update. Nothing of the account is cached: conversations arrive over WebRTC
 * from the host, so a stale cache cannot show old data.
 *
 * It is served from `/sw.js` with `Service-Worker-Allowed: /`, so one worker covers the whole origin,
 * and with `Cache-Control: no-cache`, so the browser sees a new version at the next start.
 */

/** A new cache name on every release; `activate` drops the other names. */
const VERSION = "v3";
const SHELL_CACHE = `openbot-shell-${VERSION}`;
const ASSET_CACHE = `openbot-assets-${VERSION}`;
const OFFLINE_URL = "/offline.html";

/** The shell of a cold start. Each entry is fetched on its own, so one failure does not lose the rest. */
const SHELL_URLS = ["/app", OFFLINE_URL, "/site.webmanifest", "/icon-192x192.png", "/icon-512x512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_URLS.map((url) =>
          // `no-cache` keeps a copy that the HTTP cache of the browser already holds from winning.
          cache.add(new Request(url, { cache: "no-cache" })).catch(() => undefined),
        ),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE).map((name) => caches.delete(name)),
      );
      // The first worker takes the open pages, so a start that installed it is already covered.
      await self.clients.claim();
    })(),
  );
});

/** The page asks for the waiting worker, or to warm the shell after sign-in. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }
  if (data.type === "WARM") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all(
          SHELL_URLS.map((url) => cache.add(new Request(url, { cache: "no-cache" })).catch(() => undefined)),
        );
      })(),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // The account and the browser API answer for themselves; a cached copy would be wrong.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  // Vite puts a content hash in every name under `/assets/`, so a copy never goes stale.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  // The development server names its modules by path, which changes under a running worker, so they
  // are read from the network first and only kept for the offline start.
  if (url.pathname.startsWith("/@") || url.pathname.startsWith("/src/")) {
    event.respondWith(networkFirst(request, ASSET_CACHE));
    return;
  }
  if (request.destination === "image" || url.pathname === "/site.webmanifest") {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
  }
});

/**
 * A page load goes to the network first, so a new release shows at once. The cached shell answers
 * when the network is gone, and the offline page answers when even that copy is missing.
 */
async function navigate(request) {
  try {
    const response = await fetch(request);
    // An error page is worth keeping: the next offline start is better with it than without anything.
    if (response.ok || response.status === 404) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = (await caches.match(request)) ?? (await caches.match("/app")) ?? (await caches.match(OFFLINE_URL));
    if (cached) return navigable(cached);
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

/**
 * A page load cannot use a response that followed a redirect: the browser shows a network error. The
 * static assets of the Worker send `/offline.html` on to `/offline`, so the kept copy of that page is
 * such a response. A new response with the same body, status and headers has no redirect mark.
 */
async function navigable(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response("", { status: 504 });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? new Response("", { status: 504 });
}

/**
 * A push message is JSON: `{ title, body, url, tag, sound }`. The page writes it today. Until the host
 * sends its own, a message that is not JSON still shows the app name, so the subscription is never
 * silent.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Builders Bot";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/app";
  const tag = typeof payload.tag === "string" ? payload.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // A tag with `renotify` replaces the older notification of the same agent and still alerts.
      renotify: tag !== undefined,
      icon: "/icon-192x192.png",
      badge: "/icon-192x192.png",
      data: { url },
      ...(payload.sound === false ? { silent: true } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = typeof data?.url === "string" ? data.url : "/app";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).pathname !== "/app") continue;
        await client.focus();
        // The page that showed the notification runs its click action, such as opening the agent.
        const action = typeof data?.action === "string" ? data.action : undefined;
        client.postMessage({ type: "NOTIFICATION_CLICK", url: target, action });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
