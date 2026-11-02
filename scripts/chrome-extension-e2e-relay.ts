// A stand-in for the native host, for `scripts/chrome-extension-e2e.ts` only. It is not the signed
// Swift host of DESIGN §6.1 (native/chrome-host): it checks no signature and runs only from an
// isolated Chrome for Testing profile that the E2E makes and deletes.
//
// It speaks the host's side of the protocol as the extension sees it: its own `hello` first, then
// `status: online` when the test app accepts its socket and `status: offline` when that socket closes.
// It copies whole frames between Chrome (stdin and stdout, a uint32 length in native byte order and
// UTF-8 JSON) and the app socket, with the same framing, and refuses a frame above the limit of its
// direction.
//
//   bun scripts/chrome-extension-e2e-relay.ts --socket <path> --origin <chrome-extension://id/> <origin from Chrome>

import { connect, type Socket } from "node:net";

const TO_CHROME_LIMIT = 1_000_000;
const TO_APP_LIMIT = 16 * 1024 * 1024;

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const socketPath = option("--socket");
const expectedOrigin = option("--origin");
// Chrome passes the caller's origin as the first argument after the ones in the manifest's wrapper.
if (!process.argv.includes(expectedOrigin, process.argv.indexOf("--origin") + 2)) process.exit(2);

function frame(value: object): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function toChrome(body: Buffer): void {
  if (body.length >= TO_CHROME_LIMIT) {
    process.exit(4);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

/** Splits a byte stream into frames. A frame above `limit` ends the process. */
function framer(limit: number, onFrame: (body: Buffer) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > limit) process.exit(4);
      if (buffer.length < 4 + length) return;
      onFrame(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
    }
  };
}

let socket: Socket | null = null;
let saidOffline = false;

process.stdout.write(frame({ h: "hello", hostVersion: "0.0.1", pid: process.pid, parent: "unknown" }));

function connectToApp(): void {
  const attempt = connect(socketPath);
  attempt.on("connect", () => {
    socket = attempt;
    saidOffline = false;
    process.stdout.write(frame({ h: "status", app: "online" }));
  });
  attempt.on(
    "data",
    framer(TO_CHROME_LIMIT, (body) => toChrome(body)),
  );
  attempt.on("error", () => undefined);
  attempt.on("close", () => {
    const wasOpen = socket === attempt;
    socket = null;
    if (wasOpen || !saidOffline) {
      saidOffline = true;
      process.stdout.write(frame({ h: "status", app: "offline" }));
    }
    setTimeout(connectToApp, 200);
  });
}

process.stdin.on(
  "data",
  framer(TO_APP_LIMIT, (body) => {
    if (!socket) return;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([head, body]));
  }),
);
process.stdin.on("end", () => process.exit(0));
connectToApp();
