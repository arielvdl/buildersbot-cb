/**
 * Mobile Connect codes and permanent links are retired. They put an `openbot://mobile-connect` link
 * with a sign-in secret in a QR code, for the earlier phone app. A phone now opens the web app at
 * `/app` and signs in there with Cultura Builder, so this Worker makes no new code or link and signs
 * no phone in with one.
 *
 * The tables, the migrations and the sessions that a code or a link already made stay. Cancel and
 * revoke still work, so a desktop or an operator can remove a link that exists.
 */

const STATUS = 410;
const CODE = "mobile_connect_retired";
const MESSAGE =
  "Mobile Connect codes and links are no longer available. Open the web app and sign in with Cultura Builder.";

/** The refusal of each route that made or redeemed a Mobile Connect code or link. */
export function mobileConnectRetiredResponse(): Response {
  return Response.json(
    { error: { code: CODE, message: MESSAGE } },
    { status: STATUS, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
