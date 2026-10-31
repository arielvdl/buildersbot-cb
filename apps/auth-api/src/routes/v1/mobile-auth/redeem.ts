import { createFileRoute } from "@tanstack/solid-router";
import { mobileConnectRetiredResponse } from "../../../server/mobile-connect-retired";

// No phone signs in with a Mobile Connect code or a permanent link any more. The route stays, so an
// earlier phone app gets a clear refusal and not a missing page.
export const Route = createFileRoute("/v1/mobile-auth/redeem")({
  server: { handlers: { POST: () => mobileConnectRetiredResponse() } },
});
