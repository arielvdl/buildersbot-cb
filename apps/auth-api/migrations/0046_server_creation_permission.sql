-- Only a person with explicit permission can create a new remote server (see
-- docs/architecture/server-creation-permission.md). An administrator gives the permission directly,
-- or approves the request of a person. This migration only adds tables: the Worker that runs before
-- the deploy does not read them, and no row of another table changes. Each statement can run again
-- (IF NOT EXISTS), so a second run or a run after a partial apply changes nothing.

-- One row for each person. A new grant clears `revoked_at`, so the row shows the last state.
CREATE TABLE IF NOT EXISTS server_creation_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  note TEXT CHECK(note IS NULL OR length(note) <= 200)
);

CREATE TABLE IF NOT EXISTS server_creation_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);

-- One pending request for each person.
CREATE UNIQUE INDEX IF NOT EXISTS server_creation_requests_one_pending
  ON server_creation_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS server_creation_requests_user ON server_creation_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS server_creation_requests_status ON server_creation_requests(status, created_at);

-- Each request, grant, revoke and decision. The rows stay when a grant changes.
CREATE TABLE IF NOT EXISTS server_creation_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('request', 'grant', 'revoke', 'approve', 'deny')),
  target_user_id TEXT,
  request_id TEXT,
  note TEXT CHECK(note IS NULL OR length(note) <= 500),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS server_creation_audit_created ON server_creation_audit(created_at);
