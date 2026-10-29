import { Effect } from "effect";
import { requestWebPush } from "./request-auth";

/**
 * Tells the installed web app of a session that something happened, after the host already reached the
 * phone app of the same session.
 *
 * The push is short on purpose: the browser has no seal for the notification text, so the message says
 * that there is activity and the app reads the detail over WebRTC when it opens. A subscription the
 * push service no longer accepts is dropped here, which is the only cleanup a browser needs.
 *
 * A failure of one push never fails the host request that caused it: the phone app was already served.
 */
export const sendWebPushForSession = Effect.fn("WebPush.sendForSession")(function* (sessionId: string) {
  const push = requestWebPush();
  if (!push) return;
  const subscriptions = yield* push.store.listForRemoteSession(sessionId).pipe(Effect.catch(() => Effect.succeed([])));
  if (subscriptions.length === 0) return;
  const payload = JSON.stringify({ title: "OpenBot", body: "New activity", url: "/app", tag: sessionId });
  yield* Effect.forEach(
    subscriptions,
    (subscription) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => push.sender.send(subscription, payload));
        if (result === "gone") yield* push.store.markGone(subscription.id).pipe(Effect.catch(() => Effect.void));
      }),
    { concurrency: 4 },
  );
});
