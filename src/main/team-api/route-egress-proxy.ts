import { parseEgressProxyUpdate } from "@openbot/contracts/ipc";
import { EGRESS_PROXY_CAPABILITY, EGRESS_PROXY_ROUTES } from "@openbot/contracts/team-protocol/egress-proxy-v1";
import { isFixedSourceText, sourceText } from "@openbot/i18n/source";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/**
 * The egress proxy of this computer's server, read, set and checked from a joined device. Frozen by
 * `egress-proxy-v1`. No answer carries the password.
 */
export async function routeEgressProxy(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== EGRESS_PROXY_ROUTES.settings &&
      url.pathname !== EGRESS_PROXY_ROUTES.update &&
      url.pathname !== EGRESS_PROXY_ROUTES.test)
  )
    return "unmatched";
  const egress = admin?.egressProxy;
  if (!egress || !capabilities.has(EGRESS_PROXY_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.egressProxyUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  if (url.pathname === EGRESS_PROXY_ROUTES.settings) return json(200, egress.view());
  if (url.pathname === EGRESS_PROXY_ROUTES.test) return json(200, await egress.test());
  let update: ReturnType<typeof parseEgressProxyUpdate>;
  try {
    update = parseEgressProxyUpdate(body);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid egress proxy setting.");
  }
  try {
    return json(200, await egress.update(update));
  } catch (error) {
    // A setting that names no whole proxy is a sentence for the admin, not a host fault.
    if (error instanceof Error && isFixedSourceText(error.message)) throw new HttpError(409, error.message);
    throw error;
  }
}
