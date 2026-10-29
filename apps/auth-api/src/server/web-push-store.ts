import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { sha256 } from "./crypto";
import type { WebPushSubscription } from "./web-push";

/**
 * The subscriptions of the web app, one row for each installation that asked for notifications.
 *
 * A subscription is kept against the hash of the account session that made it, never against the
 * session token itself, and the session's revocation trigger deletes it. So an installation that
 * signed out, or that the owner removed, stops receiving anything without a cleanup job.
 */

const ENDPOINT_LIMIT = 1_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

class WebPushStoreError extends Schema.TaggedError<WebPushStoreError>()("WebPushStoreError", {}) {}

/** One subscription as the browser sends it, checked before it reaches the database. */
export function readWebPushSubscription(value: unknown): WebPushSubscription | null {
  if (typeof value !== "object" || value === null) return null;
  if (!isDynamicRecord(value) || !isDynamicRecord(value.keys)) return null;
  const { endpoint } = value;
  const { p256dh, auth } = value.keys;
  if (!isString(endpoint) || !endpoint.startsWith("https://") || endpoint.length > ENDPOINT_LIMIT) return null;
  if (!isString(p256dh) || !KEY_PATTERN.test(p256dh)) return null;
  if (!isString(auth) || !KEY_PATTERN.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

export class WebPushStore {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  /** Stores the subscription of this session, replacing the row of the same endpoint. */
  readonly register = Effect.fn("WebPushStore.register")(function* (
    this: WebPushStore,
    sessionToken: string,
    subscription: WebPushSubscription,
  ) {
    const hash = yield* sha256(sessionToken);
    const now = Date.now();
    yield* Effect.tryPromise({
      try: () =>
        this.#database
          .prepare(
            `INSERT INTO web_push_subscriptions(id, auth_session_hash, endpoint, p256dh, auth, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
                 auth_session_hash = excluded.auth_session_hash,
                 p256dh = excluded.p256dh,
                 auth = excluded.auth,
                 failed_at = NULL`,
          )
          .bind(crypto.randomUUID(), hash, subscription.endpoint, subscription.p256dh, subscription.auth, now)
          .run(),
      catch: () => new WebPushStoreError({}),
    });
  }).bind(this);

  /** Forgets the endpoint of this session. An endpoint of another session stays. */
  readonly remove = Effect.fn("WebPushStore.remove")(function* (
    this: WebPushStore,
    sessionToken: string,
    endpoint: string,
  ) {
    const hash = yield* sha256(sessionToken);
    yield* Effect.tryPromise({
      try: () =>
        this.#database
          .prepare("DELETE FROM web_push_subscriptions WHERE endpoint = ? AND auth_session_hash = ?")
          .bind(endpoint, hash)
          .run(),
      catch: () => new WebPushStoreError({}),
    });
  }).bind(this);

  /**
   * The subscriptions of the account session behind a remote session. The host knows the remote
   * session of the phone; the browser only knows its own cookie, so the hash is the meeting point.
   */
  readonly listForRemoteSession = Effect.fn("WebPushStore.listForRemoteSession")(function* (
    this: WebPushStore,
    remoteSessionId: string,
  ) {
    const rows = yield* Effect.tryPromise({
      try: () =>
        this.#database
          .prepare(
            `SELECT s.id, s.endpoint, s.p256dh, s.auth
               FROM web_push_subscriptions s
               JOIN remote_sessions r ON r.auth_session_hash = s.auth_session_hash
               WHERE r.session_id = ? AND r.ended_at IS NULL`,
          )
          .bind(remoteSessionId)
          .all<{ id: string; endpoint: string; p256dh: string; auth: string }>(),
      catch: () => new WebPushStoreError({}),
    });
    return rows.results;
  }).bind(this);

  /** Drops a subscription that the push service no longer accepts. */
  readonly markGone = Effect.fn("WebPushStore.markGone")(function* (this: WebPushStore, id: string) {
    yield* Effect.tryPromise({
      try: () => this.#database.prepare("DELETE FROM web_push_subscriptions WHERE id = ?").bind(id).run(),
      catch: () => new WebPushStoreError({}),
    });
  }).bind(this);
}
