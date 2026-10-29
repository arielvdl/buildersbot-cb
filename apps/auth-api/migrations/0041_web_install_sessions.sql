-- One installation of the web app is one client, with its own session: the app on a phone, a second
-- install on a tablet, and a browser tab are different places, and each one is listed and revoked on
-- its own. `client_id` is the random id of the installation and `client_label` what the device is,
-- such as "iPhone". Both are nullable: a session made before this migration has neither.
ALTER TABLE auth_sessions ADD COLUMN client_id TEXT;
ALTER TABLE auth_sessions ADD COLUMN client_label TEXT;
