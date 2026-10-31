import { sourceText } from "@openbot/i18n/source";
import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { DeviceBridgeError, startDeviceAuthorization } from "../../../../server/device-bridge";
import { runApiResponse } from "../../../../server/effect-runtime";
import {
  apiError,
  authErrorResponse,
  json,
  requestAuthService,
  requestDeviceBridgeUrl,
} from "../../../../server/request-auth";
import { requestSourceIp } from "../../../../server/source-ip";

export const Route = createFileRoute("/v1/auth/device/start")({
  server: {
    handlers: {
      POST: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            const bridgeUrl = requestDeviceBridgeUrl();
            if (!bridgeUrl) return apiError(503, "device_sign_in_disabled", "Device sign-in is not configured.");
            // The same limit as the web app's start, before the bridge asks the Hub for a code.
            yield* requestAuthService().enforceDeviceSignInRateLimit("start", requestSourceIp(request));
            return yield* Effect.tryPromise({
              try: async () => json(await startDeviceAuthorization(bridgeUrl)),
              catch: (error) => error,
            }).pipe(
              Effect.catchIf(
                (error) => error instanceof DeviceBridgeError,
                (error) =>
                  Effect.sync(() => {
                    // The detail is for the Worker log. The app gets a text that it can translate.
                    console.warn(`device sign-in: ${error.message}`);
                    return apiError(
                      502,
                      "sign_in_service_unavailable",
                      sourceText("error.auth.signInServiceUnavailable"),
                    );
                  }),
              ),
            );
          }),
          authErrorResponse,
        ),
    },
  },
});
