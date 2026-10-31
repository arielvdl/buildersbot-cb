import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// The web app accepts only a session that the Cultura Builder sign-in opened. The migration marks how a
// session was signed in, keeps every session that exists, and accepts the insert of the Worker that
// runs before the deploy.

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function migratedTo(lastExclusive: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql") && name < lastExclusive)
    .sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  return database;
}

const migration = readFileSync(new URL("../migrations/0045_session_sign_in_method.sql", import.meta.url), "utf8");

describe("session sign-in method migration", () => {
  it("keeps every session and marks none of them as a Cultura Builder session", () => {
    const database = migratedTo("0045");
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
        VALUES ('user-1', 'user-1', 'person@example.com', NULL, NULL, 1, 1);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, client_id, client_label)
        VALUES ('web', 'user-1', 'hash-web', 9, 1, 2, 'install-1', 'iPhone Safari'),
               ('desktop', 'user-1', 'hash-desktop', 9, 3, 4, NULL, NULL);
    `);
    database.exec(migration);
    expect(
      database
        .prepare(
          "SELECT id, token_hash, expires_at, created_at, last_used_at, client_id, client_label, revoked_at, sign_in_method FROM auth_sessions ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "desktop",
        token_hash: "hash-desktop",
        expires_at: 9,
        created_at: 3,
        last_used_at: 4,
        client_id: null,
        client_label: null,
        revoked_at: null,
        sign_in_method: null,
      },
      {
        id: "web",
        token_hash: "hash-web",
        expires_at: 9,
        created_at: 1,
        last_used_at: 2,
        client_id: "install-1",
        client_label: "iPhone Safari",
        revoked_at: null,
        sign_in_method: null,
      },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("accepts the insert of the Worker that runs before the deploy, and only the known method", () => {
    const database = migratedTo("0045");
    database.exec(migration);
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
        VALUES ('user-1', 'user-1', 'person@example.com', NULL, NULL, 1, 1);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, client_id, client_label)
        VALUES ('old-worker', 'user-1', 'hash-old', 9, 1, 1, NULL, NULL);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, client_id, client_label, sign_in_method)
        VALUES ('cultura', 'user-1', 'hash-cultura', 9, 1, 1, 'install-1', 'iPhone Safari', 'cultura');
    `);
    expect(database.prepare("SELECT id, sign_in_method FROM auth_sessions ORDER BY id").all()).toEqual([
      { id: "cultura", sign_in_method: "cultura" },
      { id: "old-worker", sign_in_method: null },
    ]);
    expect(() =>
      database.exec(`INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, sign_in_method)
        VALUES ('other', 'user-1', 'hash-other', 9, 1, 1, 'email')`),
    ).toThrow(/CHECK constraint failed/);
  });
});
