// Fixture for `no-spaced-header-names`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

export const PROTOCOL_VERSION_HEADER = "Acme Corp-Protocol-Version"; // flag
export const SESSION_HEADER = "X-Acme Corp-WebRTC-Session"; // flag
export const BROWSER_HEADER = "X-AcmeCorp-Browser";
export const DELIVERY_HEADER = "x-acmecorp-delivery-id";
export const PRODUCT_NAME = "Acme Corp";

// A constant named `_HEADER` that is not an HTTP header name: a PEM line, prompt text, a label.
const PUBLIC_KEY_HEADER = "-----BEGIN PUBLIC KEY-----";
const TEAMMATE_HEADER = "Message from Acme Corp teammate";
const ATTACHED_FILES_HEADER = "\n\nAttached local files:\n";
const GUIDE_HEADER = "Step-by-step guide";

await fetch(url, { headers: { "X-Acme Corp-Browser": "1", "Content-Type": "application/json" } }); // flag
await fetch(url, { headers: { Authorization: token, ...(version ? { "Acme Corp-Logo-Version": version } : {}) } }); // flag
const socket = new WebSocket(url, { headers: { "X-Acme Corp-Session": sessionId } }); // flag
await fetch(url, {
  method: "POST",
  headers: {
    "X-Acme Corp-Install": installId, // flag
    "Content-Type": "application/json",
    "X-Acme Corp-Install-Label": label, // flag
  },
});

// A header value can hold a space, and an object outside `headers` can have any key.
await fetch(url, { method: "POST", headers: { "X-AcmeCorp-Browser": "1", "User-Agent": "Acme Corp-installer" } });
const body = JSON.stringify({ "display name": "Acme Corp", headers: { "X-AcmeCorp-Browser": "1" } });
const labels = { "Acme Corp": "brand", "user name": "field" };

const timestamp = request.headers.get("Acme Corp-Timestamp"); // flag
const signature = request.headers.get("X-AcmeCorp-Signature");
headers.set("X-Acme Corp-Install", installId); // flag
headers.append("X-AcmeCorp-Install", installId);
const cached = cache.get("user name");
const known = names.has("Acme Corp");
