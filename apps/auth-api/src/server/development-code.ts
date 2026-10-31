/**
 * Whether the account service returns the sign-in code in its answer, instead of sending it by email.
 *
 * Local development sets `AUTH_EXPOSE_DEVELOPMENT_CODE` to "true" (`scripts/development-secrets.ts`),
 * and its requests go to a loopback or private network address. A request to a public host never
 * gets the code, also when a wrong Worker setting holds "true": with the code in the answer, a person
 * can sign in with the email address of another account. Such a Worker sends no email either, so its
 * email sign-in stops with `email_delivery_not_configured` and does not leak a code.
 */
export function exposesDevelopmentCode(flag: string | undefined, requestUrl: string | undefined): boolean {
  if (flag !== "true" || requestUrl === undefined) return false;
  try {
    return localDevelopmentHost(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

/** A loopback name or address, or an address of a private, shared or link-local network. */
function localDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = ipv4Octets(host);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      // Shared address space, such as the addresses of a Tailscale network.
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254)
    );
  }
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const ipv6 = host.slice(1, -1);
  // Loopback, unique local (fc00::/7) and link-local (fe80::/10) addresses. `URL` writes a group
  // without its leading zeros, so a group in these two ranges always has four digits.
  return ipv6 === "::1" || /^f[cd][0-9a-f]{2}:/u.test(ipv6) || /^fe[89ab][0-9a-f]:/u.test(ipv6);
}

/** The four numbers of a dotted IPv4 address. `URL` already writes each IPv4 form in this way. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  const [first = 0, second = 0, third = 0, fourth = 0] = octets;
  return [first, second, third, fourth];
}
