import { isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { DeviceBridgeError, pollDeviceAuthorization } from "../../../../server/device-bridge";
import { runApiResponse } from "../../../../server/effect-runtime";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  authErrorResponse,
  json,
  requestAuthService,
  requestDeviceBridgeUrl,
} from "../../../../server/request-auth";
import { requestSourceIp } from "../../../../server/source-ip";

export const Route = createFileRoute("/v1/auth/device/poll")({
  server: {
    handlers: {
      POST: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            const bridgeUrl = requestDeviceBridgeUrl();
            if (!bridgeUrl) return apiError(503, "device_sign_in_disabled", "Device sign-in is not configured.");
            const body = yield* readJsonObject(request);
            const flowId = body.flowId;
            if (!isString(flowId)) {
              return apiError(400, "invalid_device_flow", "The device flow is invalid.");
            }
            // The same limit as the web app's poll, before the bridge asks the Hub.
            yield* requestAuthService().enforceDeviceSignInRateLimit("poll", requestSourceIp(request));
            const result = yield* Effect.tryPromise({
              try: () => pollDeviceAuthorization(bridgeUrl, flowId),
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
            if (result instanceof Response) return result;
            if (result.status === "pending") return json({ interval: result.interval }, 202);
            if (result.status === "denied") return json({ error: "access_denied" }, 403);
            // An earlier poll took the approval, so this code cannot sign in any more.
            if (result.status === "expired" || result.status === "consumed")
              return json({ error: "expired_token" }, 410);
            if (result.status === "rate_limited") {
              const response = apiError(429, "slow_down", "The sign-in service asked to slow down.");
              response.headers.set("Retry-After", String(result.retryAfterSeconds));
              return response;
            }
            return json(
              yield* requestAuthService().signInWithDeviceAccount({
                email: result.user.email,
                name: result.user.name,
                avatarUrl: result.user.avatarUrl,
                surface: "desktop",
              }),
            );
          }),
          (error) => {
            if (error instanceof SyntaxError) return apiError(400, "invalid_json", "The request body is invalid.");
            return authErrorResponse(error);
          },
        ),
    },
  },
});
