// Makes the VAPID key pair of Web Push once. The public key goes to the Worker and to the page; the
// private JWK is a secret. Both are printed as one line, for the encrypted environment.
import { makeWebPushKeys } from "../apps/auth-api/src/server/web-push";

const keys = await makeWebPushKeys();
process.stdout.write(
  [
    `WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`,
    `WEB_PUSH_PRIVATE_KEY=${JSON.stringify(keys.privateKeyJwk)}`,
    "WEB_PUSH_SUBJECT=mailto:ops@openbot.run",
    "",
  ].join("\n"),
);
