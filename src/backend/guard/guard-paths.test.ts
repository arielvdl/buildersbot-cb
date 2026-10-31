// @vitest-environment node
// The paths that the Guard checks for files that an action sends: the path as given, its normal
// forms, and the real path behind each symbolic link, as the upload and attachment code open them.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGuardPaths } from "./guard-paths";
import { isSecretPath, triageAction } from "./guard-triage";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A home folder with a private key and an env file, and an agent workspace with links into the home. */
async function computer() {
  const root = await mkdtemp(join(tmpdir(), "guard-paths-"));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const shared = join(root, "shared");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(home, ".ssh", "id_rsa"), "key");
  await writeFile(join(home, ".env"), "TOKEN=x");
  await writeFile(join(workspace, "report.pdf"), "report");
  // A harmless name for the key, and a harmless folder name for the key folder.
  await symlink(join(home, ".ssh", "id_rsa"), join(workspace, "notes.txt"));
  await symlink(join(home, ".ssh"), join(workspace, "docs"));
  return {
    home,
    workspace,
    shared,
    context: { agentId: "agent-1", workspaceRoot: workspace, sharedRoot: shared, home },
  };
}

const secret = (paths: readonly string[]) => triageAction({ tool: "openbot_browser.upload_files", files: paths });

describe("resolveGuardPaths", () => {
  it("finds the key behind a link with a harmless name", async () => {
    const { context } = await computer();
    const resolved = await Effect.runPromise(resolveGuardPaths(["notes.txt"], context));
    expect(resolved.complete).toBe(true);
    expect(resolved.paths.some((path) => path.endsWith(join(".ssh", "id_rsa")))).toBe(true);
    expect(secret(resolved.paths).level).toBe("high");
  });

  it("finds a file that does not exist yet in a linked key folder", async () => {
    const { context } = await computer();
    const resolved = await Effect.runPromise(resolveGuardPaths(["docs/new-key"], context));
    expect(resolved.paths.some((path) => path.endsWith(join(".ssh", "new-key")))).toBe(true);
    expect(secret(resolved.paths).level).toBe("high");
  });

  it("reads ~, .. and repeated slashes as the paths they name", async () => {
    const { context, home, workspace } = await computer();
    for (const given of ["~/.env", `${workspace}/../home/./.env`, `${home}//.ssh//id_rsa`]) {
      const resolved = await Effect.runPromise(resolveGuardPaths([given], context));
      expect(secret(resolved.paths).level, given).toBe("high");
    }
  });

  it("leaves an ordinary file alone", async () => {
    const { context } = await computer();
    const resolved = await Effect.runPromise(resolveGuardPaths(["report.pdf"], context));
    expect(resolved.complete).toBe(true);
    expect(resolved.paths.some(isSecretPath)).toBe(false);
    expect(secret(resolved.paths).level).toBe("clean");
  });

  it("is incomplete, never clean, when a path cannot be resolved for another reason", async () => {
    const { context } = await computer();
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const resolved = await Effect.runPromise(
      resolveGuardPaths(["report.pdf"], { ...context, realpath: () => Promise.reject(denied) }),
    );
    expect(resolved.complete).toBe(false);
    const triage = triageAction({ tool: "openbot_browser.upload_files", files: resolved.paths, unresolved: true });
    expect(triage).toMatchObject({ level: "suspicious", incomplete: true });
  });
});
