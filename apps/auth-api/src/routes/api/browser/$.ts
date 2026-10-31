import { createFileRoute } from "@tanstack/solid-router";
import { handleBrowserApi } from "../../../server/browser-api";
import { createDeviceSignInBridge } from "../../../server/device-bridge";
import { readHostLogo } from "../../../server/host-logo";
import {
  hostedServerErrorResponse,
  requestAccountAttribution,
  requestAuthService,
  requestAvatarBucket,
  requestBillingService,
  requestDeviceBridgeUrl,
  requestHostedServerService,
  requestHostedSiteService,
  requestRemoteControlPlane,
  requestServerCreationPermission,
  requestTeamInviteEmailDelivery,
  requestWebPush,
} from "../../../server/request-auth";
import { requestSourceIp } from "../../../server/source-ip";

function handle({ request }: { request: Request }) {
  return handleBrowserApi(request, {
    auth: requestAuthService(request),
    remote: requestRemoteControlPlane(),
    hostLogo: (hostId, version) => readHostLogo(requestAvatarBucket(), hostId, version),
    hosting: requestHostedServerService,
    inviteEmailDelivery: requestTeamInviteEmailDelivery,
    attribution: requestAccountAttribution,
    billing: requestBillingService,
    avatarBucket: requestAvatarBucket,
    hostedSites: requestHostedSiteService,
    webPush: requestWebPush,
    deviceBridge: () => {
      const bridgeUrl = requestDeviceBridgeUrl();
      return bridgeUrl ? createDeviceSignInBridge(bridgeUrl) : null;
    },
    serverCreation: requestServerCreationPermission,
    sourceIp: requestSourceIp,
    errorResponse: hostedServerErrorResponse,
  });
}

export const Route = createFileRoute("/api/browser/$")({ server: { handlers: { ANY: handle } } });
