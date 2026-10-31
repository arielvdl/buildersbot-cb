import { createFileRoute } from "@tanstack/solid-router";
import { DeviceBridgeError, startDeviceAuthorization } from "../../../../server/device-bridge";
import { apiError, json, requestDeviceBridgeUrl } from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/auth/device/start")({
  server: {
    handlers: {
      POST: async () => {
        const bridgeUrl = requestDeviceBridgeUrl();
        if (!bridgeUrl) return apiError(503, "device_sign_in_disabled", "Device sign-in is not configured.");
        try {
          return json(await startDeviceAuthorization(bridgeUrl));
        } catch (error) {
          if (error instanceof DeviceBridgeError) return apiError(502, "sign_in_service_unavailable", error.message);
          throw error;
        }
      },
    },
  },
});
