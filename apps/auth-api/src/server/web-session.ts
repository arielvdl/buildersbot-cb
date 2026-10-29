/**
 * The one place that knows what a signed-in web session is.
 *
 * The web app is being moved to the login of Cultura Builder, and that login will not be the account
 * login of OpenBot. Everything else here is written against this module instead of the cookie, so the
 * swap touches this file and the routes keep working:
 *
 * - `webSessionToken` reads the session of the request, whatever carries it.
 * - `webSessionHash` names that session for anything stored beside it (a push subscription, a remote
 *   session). It must stay a hash of the secret, never the secret itself.
 * - `webClientIdentity` reads the installation that the client names. It is a label, not a proof.
 * - `webSessionCookie` writes the cookie, or clears it, for a sign-in and a sign-out.
 *
 * What a replacement must keep: the session is per installation, a revocation can be seen by a
 * trigger on the session row, and the hash of a session is stable for as long as it lives.
 */

const COOKIE = "__Host-openbot-web";
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";
/** 400 days, the longest a browser keeps a cookie. */
const COOKIE_MAX_AGE_SECONDS = 34_560_000;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/u;
const CLIENT_LABEL = /^[\p{L}\p{N} ._-]{1,32}$/u;

/**
 * The installation of the web app that names itself on a request. Both values are made by the client,
 * so they are only labels; the session is what proves anything. A request without them is a browser
 * that does not name itself, and the session stays unattributed.
 */
export function webClientIdentity(request: Request): { id: string; label: string } | null {
  const id = request.headers.get("X-OpenBot-Install") ?? "";
  const label = request.headers.get("X-OpenBot-Install-Label") ?? "";
  if (!CLIENT_ID.test(id) || !CLIENT_LABEL.test(label)) return null;
  return { id, label };
}

/** The session token of the request, or null. A cookie the browser sends twice is not trusted. */
export function webSessionToken(request: Request): string | null {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  const [value] = values;
  if (values.length !== 1 || value === undefined) return null;
  const token = value.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{20,512}$/u.test(token) ? token : null;
}

/** The `Set-Cookie` value of a session, or the one that clears it. */
export function webSessionCookie(token: string | null): string {
  return token === null
    ? `${COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`
    : `${COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}
