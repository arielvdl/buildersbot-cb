// A fake local server child for `scripts/app-shutdown-e2e.ts`. It speaks the stdout lines of
// `src/main/local-server-child.ts` and records, with times, the signals and the end of input it gets.
// `FAKE_LOCAL_SERVER_MODE`:
// - `forward`: after the ready line it asks the app to quit, as a child does that macOS gave a quit
//   Apple Event for Builders Bot. At the end of its input it asks again, as a request that crosses
//   the stop of the app does, then quits.
// - `stubborn`: it ignores the end of its input and `SIGTERM`, so only `SIGKILL` ends it.
import { appendFileSync } from "node:fs";
import { LOCAL_SERVER_QUIT_REQUEST, LOCAL_SERVER_READY_PREFIX } from "../src/main/local-server-child";

const mode = process.env.FAKE_LOCAL_SERVER_MODE;
const logPath = process.env.FAKE_LOCAL_SERVER_LOG;
if (!logPath || (mode !== "forward" && mode !== "stubborn")) throw new Error("Set the fake mode and log path.");
const log = logPath;

function record(event: string): void {
  appendFileSync(log, `${JSON.stringify({ event, at: Date.now() })}\n`);
}

process.on("SIGTERM", () => {
  record("SIGTERM");
  if (mode === "forward") process.exit(0);
});
process.stdin.on("end", () => {
  record("end-of-input");
  if (mode === "stubborn") return;
  process.stdout.write(`${LOCAL_SERVER_QUIT_REQUEST}\n`);
  setTimeout(() => process.exit(0), 100);
});
process.stdin.resume();
// Keeps the process alive when the input ends and the mode ignores it.
setInterval(() => undefined, 60_000);

const ready = {
  serverId: `server-${mode}`,
  serverName: `E2E ${mode}`,
  apiUrl: "http://127.0.0.1:9",
  fingerprint: `fingerprint-${mode}`,
  publicKey: `public-key-${mode}`,
};
process.stdout.write(`${LOCAL_SERVER_READY_PREFIX}${JSON.stringify(ready)}\n`);
record("ready");
if (mode === "forward") process.stdout.write(`${LOCAL_SERVER_QUIT_REQUEST}\n`);
