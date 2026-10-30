// @vitest-environment node
// The guard that the Playwright process loads: it must refuse every HTTP request without the token.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardNodeOptions, installGuard } from "./playwright-broker-guard";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SERVER = `
const http = require("node:http");
const server = http.createServer((req, res) => { res.writeHead(200); res.end("served " + req.url); });
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;

async function serverWith(env: Record<string, string>): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "broker-guard-"));
  roots.push(root);
  const guard = installGuard(root);
  const child = spawn(process.execPath, ["-e", SERVER], {
    env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: guardNodeOptions(guard, process.env.NODE_OPTIONS), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10_000);
    child.stdout?.on("data", (data: Buffer) => {
      const match = /PORT (\d+)/u.exec(data.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
}

const get = async (port: number, headers: Record<string, string> = {}, path = "/mcp") => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: response.status, text: await response.text() };
};

describe("the guard of the Playwright process", () => {
  it("refuses a request with no token, and one with a wrong token", async () => {
    const port = await serverWith({ BB_BROKER_TOKEN: "right-token-value" });
    expect((await get(port)).status).toBe(401);
    expect((await get(port, { "x-bb-broker": "wrong-token-value" })).status).toBe(401);
    expect((await get(port, { "x-bb-broker": "right" })).status).toBe(401);
  });

  it("serves a request that carries the token, on any path", async () => {
    const port = await serverWith({ BB_BROKER_TOKEN: "right-token-value" });
    expect(await get(port, { "x-bb-broker": "right-token-value" })).toEqual({ status: 200, text: "served /mcp" });
    expect((await get(port, { "x-bb-broker": "right-token-value" }, "/other")).status).toBe(200);
  });

  it("refuses every request when the process was given no token, so a lost variable fails closed", async () => {
    const port = await serverWith({});
    expect((await get(port)).status).toBe(401);
    expect((await get(port, { "x-bb-broker": "" })).status).toBe(401);
  });

  it("does not say what the token is, or that one exists, in the refusal", async () => {
    const port = await serverWith({ BB_BROKER_TOKEN: "right-token-value" });
    const refused = await get(port);
    expect(refused.text).not.toContain("right-token-value");
    expect(refused.text.length).toBeLessThan(40);
  });
});

describe("installing the guard", () => {
  it("writes the file for its owner only, and again without a partial file", () => {
    const root = mkdtempSync(join(tmpdir(), "broker-guard-"));
    roots.push(root);
    const path = installGuard(root);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const first = readFileSync(path, "utf8");
    expect(installGuard(root)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("adds to the NODE_OPTIONS the person already has, and quotes a path with spaces", () => {
    expect(guardNodeOptions("/a b/guard.cjs", "--max-old-space-size=512")).toBe(
      '--max-old-space-size=512 --require "/a b/guard.cjs"',
    );
    expect(guardNodeOptions("/x/guard.cjs", undefined)).toBe('--require "/x/guard.cjs"');
  });

  it("escapes a quote or a backslash in the path", () => {
    expect(guardNodeOptions('/a"b\\c/guard.cjs', undefined)).toBe('--require "/a\\"b\\\\c/guard.cjs"');
  });
});
