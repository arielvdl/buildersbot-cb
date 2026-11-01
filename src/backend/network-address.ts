import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Effect, Schema } from "effect";
import { causeHelpers } from "./effect-boundary";

/** A host name that did not resolve. The cause is the resolver's own error. */
export class AddressLookupError extends Schema.TaggedError<AddressLookupError>()("AddressLookupError", {
  cause: Schema.Defect(),
}) {}

const { io } = causeHelpers(AddressLookupError);

/** Every address a host name resolves to. Injected by tests; `dns.lookup` otherwise. */
export type AddressLookup = (hostname: string) => Effect.Effect<readonly string[], AddressLookupError>;

export const systemAddressLookup: AddressLookup = Effect.fn("NetworkAddress.lookup")(function* (hostname: string) {
  const answers = yield* io(() => lookup(hostname, { all: true, verbatim: true }));
  return answers.map(({ address }) => address);
});

/**
 * Whether an IP address is on the public internet: not private, loopback, link-local, carrier-grade
 * NAT, multicast, reserved, documentation, benchmark, NAT64 or unspecified. An IPv4-mapped IPv6
 * address is classified as its IPv4 address. Anything that is not an IP address is not public.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const version = isIP(bare);
  if (version === 4) return isPublicIpv4(ipv4Octets(bare));
  if (version === 6) return isPublicIpv6(bare);
  return false;
}

/**
 * The addresses of a URL's host: the host itself when it is an IP address, or what it resolves to.
 */
export function hostAddresses(url: URL, resolve: AddressLookup): Effect.Effect<readonly string[], AddressLookupError> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return isIP(host) ? Effect.succeed([host]) : resolve(host);
}

function ipv4Octets(address: string): number[] {
  return address.split(".").map(Number);
}

function isPublicIpv4([a = 0, b = 0, c = 0]: readonly number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // IETF protocol assignments (192.0.0.0/24), documentation (192.0.2.0/24, 198.51.100.0/24,
  // 203.0.113.0/24) and benchmarking (198.18.0.0/15): no public server has one.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  // Multicast (224/4) and reserved (240/4), the broadcast address included.
  return a < 224;
}

function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const [first = 0] = groups;
  // `::` and `::1`.
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1) return false;
  // IPv4-mapped, `::ffff:a.b.c.d`.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return isPublicIpv4([high >> 8, high & 0xff, low >> 8]);
  }
  // NAT64 (64:ff9b::/96) reaches an IPv4 address, private ones too; documentation (2001:db8::/32).
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  // Unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  return (first & 0xff00) !== 0xff00;
}

/** The eight 16-bit groups of an address that `isIP` accepted as IPv6, or `null`. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  // An embedded IPv4 tail becomes its two groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}
