-- Provider registry: real service identifier, merchant, rail, asset and
-- recorded capabilities. Rows are seeded by ensureProviders().
CREATE TABLE providers (
  key          TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  merchant     TEXT NOT NULL,
  rail         TEXT NOT NULL,
  asset        TEXT NOT NULL,
  live_enabled INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL,
  note         TEXT
);

-- One attempt per reservation (UNIQUE) so a hold can never produce a second
-- charge; action_id is the broker idempotency key sent to the provider.
CREATE TABLE attempts (
  id                TEXT PRIMARY KEY,
  reservation_id    TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  action_id         TEXT NOT NULL UNIQUE,
  provider_key      TEXT NOT NULL,
  session_ref       TEXT,
  session_cap_minor INTEGER NOT NULL,
  merchant          TEXT NOT NULL,
  rail              TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL,
  provider_ref      TEXT,
  status            TEXT NOT NULL CHECK (status IN
    ('intent','sent','confirmed','failed','uncertain')),
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX attempts_status ON attempts(status);

-- Durable dispatch outbox: written in the same transaction as the dispatch
-- decision, processed by the worker independently of the browser session.
CREATE TABLE dispatch_outbox (
  id         TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  status     TEXT NOT NULL CHECK (status IN ('pending','claimed','done','uncertain')),
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outbox_pending ON dispatch_outbox(status, created_at);

-- Local provider emulator backing store (test double for the provider
-- boundary). Its state survives our own restarts so crash recovery can
-- look up charges by broker action id — like a real provider status call.
CREATE TABLE emulator_charges (
  action_id    TEXT PRIMARY KEY,
  provider_ref TEXT NOT NULL,
  merchant     TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  asset        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
