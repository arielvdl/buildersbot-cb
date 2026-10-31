import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { runApiResponse } from "../../../server/effect-runtime";
import {
  apiError,
  hostedServerErrorResponse,
  requestServerCreationPermission,
  requestUser,
} from "../../../server/request-auth";
import { handleServerCreationApi } from "../../../server/server-creation-api";

/**
 * The permission to create a remote server: the access and the request of each person, and the
 * administrator routes. See docs/architecture/server-creation-permission.md.
 */
function handle({ request }: { request: Request }) {
  return runApiResponse(
    Effect.gen(function* () {
      const user = yield* requestUser(request);
      const path = new URL(request.url).pathname.slice(1);
      const response = yield* handleServerCreationApi(request, path, user, requestServerCreationPermission());
      return response ?? apiError(404, "not_found", "This operation is not available.");
    }),
    hostedServerErrorResponse,
  );
}

export const Route = createFileRoute("/v2/server-creation/$")({
  server: { handlers: { GET: handle, POST: handle, DELETE: handle } },
});
