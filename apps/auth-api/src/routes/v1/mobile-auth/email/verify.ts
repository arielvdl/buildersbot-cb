import { createFileRoute } from "@tanstack/solid-router";
import { emailSignInRetiredResponse } from "../../../../server/mobile-connect-retired";

// The earlier phone app signed in here with an email code, which never asked the Hub whether the
// person is a Cultura Builder member. A phone now signs in to the web app with Cultura Builder.
export const Route = createFileRoute("/v1/mobile-auth/email/verify")({
  server: {
    handlers: {
      POST: () => emailSignInRetiredResponse(),
    },
  },
});
