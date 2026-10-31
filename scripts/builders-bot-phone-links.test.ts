// The links that Builders Bot makes for a person to open on a phone are on the Builders Bot site and
// open the web app there. This test fails when one of them is an `openbot://` link or an upstream
// `openbot.run` page again: a server invitation and its QR code, an agent share link, a desktop
// download, and the pages that the web app opens.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentTemplateShareOrigin,
  createAgentTemplateShareUrl,
  parseAgentTemplateUrl,
} from "@openbot/contracts/agent-template-links";
import {
  BUILDERSBOT_CONTROL_PLANE_FALLBACK_ORIGIN,
  BUILDERSBOT_CONTROL_PLANE_ORIGIN,
  createInviteUrl,
  createWebAppInvitePath,
  type InviteLinkPayload,
  inviteUrlFromWebAppSearch,
  isCanonicalInviteUrl,
  parseInviteUrl,
  selfHostedApiOrigin,
} from "@openbot/contracts/invite-links";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { latestDownloadResponse } from "../apps/auth-api/src/server/latest-download";
import { decodeAgentTemplatePublication } from "../src/preload/skills-decoding";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SITE = BUILDERSBOT_CONTROL_PLANE_ORIGIN;
const TEMPLATE_ID = "AbCdEfGhIjKlMnOpQrStUv";

const INVITE: InviteLinkPayload = {
  apiUrl: `${SITE}/`,
  serverId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  fingerprint: "f".repeat(43),
  token: "t".repeat(43),
};

describe("Builders Bot phone links", () => {
  it("makes a server invitation an https link on the Builders Bot site, which the web app reads", () => {
    // The desktop and the web app pass the origin that `selfHostedApiOrigin` gives for their service.
    expect(selfHostedApiOrigin(SITE)).toBeUndefined();
    const link = createInviteUrl(INVITE, { selfHostedApiOrigin: selfHostedApiOrigin(SITE) });
    const url = new URL(link);
    expect(url.protocol).toBe("https:");
    expect(`${url.origin}${url.pathname}`).toBe(`${SITE}/join`);
    expect(link).not.toMatch(/openbot/iu);
    expect(parseInviteUrl(link)).toEqual(INVITE);
    // The email of an invitation accepts the link.
    expect(isCanonicalInviteUrl(link)).toBe(true);
    // The `/join` page opens the web app with it, and the web app reads it back.
    const webAppPath = createWebAppInvitePath(link);
    expect(webAppPath.startsWith("/app?")).toBe(true);
    expect(inviteUrlFromWebAppSearch(new URL(webAppPath, SITE).search)).toBe(link);
  });

  it("still reads an invitation link of the upstream site", () => {
    const upstream = new URL("https://openbot.run/join");
    for (const [field, value] of Object.entries({
      api: INVITE.apiUrl,
      server: INVITE.serverId,
      fingerprint: INVITE.fingerprint,
      invite: INVITE.token,
    }))
      upstream.searchParams.set(field, value);
    expect(parseInviteUrl(upstream.toString())).toEqual(INVITE);
  });

  it("puts an agent share link on the Builders Bot site that stores the agent", () => {
    for (const apiOrigin of [SITE, BUILDERSBOT_CONTROL_PLANE_FALLBACK_ORIGIN])
      expect(agentTemplateShareOrigin(apiOrigin)).toBe(SITE);
    const link = createAgentTemplateShareUrl(TEMPLATE_ID, agentTemplateShareOrigin(SITE));
    expect(link).toBe(`${SITE}/agents/${TEMPLATE_ID}`);
    expect(parseAgentTemplateUrl(link)).toBe(TEMPLATE_ID);
    // The preload rebuilds the link that main gives, and refuses a site that is not in the list.
    expect(
      decodeAgentTemplatePublication({ templateId: TEMPLATE_ID, shareUrl: link, publishedAt: "2026-10-31" }).shareUrl,
    ).toBe(link);
    expect(() =>
      decodeAgentTemplatePublication({
        templateId: TEMPLATE_ID,
        shareUrl: `https://culturabuilder.com.example/agents/${TEMPLATE_ID}`,
        publishedAt: "2026-10-31",
      }),
    ).toThrow();
  });

  it("sends no desktop download to the upstream releases", async () => {
    let fetched = false;
    const fetcher = Object.assign(
      () => {
        fetched = true;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      { preconnect: () => undefined },
    );
    for (const platform of ["macos", "windows", "linux"] as const) {
      const response = await Effect.runPromise(latestDownloadResponse(platform, fetcher));
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toMatch(/openbot|github/iu);
    }
    expect(fetched).toBe(false);
  });

  it("opens no upstream page and sends no feedback to the upstream author from the web app", () => {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "src/renderer/src/features/web-client/web-provider-admin.ts"),
      "utf8",
    );
    const table = /const WEB_EXTERNAL_DESTINATIONS[^=]*=\s*\{(?<entries>[^}]*)\}/u.exec(source)?.groups?.entries;
    expect(table).toBeDefined();
    expect(table).not.toMatch(/openbot\.run|norbertbodziony/iu);
  });
});
