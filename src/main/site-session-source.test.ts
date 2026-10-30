import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chromeCookieKey, cookieHostKeys, decryptChromeCookie, toSignInCookie } from "./chrome-site-session";
import { createSiteSessionSource, siteSessionKey } from "./site-session-source";

const cookie = {
  name: "sid",
  value: "v",
  domain: ".example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
  expirationDate: null,
};

function grants(initial: string[] = []) {
  const sites = new Set(initial);
  return { has: (site: string) => sites.has(site), add: vi.fn(async (site: string) => void sites.add(site)) };
}

describe("site session consent", () => {
  it("asks once, remembers an always answer for that site, and reads only that host", async () => {
    const confirm = vi.fn(async () => "always" as const);
    const read = vi.fn(async () => [cookie]);
    const source = createSiteSessionSource({ grants: grants(), confirm, read });
    expect(await source("www.example.com")).toEqual({ status: "ok", cookies: [cookie] });
    expect(await source("example.com")).toEqual({ status: "ok", cookies: [cookie] });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenNthCalledWith(1, "www.example.com");
  });

  it("reads nothing when the person says no", async () => {
    const read = vi.fn(async () => [cookie]);
    const source = createSiteSessionSource({ grants: grants(), confirm: async () => "deny", read });
    expect(await source("example.com")).toEqual({ status: "denied" });
    expect(read).not.toHaveBeenCalled();
  });

  it("asks again next time after an allow-once answer", async () => {
    const confirm = vi.fn(async () => "once" as const);
    const g = grants();
    const source = createSiteSessionSource({ grants: g, confirm, read: async () => [cookie] });
    await source("example.com");
    await source("example.com");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(g.add).not.toHaveBeenCalled();
  });

  it("asks one question for two requests that arrive together", async () => {
    const confirm = vi.fn(async () => "always" as const);
    const source = createSiteSessionSource({ grants: grants(), confirm, read: async () => [cookie] });
    await Promise.all([source("example.com"), source("example.com")]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a site that is already granted, and reports a failed read without its detail", async () => {
    const confirm = vi.fn();
    const onError = vi.fn();
    const source = createSiteSessionSource({
      grants: grants(["example.com"]),
      confirm,
      read: async () => {
        throw new Error("keychain denied");
      },
      onError,
    });
    expect(await source("example.com")).toEqual({ status: "unavailable" });
    expect(confirm).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a site with no sign-in as none", async () => {
    const source = createSiteSessionSource({ grants: grants(["example.com"]), confirm: vi.fn(), read: async () => [] });
    expect(await source("example.com")).toEqual({ status: "none" });
  });

  it("keys a site without its www prefix", () => {
    expect(siteSessionKey("WWW.Example.com")).toBe("example.com");
  });
});

describe("chrome cookies", () => {
  const key = chromeCookieKey("secret");
  function seal(plain: Buffer): Buffer {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
  }

  it("decrypts the older format and the one with the host hash in front", () => {
    expect(decryptChromeCookie(seal(Buffer.from("abc")), key, ".example.com")).toBe("abc");
    const hash = createHash("sha256").update(".example.com").digest();
    expect(decryptChromeCookie(seal(Buffer.concat([hash, Buffer.from("abc")])), key, ".example.com")).toBe("abc");
  });

  it("gives nothing for a value in another format or a wrong key", () => {
    expect(decryptChromeCookie(Buffer.from("v11xxxx"), key, "x")).toBeNull();
    expect(decryptChromeCookie(seal(Buffer.from("abc")), chromeCookieKey("other"), "x")).toBeNull();
  });

  it("selects the host and its parent domains, never a bare suffix", () => {
    expect(cookieHostKeys("app.example.com")).toEqual(["app.example.com", ".app.example.com", ".example.com"]);
    expect(cookieHostKeys("example.com")).toEqual(["example.com", ".example.com"]);
  });

  it("drops an expired cookie and converts the others to seconds since 1970", () => {
    const row = {
      host_key: ".example.com",
      name: "n",
      path: "/",
      expires_s: 0,
      is_secure: 1,
      is_httponly: 0,
      samesite: 2,
      last_access_s: 0,
      encrypted_value: new Uint8Array(),
      value: "",
    };
    expect(toSignInCookie(row, "v", 1000)).toMatchObject({ sameSite: "strict", expirationDate: null, secure: true });
    const expired = { ...row, expires_s: 1500 + 11_644_473_600 };
    expect(toSignInCookie(expired, "v", 2000)).toBeNull();
    expect(toSignInCookie(expired, "v", 1000)?.expirationDate).toBeCloseTo(1500, 0);
  });
});
