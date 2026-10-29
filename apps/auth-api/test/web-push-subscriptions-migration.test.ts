import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase } from "./sqlite-d1";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("web push subscriptions migration", () => {
  it("keeps the subscription of a session and drops it when the session is revoked", () => {
    const database = migratedDatabase();
    databases.push(database);
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
      VALUES ('user-1', 'email:one@example.test', 'one@example.test', 'One', NULL, 1, 1);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, client_id, client_label)
      VALUES ('session-1', 'user-1', 'hash-1', 100, 1, 1, 'install-1', 'iPhone');
      INSERT INTO web_push_subscriptions(id, auth_session_hash, endpoint, p256dh, auth, created_at)
      VALUES ('push-1', 'hash-1', 'https://push.example.test/one', 'key', 'secret', 1);
    `);

    const count = () => database.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions").get();
    expect(Number(count()?.count)).toBe(1);

    database.exec("UPDATE auth_sessions SET revoked_at = 5 WHERE id = 'session-1'");
    expect(Number(count()?.count)).toBe(0);
  });

  it("keeps one row for an endpoint that subscribes again", () => {
    const database = migratedDatabase();
    databases.push(database);
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
      VALUES ('user-1', 'email:one@example.test', 'one@example.test', 'One', NULL, 1, 1);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
      VALUES ('session-1', 'user-1', 'hash-1', 100, 1, 1);
      INSERT INTO web_push_subscriptions(id, auth_session_hash, endpoint, p256dh, auth, created_at)
      VALUES ('push-1', 'hash-1', 'https://push.example.test/one', 'old', 'old', 1)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = 'new', auth = 'new';
      INSERT INTO web_push_subscriptions(id, auth_session_hash, endpoint, p256dh, auth, created_at)
      VALUES ('push-2', 'hash-1', 'https://push.example.test/one', 'new', 'new', 2)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = 'new', auth = 'new';
    `);

    const rows = database.prepare("SELECT id, p256dh FROM web_push_subscriptions").all();
    expect(rows).toEqual([{ id: "push-1", p256dh: "new" }]);
  });
});
