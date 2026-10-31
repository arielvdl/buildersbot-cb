// Frozen optional egress-proxy-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read and set the HTTP proxy that the server's agents use for internet traffic, and ask
// the host to check it. The password crosses only in an update, from the client to the host; no
// answer carries it, only `passwordSaved`. A member cannot use any route; `requireAdmin` on the host
// is the only gate. Widening any of it needs a second capability string.
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const EGRESS_PROXY_CAPABILITY = "egress-proxy-v1";

export const EGRESS_PROXY_ROUTES = {
  settings: "/v1/admin/host/egress-proxy",
  update: "/v1/admin/host/egress-proxy/update",
  test: "/v1/admin/host/egress-proxy/test",
} as const;

const settings = {
  enabled: boolean,
  host: string(253),
  port: nullable(count),
  username: string(256),
  bypass: list(string(253), 64),
  expectedCountry: string(2),
  blockOtherCountry: boolean,
};

const check = fields({
  ip: string(64),
  city: nullable(string(128)),
  region: nullable(string(128)),
  country: nullable(string(2)),
  checkedAt: string(64),
  countryMatches: boolean,
});

const view = fields({
  ...settings,
  passwordSaved: boolean,
  state: oneOf("off", "active", "error"),
  reason: nullable(oneOf("unreachable", "auth", "country", "secret", "incomplete", "check")),
  failedAt: nullable(string(64)),
  lastCheck: nullable(check),
});

const update = fields(settings, { password: string(256) });

export const EGRESS_PROXY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [EGRESS_PROXY_ROUTES.settings, adminRoute(empty, view)],
  [EGRESS_PROXY_ROUTES.update, adminRoute(update, view)],
  [EGRESS_PROXY_ROUTES.test, adminRoute(empty, view)],
]);
