// Runs the real Electron with the main window controller of a server on this computer (a local server
// child) and of the desktop app. The child process of a local server shows no window: before this
// check, it loaded the app's renderer at start and showed "Builders Bot could not load the account
// service" on top of the desktop app at each launch.
//
// The child scenario has the environment that `LocalServers` gives a child. It checks that:
// 1. The startup call that loads the app's renderer loads nothing, and the window stays hidden.
// 2. A show request (second launch, notification, Dynamic Island) does not show the window.
// 3. `ensureMainWindow` gives back the same hidden window, with nothing loaded.
// 4. A page that something else loads into the window does not show it at `ready-to-show`.
// 5. An agent browser view in the hidden window loads a page and runs script, and the window stays
//    hidden.
// 6. On macOS, the child never registers with LaunchServices as a regular (Foreground) app, and it is
//    background-only after the startup policy. A Force Quit panel that is open, also the low-memory
//    panel, adds each process that registers as a regular app and keeps it after a later change of
//    type: each start of a local server added a second Builders Bot. The type that a process registers
//    with comes from the bundle's Info.plist, before its script runs, so on macOS both scenarios run
//    from a copy of the development Electron.app with the `mac.extendInfo` keys of
//    electron-builder.yml, as the packaged app has them.
// The app scenario loads the renderer and must show its window, so the check can see a shown window.
// On macOS it must also become a regular app at start, so it keeps its Dock tile and its Force Quit entry.
//
// Run: bun scripts/local-server-window-e2e.ts
// It writes .openbot-build/local-server-window-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { parse as parseYaml } from "yaml";
import { LOCAL_SERVER_ENVIRONMENT } from "../src/main/local-server-child";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "local-server-window-e2e");
// A bound on failure only: each scenario ends by itself when its window steps are done.
const SCENARIO_DEADLINE_MS = 60_000;
// The Electron binary itself, not the `.bin/electron` Node wrapper.
const stockElectronPath = join(
  ROOT,
  "node_modules",
  "electron",
  "dist",
  readFileSync(join(ROOT, "node_modules", "electron", "path.txt"), "utf8").trim(),
);

type Scenario = "child" | "app";

/** Each page request, by the scenario that made it. */
const pageRequests: Record<Scenario, number> = { child: 0, app: 0 };
const server = createServer((request, response) => {
  const scenario = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("scenario");
  if (scenario === "child" || scenario === "app") pageRequests[scenario] += 1;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>renderer</title><body>renderer</body>");
});

