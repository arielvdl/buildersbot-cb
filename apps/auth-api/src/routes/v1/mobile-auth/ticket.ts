import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { runApiResponse } from "../../../server/effect-runtime";
import { mobileConnectRetiredResponse } from "../../../server/mobile-connect-retired";
import {
  apiError,
  bearerToken,
  remoteControlPlaneErrorResponse,
  requestAuthService,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/mobile-auth/ticket")({
  server: {
    handlers: {
      // A desktop makes no new one-time code. Cancel stays, for a code that a desktop still shows.
      POST: () => mobileConnectRetiredResponse(),
      DELETE: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            const token = bearerToken(request);
            if (!token) return apiError(401, "unauthorized", "Sign in is required.");
            const hostId = new URL(request.url).searchParams.get("host") ?? "";
            yield* requestAuthService().cancelMobileAuthTickets(token, hostId);
            return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
          }),
          remoteControlPlaneErrorResponse,
        ),
    },
  },
});
