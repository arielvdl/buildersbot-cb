import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// The permission to create a remote server adds three tables. Every account, session, hosted server and
// remote host stays as it was, and the Worker that runs before the deploy does not read the new tables.

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

const migration = readFileSync(new URL("../migrations/0046_server_creation_permission.sql", import.meta.url), "utf8");

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
      VALUES ('admin', 'admin', 'admin@example.com', 'Admin', NULL, 1, 1),
             ('person', 'person', 'person@example.com', NULL, NULL, 2, 2);
    INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, sign_in_method)
      VALUES ('session-1', 'person', 'hash-1', 9, 1, 2, 'cultura');
    INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state,
      observed_state, idempotency_key, legacy_member_limits, created_at, updated_at)
      VALUES ('server-1', 'person', 'Server', 'default', 'standard', 'month', 'usd', 'running', 'running',
        'request-0000000001', 0, 1, 1);
  `);
}

const snapshot = (database: DatabaseSync) => ({
  users: database.prepare("SELECT * FROM users ORDER BY id").all(),
  sessions: database.prepare("SELECT * FROM auth_sessions ORDER BY id").all(),
  servers: database.prepare("SELECT * FROM hosted_servers ORDER BY server_id").all(),
});

describe("server creation permission migration", () => {
  it("keeps every account, session and hosted server, and starts with no grant and no request", () => {
    const database = migratedTo("0046");
    seed(database);
    const before = snapshot(database);
    database.exec(migration);
    expect(snapshot(database)).toEqual(before);
    for (const table of ["server_creation_grants", "server_creation_requests", "server_creation_audit"])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("can run again with no change: a second run, or a run after a partial apply", () => {
    const database = migratedTo("0046");
    seed(database);
    database.exec(migration);
    database.exec(`
      INSERT INTO server_creation_grants(user_id, granted_by, granted_at, note) VALUES ('person', 'admin', 5, 'Sales');
      INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-1', 'person', 'For the sales team', 'pending', 3);
      INSERT INTO server_creation_audit(id, actor_user_id, action, target_user_id, created_at)
        VALUES ('audit-1', 'admin', 'grant', 'person', 5);
    `);
    const schema = () =>
      database
        .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name LIKE 'server_creation%' ORDER BY name")
        .all();
    const rows = () => ({
      ...snapshot(database),
      grants: database.prepare("SELECT * FROM server_creation_grants").all(),
      requests: database.prepare("SELECT * FROM server_creation_requests").all(),
      audit: database.prepare("SELECT * FROM server_creation_audit").all(),
    });
    const before = { schema: schema(), rows: rows() };
    expect(before.schema).toHaveLength(7);
    database.exec(migration);
    expect({ schema: schema(), rows: rows() }).toEqual(before);

    // A partial apply: the first table exists and the others do not.
    const partial = migratedTo("0046");
    partial.exec(migration.slice(0, migration.indexOf("CREATE TABLE IF NOT EXISTS server_creation_requests")));
    partial.exec(migration);
    expect(
      partial.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'server_creation%' ORDER BY name").all(),
    ).toEqual(before.schema.map(({ name }) => ({ name })));
  });

  it("allows one pending request for each person, and only the known statuses and actions", () => {
    const database = migratedTo("0046");
    seed(database);
    database.exec(migration);
    database.exec(`
      INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-1', 'person', 'For the sales team', 'pending', 3),
               ('request-0', 'person', 'Earlier', 'denied', 1);
    `);
    expect(() =>
      database.exec(`INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-2', 'person', 'Again', 'pending', 4)`),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      database.exec(`INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-3', 'person', 'Odd', 'cancelled', 4)`),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      database.exec(`INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-4', 'person', '', 'denied', 4)`),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      database.exec(`INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
        VALUES ('request-5', 'nobody', 'Unknown account', 'denied', 4)`),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database.exec(`INSERT INTO server_creation_audit(id, actor_user_id, action, created_at)
        VALUES ('audit-1', 'admin', 'delete', 4)`),
    ).toThrow(/CHECK constraint failed/);
  });

  it("keeps one grant row for each person, which a new grant renews", () => {
    const database = migratedTo("0046");
    seed(database);
    database.exec(migration);
    database.exec(`
      INSERT INTO server_creation_grants(user_id, granted_by, granted_at, note) VALUES ('person', 'admin', 5, 'Sales');
      UPDATE server_creation_grants SET revoked_at = 6, revoked_by = 'admin' WHERE user_id = 'person';
      INSERT INTO server_creation_grants(user_id, granted_by, granted_at, note) VALUES ('person', 'admin', 7, NULL)
        ON CONFLICT(user_id) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL, revoked_by = NULL,
          note = excluded.note;
    `);
    expect(database.prepare("SELECT * FROM server_creation_grants").all()).toEqual([
      { user_id: "person", granted_by: "admin", granted_at: 7, revoked_at: null, revoked_by: null, note: null },
    ]);
    expect(() =>
      database.exec(`INSERT INTO server_creation_grants(user_id, granted_by, granted_at, note)
        VALUES ('admin', 'admin', 8, '${"x".repeat(201)}')`),
    ).toThrow(/CHECK constraint failed/);
  });
});
