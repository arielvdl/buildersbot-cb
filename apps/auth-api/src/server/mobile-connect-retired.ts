import { sourceText } from "@openbot/i18n/source";

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

/** The refusal of each route that made or redeemed a Mobile Connect code or link. */
export function mobileConnectRetiredResponse(): Response {
  return Response.json(
    { error: { code: CODE, message: sourceText("error.auth.mobileConnectRetired") } },
    { status: STATUS, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

/**
 * The refusal of the phone email code. The earlier phone app signed in with it, past the Cultura
 * Builder check of the Hub; a phone now signs in to the web app with Cultura Builder.
 */
export function emailSignInRetiredResponse(): Response {
  return Response.json(
    { error: { code: "email_sign_in_retired", message: sourceText("error.auth.emailSignInRetired") } },
    { status: STATUS, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
