-- How a session was signed in: 'cultura' for the Cultura Builder sign-in (the Hub device grant), NULL
-- for every other session (an email code, a Mobile Connect code or link, and each session from before
-- this column). The web app accepts only a 'cultura' session, so only a person that the Hub confirmed
-- as a Cultura Builder member opens it. The Worker that runs before this deploy does not read the
-- column, and its inserts get NULL.
ALTER TABLE auth_sessions ADD COLUMN sign_in_method TEXT CHECK(sign_in_method IN ('cultura'));