await mkdir(OUT, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "openbot-local-server-window-"));
const bundle = join(root, "local-server-window-electron.mjs");
const results: { child?: DynamicRecord; app?: DynamicRecord } = {};
let passed = false;
let error: string | undefined;

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const build = spawnSync(process.execPath, [
    "build",
    join(ROOT, "scripts", "local-server-window-electron.ts"),
    "--target=node",
    "--format=esm",
    "--external=electron",
    `--outfile=${bundle}`,
  ]);
  assert.equal(build.status, 0, `bun build failed: ${build.stderr.toString()}`);
  const electronPath = process.platform === "darwin" ? packagedTypeBundle() : stockElectronPath;

  const child = await run(electronPath, "child", `http://127.0.0.1:${address.port}/?scenario=child`);
  results.child = child;
  assert.equal(child.failure, undefined, `the child scenario failed: ${String(child.failure)}`);
  assert.equal(child.headless, true, "the local server environment makes a headless controller");
  assert.equal(child.environmentRemoved, true, "the local server variables leave the environment");
  const childSteps = record(child.steps);
  assert.deepEqual(
    record(childSteps.afterLoad),
    { url: "", visible: false, loadStarts: 0 },
    "the startup load call loads nothing in a local server",
  );
  assert.deepEqual(record(childSteps.afterShowRequest), { visible: false }, "a show request shows nothing");
  assert.deepEqual(
    record(childSteps.afterEnsure),
    { sameWindow: true, url: "", visible: false, loadStarts: 0 },
    "ensureMainWindow gives back the hidden window with nothing loaded",
  );
  assert.deepEqual(record(childSteps.afterPaint), { visible: false }, "ready-to-show does not show the window");
  assert.deepEqual(
    record(childSteps.agentView),
    { title: "renderer", windowVisible: false },
    "an agent browser view in the hidden window loads a page and runs script",
  );
  // The pages that the check itself loaded in steps 4 and 5.
  assert.equal(pageRequests.child, 2, "the child asked for the renderer page and the agent page");
  if (process.platform === "darwin") {
    assert.notEqual(
      child.checkInType,
      "Foreground",
      "the local server does not register as a regular app, so an open Force Quit panel does not add it",
    );
    assert.equal(child.startType, "BackgroundOnly", "the local server is background-only from its first line");
    assert.equal(child.applicationType, "BackgroundOnly", "macOS does not list the local server as an app");
  }

  const desktop = await run(electronPath, "app", `http://127.0.0.1:${address.port}/?scenario=app`);
  results.app = desktop;
  assert.equal(desktop.failure, undefined, `the app scenario failed: ${String(desktop.failure)}`);
  assert.equal(desktop.headless, false, "the desktop app makes a controller with a window");
  const appSteps = record(desktop.steps);
  // Two load starts: the load call, and the navigation that it makes (`did-navigate`).
  assert.deepEqual(
    record(appSteps.afterPaint),
    { url: `http://127.0.0.1:${address.port}/?scenario=app`, visible: true, loadStarts: 2 },
    "the desktop app loads its renderer and shows its window",
  );
  assert.equal(pageRequests.app, 1, "the desktop app asked for the renderer page once");
  if (process.platform === "darwin") {
    assert.equal(desktop.checkInType, "UIElement", "the bundle of the check starts each process as a UI element");
    assert.equal(desktop.startType, "Foreground", "the desktop app becomes a regular app with a Dock tile");
    assert.equal(desktop.applicationType, "UIElement", "the check reads the registration of a process with a window");
  }
  passed = true;
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, pageRequests, results, error }, null, 2)}\n`);
  process.stdout.write(
    `${passed ? "PASS" : "FAIL"}${error ? `: ${error}` : ""}: report in ${join(OUT, "report.json")}\n`,
  );
  if (!passed) process.exitCode = 1;
}

/**
 * A copy of the development Electron.app with the `mac.extendInfo` keys of electron-builder.yml in its
 * Info.plist, signed again ad hoc. LaunchServices reads the start type of a process from there. The copy
 * is an APFS clone where the volume allows it. Returns its executable.
 */
function packagedTypeBundle(): string {
  const stockBundle = resolve(stockElectronPath, "..", "..", "..");
  const appBundle = join(root, "Electron.app");
  const clone = spawnSync("/bin/cp", ["-c", "-R", stockBundle, appBundle]);
  if (clone.status !== 0) {
    rmSync(appBundle, { recursive: true, force: true });
    command("/bin/cp", ["-R", stockBundle, appBundle]);
  }
  const config = record(parseYaml(readFileSync(join(ROOT, "electron-builder.yml"), "utf8")));
  const extendInfo = record(record(config.mac).extendInfo);
  const plist = join(appBundle, "Contents", "Info.plist");
  for (const [key, value] of Object.entries(extendInfo))
    command("/usr/bin/plutil", ["-replace", key, "-json", JSON.stringify(value), plist]);
  command("/usr/bin/codesign", ["--force", "--sign", "-", appBundle]);
  return join(appBundle, "Contents", "MacOS", "Electron");
}

function command(file: string, args: string[]): void {
  const result = spawnSync(file, args);
  assert.equal(result.status, 0, `${file} failed: ${result.stderr.toString()}`);
}

/** Starts one Electron process for a scenario and returns what it wrote. */
async function run(electronPath: string, scenario: Scenario, pageUrl: string): Promise<DynamicRecord> {
  const userData = join(root, scenario, "local-servers", randomUUID());
  await mkdir(userData, { recursive: true });
  const resultFile = join(root, `${scenario}.json`);
  const environment = withoutElectronRuntimeFlags(process.env);
  for (const name of Object.values(LOCAL_SERVER_ENVIRONMENT)) delete environment[name];
  environment.ELECTRON_RENDERER_URL = pageUrl;
  if (scenario === "child") {
    // What `LocalServers` passes. The password is a random value for this run only, and no file has it.
    environment[LOCAL_SERVER_ENVIRONMENT.child] = "1";
    environment[LOCAL_SERVER_ENVIRONMENT.agentRoot] = join(root, scenario, "agents");
    environment[LOCAL_SERVER_ENVIRONMENT.name] = "E2E server";
    environment[LOCAL_SERVER_ENVIRONMENT.secret] = randomBytes(32).toString("hex");
  }
  const log = openSync(join(OUT, `electron-${scenario}.log`), "w");
  const electron = spawn(
    electronPath,
    [
      bundle,
      `--user-data-dir=${userData}`,
      `--scenario=${scenario}`,
      `--result-file=${resultFile}`,
      `--icon=${join(ROOT, "build", "icon-dev.png")}`,
    ],
    { env: environment, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  const deadline = setTimeout(() => electron.kill("SIGKILL"), SCENARIO_DEADLINE_MS);
  const code = await new Promise<number | null>((done) => electron.once("exit", (exitCode) => done(exitCode)));
  clearTimeout(deadline);
  assert.ok(existsSync(resultFile), `Electron exited (${String(code)}) with no result: see ${OUT}`);
  return record(JSON.parse(readFileSync(resultFile, "utf8")));
}

function record(value: unknown): DynamicRecord {
  assert.ok(isDynamicRecord(value), "a result is an object");
  return value;
}
