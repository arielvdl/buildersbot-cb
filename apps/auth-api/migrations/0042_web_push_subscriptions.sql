-- The web app installations that asked for notifications. A row is one browser subscription: the push
-- endpoint the browser gave, and the two keys that encrypt for it. The session is the account session
-- of the installation, by hash as everywhere else, so the subscriptions of a revoked session go with it.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id TEXT PRIMARY KEY,
  auth_session_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failed_at INTEGER
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_session ON web_push_subscriptions(auth_session_hash);

-- The same trigger shape as the remote sessions: revoking the account session ends what it registered.
CREATE TRIGGER IF NOT EXISTS auth_session_revokes_web_push
AFTER UPDATE OF revoked_at ON auth_sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM web_push_subscriptions WHERE auth_session_hash = NEW.token_hash;
END;
