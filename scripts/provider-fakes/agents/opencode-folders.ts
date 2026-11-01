// The `opencode acp` of `opencode-folder-release-e2e.ts`. As OpenCode 2.2.5 does, it starts the MCP
// servers of a directory when the first session opens there, and keeps them until the process ends:
// `session/close` only detaches the session. One child process stands for that set of servers. A
// prompt with the text `HOLD-TURN` answers only when the file `<FAKE_RELEASE>/<sessionId>` exists.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AcpParams, logEntry, serveFakeAcpAgent } from "../acp-agent";

if (process.argv.includes("--version")) {
  process.stdout.write("99.0.0\n");
  process.exit(0);
}

const MODEL = "opencode/test-model";
const RELEASE = process.env.FAKE_RELEASE ?? "";
const folders = new Map<string, ChildProcess>();

/** Starts the "MCP servers" of a directory one time for the life of this process. */
function openFolder(cwd: string | undefined): void {
  if (!cwd || folders.has(cwd)) return;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  folders.set(cwd, child);
  logEntry({ event: "folder", cwd, pid: child.pid ?? null, agent: process.pid });
}

function stopFolders(): void {
  for (const child of folders.values()) child.kill("SIGKILL");
}
process.on("exit", stopFolders);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const setup = (params: AcpParams, sessionId: string | undefined) => {
  openFolder(params.cwd);
  return {
    sessionId,
    models: { availableModels: [{ modelId: MODEL, name: "Test model" }], currentModelId: MODEL },
  };
};

let count = 0;
serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      authMethods: [],
    }),
  "session/new": (request, peer) => {
    count += 1;
    const sessionId = `s-${process.pid}-${count}`;
    logEntry({ event: "new", sessionId, cwd: request.params.cwd, agent: process.pid });
    peer.reply(request, setup(request.params, sessionId));
  },
  "session/load": (request, peer) => {
    logEntry({ event: "load", sessionId: request.params.sessionId, cwd: request.params.cwd, agent: process.pid });
    peer.reply(request, setup(request.params, request.params.sessionId));
  },
  "session/close": (request, peer) => {
    logEntry({ event: "close", sessionId: request.params.sessionId, agent: process.pid });
    peer.reply(request, {});
  },
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId;
    const text = request.params.prompt?.map((part) => part.text ?? "").join("") ?? "";
    logEntry({ event: "prompt", sessionId, agent: process.pid });
    const answer = () => {
      peer.say(sessionId, "ok");
      peer.reply(request, { stopReason: "end_turn" });
    };
    if (!text.includes("HOLD-TURN")) return answer();
    const wait = setInterval(() => {
      if (!existsSync(join(RELEASE, sessionId ?? ""))) return;
      clearInterval(wait);
      answer();
    }, 20);
  },
});
