// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokerIdentityFile,
  brokerEnvironment,
  extensionTokenEnvironment,
  findProgram,
  maskSecrets,
} from "./playwright-broker-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "broker-runtime-"));
  roots.push(root);
  return root;
};

describe("finding a program", () => {
  it("finds an executable file in a directory of the path", () => {
    const bin = join(temp(), "bin");
    mkdirSync(bin);
    const program = join(bin, "playwright-mcp");
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o755);
    expect(findProgram("playwright-mcp", [bin])).toBe(program);
  });

  it("skips a file that is not executable, and a missing one", () => {
    const bin = temp();
    writeFileSync(join(bin, "playwright-mcp"), "x");
    chmodSync(join(bin, "playwright-mcp"), 0o644);
    expect(findProgram("playwright-mcp", [bin, join(bin, "nowhere")])).toBeNull();
  });

  it("takes the first directory that has it", () => {
    const first = temp();
    const second = temp();
    for (const dir of [first, second]) {
      writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
      chmodSync(join(dir, "tool"), 0o755);
    }
    expect(findProgram("tool", [first, second])).toBe(join(first, "tool"));
  });

  it("refuses a name with a path in it, so it cannot reach out of the directory", () => {
    const bin = temp();
    expect(findProgram("../etc/passwd", [bin])).toBeNull();
    expect(findProgram("a/b", [bin])).toBeNull();
  });
});

describe("the environment of the Playwright process", () => {
  it("copies only the named variables of the app, then adds the row's own", () => {
    const env = brokerEnvironment(
      { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "secret", PLAYWRIGHT_MCP_EXTENSION_TOKEN: "t" },
      { env: { EXTRA: "1" }, passthrough: ["PATH", "HOME", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "MISSING"] },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", PLAYWRIGHT_MCP_EXTENSION_TOKEN: "t", EXTRA: "1" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("lets the row's own value win over the app's", () => {
    expect(brokerEnvironment({ PATH: "/a" }, { env: { PATH: "/b" }, passthrough: ["PATH"] }).PATH).toBe("/b");
  });
});

describe("the saved identity of the broker", () => {
  it("is empty before anything is saved", () => {
    expect(new BrokerIdentityFile(join(temp(), "broker.json")).read()).toBeNull();
  });

  it("keeps the port and the secret across instances, in a file only the owner reads", () => {
    const file = join(temp(), "broker.json");
    new BrokerIdentityFile(file).write({ port: 4321, secret: "s3cret-value-long-enough" });
    expect(new BrokerIdentityFile(file).read()).toEqual({ port: 4321, secret: "s3cret-value-long-enough" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads a damaged file, or one of another shape, as empty", () => {
    const file = join(temp(), "broker.json");
    writeFileSync(file, "{ nope");
    expect(new BrokerIdentityFile(file).read()).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, port: "x", secret: 5 }));
    expect(new BrokerIdentityFile(file).read()).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, port: 70000, secret: "long-enough-secret-value" }));
    expect(new BrokerIdentityFile(file).read()).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, port: 4000, secret: "short" }));
    expect(new BrokerIdentityFile(file).read()).toBeNull();
  });

  it("does not leave a partial file when it writes", () => {
    const dir = temp();
    const file = join(dir, "broker.json");
    new BrokerIdentityFile(file).write({ port: 4000, secret: "long-enough-secret-value" });
    new BrokerIdentityFile(file).write({ port: 4001, secret: "long-enough-secret-value" });
    expect(new BrokerIdentityFile(file).read()?.port).toBe(4001);
  });
});

describe("the token of the Playwright extension", () => {
  const write = (config: object): string => {
    const file = join(temp(), "opencode.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const config = (token: unknown) => ({
    mcp: { playwright: { environment: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } } },
  });
  const TOKEN = "AbCdEf0123456789_-xyzABCDEF0123456789";

  it("keeps the one the app already has, and does not read the file", () => {
    expect(extensionTokenEnvironment({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: "from-app-0123456789" }, "/nowhere")).toEqual(
      {},
    );
  });

  it("reads it from the OpenCode configuration when the app has none", () => {
    expect(extensionTokenEnvironment({}, write(config(TOKEN)))).toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN });
  });

  it("gives nothing for a missing file, damaged JSON, another shape, or a token that is not one", () => {
    expect(extensionTokenEnvironment({}, join(temp(), "missing.json"))).toEqual({});
    const damaged = join(temp(), "damaged.json");
    writeFileSync(damaged, "{ nope");
    expect(extensionTokenEnvironment({}, damaged)).toEqual({});
    expect(extensionTokenEnvironment({}, write({ mcp: {} }))).toEqual({});
    expect(extensionTokenEnvironment({}, write(config(42)))).toEqual({});
    expect(extensionTokenEnvironment({}, write(config("")))).toEqual({});
    expect(extensionTokenEnvironment({}, write(config("has spaces and\nnewline")))).toEqual({});
    expect(extensionTokenEnvironment({}, write(config("x".repeat(500))))).toEqual({});
  });
});

describe("masking secrets in a message", () => {
  it("hides the token of a connect URL", () => {
    const text = "Open http://127.0.0.1:5000/connect?client=a&token=SeCrEt_0123-abc&x=1 now";
    expect(maskSecrets(text)).toBe("Open http://127.0.0.1:5000/connect?client=a&token=***&x=1 now");
  });

  it("hides the value of the token variable wherever it appears", () => {
    expect(maskSecrets("PLAYWRIGHT_MCP_EXTENSION_TOKEN=abcDEF123456 failed", ["abcDEF123456"])).toBe(
      "PLAYWRIGHT_MCP_EXTENSION_TOKEN=*** failed",
    );
    expect(maskSecrets("the value abcDEF123456 appeared", ["abcDEF123456"])).toBe("the value *** appeared");
  });

  it("leaves a message with no secret as it is", () => {
    expect(maskSecrets("The Playwright server stopped.")).toBe("The Playwright server stopped.");
  });
});
