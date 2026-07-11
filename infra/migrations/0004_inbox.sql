-- Migration number: 0004 	 mailbox inbox (OTP / magic-link test inboxes)
--
-- The self-hosted disposable-inbox store behind the `mailbox` capability
-- (@flare-dispatch/runtime-cf mailbox-cf.ts) and the inbound `email()` handler
-- (apps/dispatcher/src/routes/email-handler.ts). A test/demo run provisions a
-- short random address; the handler receives the provider's verification mail
-- and routes it back to the paused run.
--
-- `inbox_allocations` maps a minted local-part → the execution that owns it
-- (the address can't encode the semantic execution id — `:` + length exceed the
-- 64-octet local-part cap — so a short random local-part is recorded here and
-- resolved on receipt). `inbox_messages` holds received bodies TEXT-ONLY (a
-- stored magic link is account-takeover material) with a tight TTL and
-- burn-after-read (`consumed_at`): the first successful read consumes the row,
-- so a leaked read token replays to nothing. See .tmp/email-otp-design.md § 10.3.

CREATE TABLE IF NOT EXISTS inbox_allocations (
  local_part   TEXT PRIMARY KEY,   -- demo-<rand>; the address local-part
  execution_id TEXT NOT NULL,      -- the Workflow instance to signal on receipt
  label        TEXT,               -- optional per-run disambiguator
  created_at   INTEGER NOT NULL,   -- ms epoch
  expires_at   INTEGER NOT NULL    -- ms epoch; the handler rejects mail past this
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id          TEXT PRIMARY KEY,    -- crypto.randomUUID()
  local_part  TEXT NOT NULL,       -- → inbox_allocations.local_part
  sender      TEXT,                -- envelope MAIL FROM (trustworthy)
  subject     TEXT,
  text_body   TEXT,                -- plain text only, capped ~16 KB at write
  received_at INTEGER NOT NULL,    -- ms epoch
  expires_at  INTEGER NOT NULL,    -- ms epoch; eligible for purge past this
  consumed_at INTEGER              -- ms epoch of first read; NULL = unread (burn-after-read)
);
CREATE INDEX IF NOT EXISTS inbox_messages_local_part ON inbox_messages(local_part, received_at);
